import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recentUserTexts } from '../lib/recent-context.js';

test('读取最近用户消息，倒序后由调用方决定顺序', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-recent-'));
  const file = path.join(dir, 'bot.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE messages (session TEXT, role TEXT, text TEXT, ts INTEGER)');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run('s1', 'user', '第一句', 1);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run('s1', 'assistant', '回复', 2);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run('s1', 'user', '第二句', 3);
  db.close();
  try {
    assert.deepEqual(recentUserTexts(file, 's1', 3), ['第二句', '第一句']);
    assert.deepEqual(recentUserTexts(file, 'other', 3), []);
    assert.deepEqual(recentUserTexts('', 's1', 3), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
