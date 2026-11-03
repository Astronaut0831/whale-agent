'use strict';

/**
 * 消息存储：Node 内置 node:sqlite（零依赖），WAL 模式。
 *
 * 为什么换掉 JSON：
 * - 以前每条消息都重写整个 store.json（O(n) IO，n 越大越慢）
 * - 桥接是 UIA 点屏，可能重复读到同一条消息；这里用 (session, msg_id) 唯一索引兜底
 */

const fs = require('node:fs');
const path = require('node:path');

let file = '';
let db = null;

function setDataDir(dir) {
  const next = path.join(String(dir || ''), 'bot.db');
  if (next === file && db) return;
  file = next;
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
}

function ensure() {
  if (db) return db;
  if (!file) throw new Error('db 未初始化：先调用 setDataDir');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session TEXT NOT NULL,
    ts INTEGER NOT NULL,
    role TEXT NOT NULL,
    name TEXT,
    uid TEXT,
    text TEXT,
    msg_id TEXT,
    extra TEXT
  );`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msgid ON messages(session, msg_id) WHERE msg_id IS NOT NULL;');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session, ts);');
  db.exec(`CREATE TABLE IF NOT EXISTS seen (
    session TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (session, msg_id)
  );`);
  return db;
}

/** 追加一条消息；重复 msg_id 返回 false */
function append(session, entry) {
  const d = ensure();
  const extra = {};
  for (const k of ['addressedToBot', 'mentionedNames', 'inferredTargetNames', 'replyToName', 'replyToUserId', 'error']) {
    if (entry[k] !== undefined) extra[k] = entry[k];
  }
  const stmt = d.prepare('INSERT OR IGNORE INTO messages (session, ts, role, name, uid, text, msg_id, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const r = stmt.run(session, Number(entry.ts) || Date.now(), entry.role || 'user', entry.name || '', entry.uid || '', entry.text || '', entry.msgId || null, Object.keys(extra).length ? JSON.stringify(extra) : null);
  return Number(r.changes) > 0;
}

function rowToMsg(row) {
  const m = { role: row.role, name: row.name, uid: row.uid, text: row.text, ts: row.ts };
  if (row.msg_id) m.msgId = row.msg_id;
  if (row.extra) {
    try { Object.assign(m, JSON.parse(row.extra)); } catch { /* ignore */ }
  }
  return m;
}

function recent(session, limit = 24) {
  const d = ensure();
  const n = Math.max(1, Math.min(20000, Number(limit) || 24));
  const rows = d.prepare('SELECT * FROM messages WHERE session = ? ORDER BY id DESC LIMIT ?').all(session, n);
  return rows.reverse().map(rowToMsg);
}

function all(session, limit = 20000) {
  const d = ensure();
  const rows = d.prepare('SELECT * FROM messages WHERE session = ? ORDER BY id ASC LIMIT ?').all(session, Math.max(1, Number(limit) || 20000));
  return rows.map(rowToMsg);
}

function count(session) {
  const d = ensure();
  const row = d.prepare('SELECT COUNT(*) AS n FROM messages WHERE session = ?').get(session);
  return Number(row && row.n) || 0;
}

/** 超过 keep 条时，删掉最老的并返回（供归档） */
function trim(session, keep) {
  const d = ensure();
  const total = count(session);
  const overflow = total - Math.max(1, Number(keep) || 6000);
  if (overflow <= 0) return [];
  const rows = d.prepare('SELECT * FROM messages WHERE session = ? ORDER BY id ASC LIMIT ?').all(session, overflow);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    const del = d.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of ids) del.run(id);
  }
  return rows.map(rowToMsg);
}

function isSeen(session, msgId) {
  if (!msgId) return false;
  const d = ensure();
  const row = d.prepare('SELECT 1 AS x FROM seen WHERE session = ? AND msg_id = ?').get(session, String(msgId));
  return Boolean(row);
}

function markSeen(session, msgId) {
  if (!msgId) return;
  const d = ensure();
  d.prepare('INSERT OR IGNORE INTO seen (session, msg_id, ts) VALUES (?, ?, ?)').run(session, String(msgId), Date.now());
}

/** 批量导入旧 JSON 里的消息（迁移用） */
function importMessages(session, list) {
  let n = 0;
  for (const m of list || []) {
    if (append(session, m)) n += 1;
  }
  return n;
}

/** 把某会话最后一条消息的正文换掉（敏感内容隐藏用） */
function redactLast(session, replacement) {
  const d = ensure();
  const row = d.prepare('SELECT id FROM messages WHERE session = ? ORDER BY id DESC LIMIT 1').get(session);
  if (!row) return false;
  d.prepare('UPDATE messages SET text = ? WHERE id = ?').run(String(replacement || '（已隐藏）'), row.id);
  return true;
}

function close() {
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
}

module.exports = { setDataDir, append, recent, all, count, trim, isSeen, markSeen, importMessages, redactLast, close };
