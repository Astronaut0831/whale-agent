'use strict';

/**
 * 语料库：按群收集原始消息（默认关，群级开关），给她以后查/用。
 * 存储：data/corpus/<chatId>.jsonl，单文件 20MB 轮转。
 */

const fs = require('node:fs');
const path = require('node:path');

let DIR = path.join(__dirname, '..', 'data', 'corpus');
const MAX_BYTES = 20 * 1024 * 1024;

function setDataDir(dir) {
  if (dir) DIR = path.join(String(dir), 'corpus');
}

function fileFor(chatId) {
  const safe = String(chatId || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
  return path.join(DIR, safe + '.jsonl');
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    const old = file + '.1';
    try { fs.rmSync(old, { force: true }); } catch { /* ignore */ }
    fs.renameSync(file, old);
  } catch { /* ignore */ }
}

/** 追加一条消息（只收用户侧，不收她自己的回复，避免污染语料） */
function append(chatId, entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileFor(chatId);
    rotateIfNeeded(file);
    const line = JSON.stringify({
      ts: Number(entry.ts) || Date.now(),
      name: String(entry.name || '').slice(0, 40),
      uid: String(entry.uid || '').slice(0, 80),
      text: String(entry.text || '').slice(0, 2000),
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function stats(chatId) {
  const file = fileFor(chatId);
  try {
    const st = fs.statSync(file);
    let lines = 0;
    const buf = fs.readFileSync(file, 'utf8');
    for (let i = 0; i < buf.length; i += 1) if (buf.charCodeAt(i) === 10) lines += 1;
    return { file, bytes: st.size, lines, exists: true };
  } catch {
    return { file, bytes: 0, lines: 0, exists: false };
  }
}

function list() {
  try {
    return fs.readdirSync(DIR).filter((n) => n.endsWith('.jsonl')).map((n) => ({ name: n, bytes: fs.statSync(path.join(DIR, n)).size }));
  } catch {
    return [];
  }
}

module.exports = { append, stats, list, setDataDir, fileFor, DIR };
