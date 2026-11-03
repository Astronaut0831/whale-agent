/** adapter 内置下行队列：兼容旧 bot 的 outbox.json 结构。 */

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/runtime.js';

const MAX_ITEMS = 200;
let FILE = path.join(repoRoot, 'data', 'outbox.json');

export function setOutboxFile(file) {
  if (file) FILE = String(file);
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
  } catch { /* keep bridge alive even if disk is temporarily unavailable */ }
}

export function enqueue({ chatId, chatType = 'group', kind = 'text', text = '', file = '', meta = {} } = {}) {
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

export function take(limit = 10) {
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

export function ack(ids, ok = true) {
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

/**
 * 桥接重启时调用：把「取走了但没确认」的条目标成已处理并丢掉。
 * 那些多半已经发出去了，留下只会被 60 秒后的重取再发一遍 → 整段重复。
 */
export function resetSending() {
  const d = load();
  const before = d.items.length;
  d.items = d.items.filter((it) => it.status !== 'sending');
  const dropped = before - d.items.length;
  if (dropped) save(d);
  return dropped;
}

export function stats() {  const d = load();
  return {
    total: d.items.length,
    pending: d.items.filter((x) => x.status === 'pending').length,
    sending: d.items.filter((x) => x.status === 'sending').length,
  };
}
