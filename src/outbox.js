'use strict';

/**
 * 下行队列：服务端把要主动发出的消息（任务播报、完成通知、文件）放这里，
 * 桥接轮询取件后用 UIA 发出去。
 *
 * 存在 data/outbox.json：条目少、不需要事务，单进程读写加锁足够。
 */

const fs = require('node:fs');
const path = require('node:path');

let FILE = path.join(__dirname, '..', 'data', 'outbox.json');
const MAX_ITEMS = 200;

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'outbox.json');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { items: Array.isArray(d.items) ? d.items : [] };
  } catch {
    return { items: [] };
  }
}

function save(d) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* ignore */ }
}

/** 入队一条：kind = text | file */
function enqueue({ chatId, chatType = 'group', kind = 'text', text = '', file = '', meta = {} }) {
  const id = 'o_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const d = load();
  d.items.push({
    id, chatId: String(chatId || ''), chatType, kind, text: String(text || ''),
    file: String(file || ''), meta, createdAt: Date.now(), status: 'pending', attempts: 0,
  });
  if (d.items.length > MAX_ITEMS) d.items = d.items.slice(-MAX_ITEMS);
  save(d);
  return id;
}

/** 取待发条目（标记 sending，防止重复取） */
function take(limit = 10) {
  const d = load();
  const now = Date.now();
  const out = [];
  for (const it of d.items) {
    if (out.length >= limit) break;
    if (it.status === 'pending' || (it.status === 'sending' && now - Number(it.takenAt || 0) > 60000)) {
      it.status = 'sending';
      it.takenAt = now;
      it.attempts = Number(it.attempts || 0) + 1;
      out.push({ ...it });
    }
  }
  if (out.length) save(d);
  return out;
}

/** 回执：ok=true 删除；失败重排（最多 3 次后丢弃） */
function ack(ids, ok = true) {
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  const d = load();
  const before = d.items.length;
  d.items = d.items.filter((it) => {
    if (!set.has(String(it.id))) return true;
    if (ok) return false;
    if (Number(it.attempts || 0) >= 3) return false;
    it.status = 'pending';
    return true;
  });
  const removed = before - d.items.length;
  save(d);
  return removed;
}

function stats() {
  const d = load();
  return {
    total: d.items.length,
    pending: d.items.filter((x) => x.status === 'pending').length,
    sending: d.items.filter((x) => x.status === 'sending').length,
  };
}

module.exports = { enqueue, take, ack, stats, setDataDir, load };
