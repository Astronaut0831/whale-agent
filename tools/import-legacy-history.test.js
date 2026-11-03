'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, 'import-legacy-history.js');

test('legacy history import pairs private messages and dedupes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-import-'));
  const db = path.join(dir, 'bot.db');
  const episodes = path.join(dir, 'episodes.jsonl');
  try {
    const d = new DatabaseSync(db);
    d.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, ts INTEGER, role TEXT, name TEXT, uid TEXT, text TEXT)');
    const ins = d.prepare('INSERT INTO messages (session,ts,role,name,uid,text) VALUES (?,?,?,?,?,?)');
    ins.run('wechat:u:a', 1000, 'user', 'A', 'wxid_a', '你好');
    ins.run('wechat:u:a', 2000, 'assistant', '她', '', '在呢');
    ins.run('wechat:g:x@chatroom', 3000, 'user', 'B', 'wxid_b', '群里的话');
    ins.run('wechat:g:x@chatroom', 4000, 'assistant', '她', '', '群回复');
    d.close();

    const r = spawnSync(process.execPath, [SCRIPT, '--db=' + db, '--episodes=' + episodes], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.imported, 1);
    const lines = fs.readFileSync(episodes, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]);
    assert.equal(e.scope, 'wechat:u:a');
    assert.equal(e.user, '你好');
    assert.equal(e.assistant, '在呢');

    const r2 = spawnSync(process.execPath, [SCRIPT, '--db=' + db, '--episodes=' + episodes], { encoding: 'utf8' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout).imported, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
