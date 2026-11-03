import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, lastTurn, textOf } from '../index.js';

test('只取 text 内容块，不把 reasoning 写进记忆', () => {
  assert.equal(textOf({ content: [
    { type: 'reasoning', text: '内部推理' },
    { type: 'text', text: '收到' },
  ] }), '收到');
});

test('lastTurn 取最后一条 user 和 assistant', () => {
  const r = lastTurn([
    { role: 'user', content: [{ type: 'text', text: '旧' }] },
    { role: 'assistant', content: [{ type: 'text', text: '旧回' }] },
    { role: 'user', content: [{ type: 'text', text: '新' }] },
    { role: 'assistant', content: [{ type: 'text', text: '新回' }] },
  ]);
  assert.deepEqual(r, { user: '新', assistant: '新回' });
});

test('runtime context 不当作 user 原话', () => {
  const r = lastTurn([
    { role: 'user', content: [{ type: 'text', text: '我喜欢手冲咖啡' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好' }] },
    { role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "D:\\\\x"\n\nCurrent DSH file policy: workspace-write.' }] },
  ]);
  assert.deepEqual(r, { user: '我喜欢手冲咖啡', assistant: '好' });
});

test('AGENTS.md system-reminder 也不当作 user 原话', () => {
  const r = lastTurn([
    { role: 'user', content: [{ type: 'text', text: '我喜欢手冲咖啡' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may be relevant...\nInstructions from: AGENTS.md\n# 哦鲸鲸的工作区' }] },
  ]);
  assert.deepEqual(r, { user: '我喜欢手冲咖啡', assistant: '好' });
});

test('turn/end 时 POST /observe', async () => {
  const listeners = [];
  const calls = [];
  const ctx = { on: (name, fn) => listeners.push({ name, fn }) };
  apply(ctx, { memoryUrl: 'http://mem', token: 't' });
  assert.equal(listeners[0].name, 'session/event');

  const old = process.env.WHALE_SESSION_SCOPE;
  process.env.WHALE_SESSION_SCOPE = 'wechat:u:m1';
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
  try {
    listeners[0].fn({
      id: 's1',
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '我喜欢羽毛球' }] },
        { role: 'assistant', content: [{ type: 'text', text: '记住啦' }] },
      ],
    }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.scope, 'wechat:u:m1');
    assert.match(calls[0].body.user, /羽毛球/);
  } finally {
    globalThis.fetch = oldFetch;
    if (old === undefined) delete process.env.WHALE_SESSION_SCOPE;
    else process.env.WHALE_SESSION_SCOPE = old;
  }
});
