'use strict';

/**
 * 记忆备份：把 data 下的数据文件 + SQLite 快照复制到指定目录（U 盘/移动盘/任意路径）。
 * - JSON 文件直接复制（原子写 tmp→rename）
 * - bot.db 用 VACUUM INTO 做一致性快照（WAL 里有未合并数据，直接复制不可靠）
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FILES = ['store.json', 'memories.json', 'preferences.json', 'selfnotes.json', 'tombstones.json', 'usage.json'];
const DB_NAME = 'bot.db';
const KEEP_SNAPSHOTS = 10;

/** 列出可用盘符（找 U 盘盘符用） */
function listDrives() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}} | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const arr = JSON.parse(out || '[]');
    return (Array.isArray(arr) ? arr : [arr]).map((d) => ({
      letter: d.DeviceID,
      name: d.VolumeName || '',
      type: Number(d.DriveType) === 2 ? '可移动' : Number(d.DriveType) === 3 ? '本地磁盘' : '其它',
      freeGB: d.FreeGB,
    }));
  } catch {
    return [];
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyOne(src, destDir, name) {
  if (!fs.existsSync(src)) return null;
  ensureDir(destDir);
  const dest = path.join(destDir, name);
  const tmp = dest + '.tmp';
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
  return { name, bytes: fs.statSync(dest).size };
}

/** SQLite 一致性快照：VACUUM INTO，失败则退化为拷贝 db+wal */
function snapshotDb(srcDb, destDir, name = DB_NAME) {
  if (!fs.existsSync(srcDb)) return null;
  ensureDir(destDir);
  const dest = path.join(destDir, name);
  const tmp = dest + '.tmp';
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(srcDb);
    const escaped = tmp.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    db.close();
    fs.renameSync(tmp, dest);
    return { name, bytes: fs.statSync(dest).size };
  } catch (err) {
    // 退化路径：拷 db + wal（可能少最后几条，但比没有好）
    try {
      copyOne(srcDb, destDir, name);
      copyOne(srcDb + '-wal', destDir, name + '-wal');
      return { name, bytes: fs.statSync(dest).size, degraded: true };
    } catch {
      return null;
    }
  }
}

function pruneSnapshots(dir, keep) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    while (entries.length > keep) {
      const old = entries.shift();
      fs.rmSync(path.join(dir, old), { recursive: true, force: true });
    }
  } catch { /* 清理失败不影响备份 */ }
}

/**
 * 立刻备份一次。
 * @returns {{ok:boolean, dir:string, files:Array, error?:string}}
 */
function backupNow(targetDir, { logger, dataDir } = {}) {
  const dir = String(targetDir || '').trim();
  if (!dir) return { ok: false, dir: '', files: [], error: '没有配置备份目录' };
  const srcDir = String(dataDir || path.join(ROOT, 'data'));
  try {
    if (!fs.existsSync(dir)) throw new Error('目录不存在（U 盘没插？）');
    const latest = path.join(dir, 'latest');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snap = path.join(dir, 'snapshots', stamp);
    const files = [];
    for (const name of FILES) {
      const src = path.join(srcDir, name);
      const a = copyOne(src, latest, name);
      if (a) files.push(a);
      copyOne(src, snap, name);
    }
    const dbSnap = snapshotDb(path.join(srcDir, DB_NAME), latest, DB_NAME);
    if (dbSnap) files.push(dbSnap);
    snapshotDb(path.join(srcDir, DB_NAME), snap, DB_NAME);
    pruneSnapshots(path.join(dir, 'snapshots'), KEEP_SNAPSHOTS);
    logger && logger.info && logger.info(`[备份] 已复制 ${files.length} 个文件到 ${latest}`);
    return { ok: true, dir: latest, files };
  } catch (err) {
    logger && logger.warn && logger.warn('[备份] 失败：' + (err && err.message));
    return { ok: false, dir, files: [], error: (err && err.message) || '未知错误' };
  }
}

let timer = null;

/** 定时备份（分钟） */
function startAuto(getConfig, logger) {
  if (timer) return;
  timer = setInterval(() => {
    const cfg = getConfig();
    const usb = cfg && cfg.memory && cfg.memory.usb;
    if (!usb || !usb.dir) return;
    const minutes = Number(usb.autoMinutes) || 10;
    if (minutes <= 0) return;
    const dataDir = (cfg.paths && cfg.paths.dataDir) || path.join(ROOT, 'data');
    backupNow(usb.dir, { logger, dataDir });
  }, 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { listDrives, backupNow, startAuto, snapshotDb };
