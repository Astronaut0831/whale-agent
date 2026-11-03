'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memories = require('../src/memories');
const narrative = require('../src/narrative');
const { runDigestPass } = require('../src/digestCore');

function makeRuntime(dir) {
  const key = 'wechat:u:test-user';
  const messages = [];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'user', text: '我喜欢第' + i + '件事', name: '主人', ts: 1000 + i * 2, msgId: 'm' + i + 'u' });
    messages.push({ role: 'assistant', text: '记住第' + i + '件', name: '她', ts: 1001 + i * 2, msgId: 'm' + i + 'a' });
  }
  const session = { title: '私聊', digestUpTo: 0, digestAt: 0 };
  const store = {
    sessions: new Map([[key, session]]),
    sessionKeys: () => [key],
    messages: () => messages,
    digestOf: () => [],
    setDigest: (_key, lines) => { store._digest = lines; },
    markDirty: () => {},
  };
  const calls = [];
  const llm = {
    isMock: false,
    async complete({ system, turns }) {
      calls.push({ system, turns });
      if (system.includes('把这段聊天')) {
        return JSON.stringify([{ fact: '主人喜欢羽毛球', importance: 8, about: 'user', msg: 1 }]);
      }
      if (system.includes('把下面多条要点')) return JSON.stringify([{ fact: '主人喜欢羽毛球', importance: 8 }]);
      if (system.includes('事实核查员')) return '[]';
      if (system.includes('回看自己')) return '无';
      return '';
    },
  };
  const config = {
    digest: { minGapMinutes: 0, pendingMin: 1, pendingTokens: 1, batchMessages: 60, batchTokens: 8000 },
    memory: { splitWithModel: false },
    group: { embedUrl: '' },
    paths: { dataDir: dir },
  };
  const logger = { info: () => {}, warn: (m) => console.error('WARN', m), debug: () => {} };
  return { key, session, store, llm, config, logger, calls };
}

test('digest 核心：抽事实、写 provenance、推进 cursor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-digest-'));
  memories.setDataDir(dir);
  narrative.setDataDir(dir);
  const rt = makeRuntime(dir);
  try {
    const out = await runDigestPass(rt, { force: true });
    assert.equal(out.length, 1);
    assert.ok(out[0].added >= 1);
    assert.ok(rt.store._digest.includes('主人喜欢羽毛球'));
    assert.ok(rt.session.digestUpTo > 0);
    const facts = memories.listFacts(rt.key);
    assert.ok(facts.some((f) => f.text.includes('羽毛球')));
    const factsWithProv = facts.filter((f) => f.provenance && f.provenance.kind === 'digest');
    assert.ok(factsWithProv.length >= 1);
    assert.ok(rt.calls.some((c) => c.system.includes('把这段聊天')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
