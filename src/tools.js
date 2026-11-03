'use strict';

/**
 * 本地操作工具（受限）
 *
 * 设计原则：宁可少做，不可乱做。
 * - 只在沙箱目录里读写（路径规范化后必须仍以沙箱为前缀）
 * - 下载只允许 http/https，拒绝内网地址
 * - 只允许跑沙箱里的 .ps1/.bat/.cmd，且超时 60 秒
 * - 每次调用都写审计日志
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

const SANDBOX = 'D:\\dsh-workspace\\chat\\sandbox';
const AUDIT = 'D:\\dsh-workspace\\chat\\whale_gril\\data\\tools.log';

function ensureSandbox() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  return SANDBOX;
}

function audit(entry) {
  try {
    fs.appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 审计写不进去不影响执行 */ }
}

/** 把用户给的相对路径解析到沙箱内；越界直接抛错 */
function resolveSandbox(p) {
  const base = ensureSandbox();
  const target = path.resolve(base, String(p || '.'));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出沙箱');
  }
  return target;
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (['localhost', '0.0.0.0', '::1'].includes(h)) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

/** 下载到沙箱，返回落盘路径 */
function download(url, { timeoutMs = 120000, maxBytes = 200 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('链接不合法')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('只支持 http/https'));
    if (isPrivateHost(u.hostname)) return reject(new Error('不允许内网地址'));

    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers: { 'user-agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, u).toString(), { timeoutMs, maxBytes })
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const name = decodeURIComponent(path.basename(u.pathname)) || 'download.bin';
      const safeName = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'download.bin';
      const dest = resolveSandbox(Date.now() + '_' + safeName);
      const out = fs.createWriteStream(dest);
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          out.close();
          try { fs.unlinkSync(dest); } catch { /* ignore */ }
          reject(new Error('文件太大'));
        }
      });
      res.pipe(out);
      out.on('finish', () => resolve({ path: dest, size }));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
  });
}

function listDir(sub) {
  const dir = resolveSandbox(sub);
  if (!fs.existsSync(dir)) throw new Error('目录不存在');
  return fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
    const full = path.join(dir, d.name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* ignore */ }
    return { name: d.name, dir: d.isDirectory(), size };
  });
}

/** 只允许跑沙箱里的脚本文件 */
function runScript(name, { timeoutMs = 60000 } = {}) {
  const file = resolveSandbox(name);
  if (!fs.existsSync(file)) throw new Error('脚本不存在');
  if (!/\.(ps1|bat|cmd)$/i.test(file)) throw new Error('只允许 .ps1 / .bat / .cmd');
  return new Promise((resolve) => {
    // PowerShell 5.1 默认按 GBK 读脚本，UTF-8 的中文会变乱码；
    // 显式把控制台和输出编码设成 UTF-8 再执行。
    const quoted = file.replace(/'/g, "''");
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; & '${quoted}'`,
    ], {
      cwd: SANDBOX,
      windowsHide: true,
    });
    let out = '';
    const cap = (b) => {
      if (out.length < 4000) out += b.toString('utf8');
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.slice(0, 2000) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(err && err.message) });
    });
  });
}

module.exports = { SANDBOX, ensureSandbox, resolveSandbox, download, listDir, runScript, audit };
