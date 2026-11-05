import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

function listen(server) {
  return new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
}

test('sticker image/delete/test', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sticker-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'stickers', 'other'), { recursive: true });
  const file = path.join(root, 'stickers', 'other', 'test.png');
  fs.writeFileSync(file, PNG);
  const whale = path.join(root, 'config.json');
  fs.writeFileSync(whale, JSON.stringify({
    persona: { master: { wxids: ['wxid_master'] } },
    gateway: { wechat: { inboundToken: 't' } },
    features: { stickers: true },
    sticker: { dir: path.join(root, 'stickers'), testChat: '文件传输助手' },
  }));
  const server = apply({ agents: {}, systemPrompt: { section: () => {} }, effect: () => {} }, {
    host: '127.0.0.1', port: 0, token: 't',
    whaleConfigPath: whale, root, dataDir,
    modeFile: path.join(dataDir, 'mode.json'),
    sessionsFile: path.join(dataDir, 'sessions.json'),
    logFile: path.join(dataDir, 'adapter.log'),
    personaFile: path.join(dataDir, 'persona.md'),
    outboxFile: path.join(dataDir, 'outbox.json'),
    memoryUrl: 'http://127.0.0.1:1',
  });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  try {
    const img = await fetch(base + '/api/stickers/image?emotion=other&name=test.png');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await img.arrayBuffer()).length, PNG.length);

    const t = await fetch(base + '/api/stickers/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emotion: 'other' }),
    });
    assert.equal(t.status, 200);
    assert.equal((await t.json()).ok, true);

    const del = await fetch(base + '/api/stickers/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emotion: 'other', name: 'test.png' }),
    });
    assert.equal(del.status, 200);
    assert.equal(fs.existsSync(file), false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
