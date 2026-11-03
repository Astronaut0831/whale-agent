/** 读取当前会话最近几条用户消息，用于记忆召回查询扩展。 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function recentUserTexts(dbFile, sessionKey, limit = 3) {
  if (!dbFile || !sessionKey || !fs.existsSync(dbFile)) return [];
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare(
      'SELECT text FROM messages WHERE session = ? AND role = ? ORDER BY ts DESC LIMIT ?',
    ).all(sessionKey, 'user', Math.max(1, Math.min(10, Number(limit) || 3)));
    return rows.map((r) => String(r.text || '').trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
