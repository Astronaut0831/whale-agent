import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

function listen(server) {
  return new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
}

test('/task list 由 adapter 处理并入 outbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-task-'));
  const whale = path.join(dir, 'config.json');
  fs.writeFileSync(whale, JSON.stringify({
    persona: { master: { wxids: ['wxid_master'] } },
    gateway: { wechat: { inboundToken: 't' } },
  }));
  const server = apply({
    agents: {}, systemPrompt: { section: () => {} }, effect: () => {},
  }, {
    host: '127.0.0.1', port: 0, token: 't',
    whaleConfigPath: whale,
    modeFile: path.join(dir, 'mode.json'),
    sessionsFile: path.join(dir, 'sessions.json'),
    logFile: path.join(dir, 'adapter.log'),
    personaFile: path.join(dir, 'persona.md'),
    outboxFile: path.join(dir, 'outbox.json'),
    dataDir: dir,
    memoryUrl: 'http://127.0.0.1:1',
  });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  try {
    const r = await fetch(base + '/webhook/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': 't' },
      body: JSON.stringify({
        chat_id: 'wxid_master', chat_type: 'private', msg_id: 'task1',
        sender_id: 'wxid_master', text: '/task list',
      }),
    });
    const data = await r.json();
    assert.equal(r.status, 200);
    assert.equal(data.ok, true);
    assert.match(data.bubbles[0], /没有任务/);

    const box = await (await fetch(base + '/api/bridge/outbox')).json();
    assert.equal(box.items.length, 1);
    assert.match(box.items[0].text, /没有任务/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
