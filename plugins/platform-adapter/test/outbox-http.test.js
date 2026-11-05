import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

function listen(server) {
  return new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
}

test('adapter 自带 outbox：core/send → bridge/outbox → ack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-outbox-'));
  const whale = path.join(dir, 'config.json');
  fs.writeFileSync(whale, JSON.stringify({
    persona: { master: { wxids: ['wxid_master'] } },
    gateway: { wechat: { inboundToken: 't' } },
  }));
  const fakeCtx = {
    agents: {},
    systemPrompt: { section: () => {} },
    effect: () => {},
  };
  const server = apply(fakeCtx, {
    host: '127.0.0.1', port: 0, token: 't',
    whaleConfigPath: whale,
    modeFile: path.join(dir, 'mode.json'),
    sessionsFile: path.join(dir, 'sessions.json'),
    logFile: path.join(dir, 'adapter.log'),
    personaFile: path.join(dir, 'persona.md'),
    outboxFile: path.join(dir, 'outbox.json'),
    memoryUrl: 'http://127.0.0.1:1',
  });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  try {
    const send = await fetch(base + '/api/core/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': 't' },
      body: JSON.stringify({ chatId: 'wxid_master', chatType: 'private', bubbles: ['a', 'b'] }),
    });
    assert.equal(send.status, 200);
    assert.deepEqual((await send.json()).count, 2);

    const take = await fetch(base + '/api/bridge/outbox');
    const taken = await take.json();
    assert.equal(taken.ok, true);
    assert.equal(taken.items.length, 2);
    assert.equal(taken.items[0].text, 'a');

    const ack = await fetch(base + '/api/bridge/outbox/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: taken.items.map((x) => x.id), ok: true }),
    });
    assert.equal((await ack.json()).removed, 2);
    const empty = await (await fetch(base + '/api/bridge/outbox')).json();
    assert.equal(empty.items.length, 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
