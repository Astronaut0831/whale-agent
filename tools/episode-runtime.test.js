'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEpisodeRuntime } = require('./episode-runtime');

test('episode runtime：消息展开、digest 状态持久化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ep-'));
  const episodes = [
    { id: 'e1', scope: 'wechat:u:m', user: '你好', assistant: '在', ts: 1000 },
    { id: 'e2', scope: 'wechat:u:m', user: '我喜欢羽毛球', assistant: '记住啦', ts: 2000 },
    { id: 'e3', scope: 'wechat:g:g1', user: '群里好', assistant: '好', ts: 3000 },
  ];
  fs.writeFileSync(path.join(dir, 'memory-episodes.jsonl'), episodes.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    const rt = createEpisodeRuntime({ dataDir: dir, config: {} });
    assert.deepEqual(rt.store.sessionKeys().sort(), ['wechat:g:g1', 'wechat:u:m']);
    assert.equal(rt.store.messages('wechat:u:m').length, 4);
    assert.equal(rt.store.messages('wechat:u:m')[0].text, '你好');
    assert.equal(rt.store.messages('wechat:u:m')[0].role, 'user');

    rt.store.setDigest('wechat:u:m', ['要点']);
    rt.store.sessions.get('wechat:u:m').digestUpTo = 2000;
    const rt2 = createEpisodeRuntime({ dataDir: dir, config: {} });
    assert.deepEqual(rt2.store.digestOf('wechat:u:m'), ['要点']);
    assert.equal(rt2.store.sessions.get('wechat:u:m').digestUpTo, 2000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
