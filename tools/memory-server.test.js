'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryServer } = require('./memory-server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function post(base, pathName, body, token = 't') {
  const r = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

test('记忆服务：token、写入、召回、隐私', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memsrv-'));
  const server = createMemoryServer({ dataDir: dir, token: 't' });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  try {
    const bad = await post(base, '/recall', { scope: 'wechat:g:a', query: 'x' }, 'bad');
    assert.equal(bad.status, 401);

    await post(base, '/add', { scope: 'wechat:g:a', text: '甲喜欢打羽毛球' });
    const own = await post(base, '/recall', { scope: 'wechat:g:a', query: '甲喜欢什么' });
    assert.ok(JSON.stringify(own.data.items).includes('羽毛球'));

    const leak = await post(base, '/recall', { scope: 'wechat:g:b', query: '甲喜欢什么' });
    assert.ok(!JSON.stringify(leak.data.items).includes('羽毛球'), '群间不应泄漏');

    const master = await post(base, '/recall', { scope: 'wechat:u:m', query: '甲喜欢什么', isMaster: true });
    assert.ok(JSON.stringify(master.data.items).includes('羽毛球'), '主人跨会话可见');

    const facts = await post(base, '/facts', { scope: 'wechat:g:a', op: 'list' });
    assert.equal(facts.status, 200);
    assert.ok(JSON.stringify(facts.data.items).includes('羽毛球'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('记忆服务：observe 只写海马体，digest 才写长期记忆', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memsrv-'));
  const llm = {
    isMock: false,
    async complete({ system }) {
      if (system.includes('把这段聊天')) {
        return JSON.stringify([{ fact: '主人喜欢喝冰美式', importance: 8, about: 'user', msg: 1 }]);
      }
      if (system.includes('事实核查员')) return '[]';
      if (system.includes('回看自己')) return '无';
      return '';
    },
  };
  const config = {
    digest: { minGapMinutes: 0, pendingMin: 1, pendingTokens: 1 },
    memory: { splitWithModel: false },
    group: { embedUrl: '' },
    paths: { dataDir: dir },
  };
  const server = createMemoryServer({ dataDir: dir, token: 't', llm, config });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  try {
    for (let i = 0; i < 3; i++) {
      const obs = await post(base, '/observe', {
        scope: 'wechat:u:m', user: '我喜欢喝冰美式第' + i + '次。', assistant: '记住啦', ts: 1000 + i,
      });
      assert.equal(obs.status, 200);
      assert.equal(obs.data.episode !== undefined, true);
    }
    const episodes = fs.readFileSync(path.join(dir, 'memory-episodes.jsonl'), 'utf8');
    assert.ok(episodes.includes('冰美式'));

    const before = await post(base, '/recall', { scope: 'wechat:u:m', query: '我喜欢喝什么' });
    assert.ok(!JSON.stringify(before.data.items).includes('冰美式'));

    const digest = await post(base, '/digest/run', { force: true });
    assert.equal(digest.status, 200);
    assert.ok(digest.data.done.length >= 1);

    const after = await post(base, '/recall', { scope: 'wechat:u:m', query: '我喜欢喝什么' });
    assert.ok(JSON.stringify(after.data.items).includes('冰美式'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
