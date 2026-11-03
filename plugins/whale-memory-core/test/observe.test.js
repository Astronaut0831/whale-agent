import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, isInjectedContext, lastTurn } from '../index.js';

function harness() {
  let handler;
  const ctx = { on: (name, fn) => { if (name === 'session/event') handler = fn; } };
  return { ctx, fire: (session, event) => handler(session, event) };
}

const EVENT = { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } };
const SESSION = (id) => ({
  id,
  deriveMessages: () => [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在呢' }],
});

test('非目标 GUI session 不写 episode', async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); return { ok: true }; };
  try {
    const h = harness();
    apply(h.ctx, { targetSessionId: 'session-target', scope: 'gui:whale', memoryUrl: 'http://memory' });
    h.fire(SESSION('session-other'), EVENT);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test('目标 GUI session 写入配置的 scope', async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); return { ok: true }; };
  try {
    const h = harness();
    apply(h.ctx, { targetSessionId: 'session-target', scope: 'gui:whale', memoryUrl: 'http://memory' });
    h.fire(SESSION('session-target'), EVENT);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.match(String(calls[0][0]), /\/observe$/);
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body.scope, 'gui:whale');
    assert.equal(body.user, '你好');
    assert.equal(body.assistant, '在呢');
  } finally { globalThis.fetch = oldFetch; }
});

test('GUI 运行时上下文不会被当成用户原话', () => {
  const injected = [
    'Time sampled while preparing turn 7, step 1: 2026-11-03T01:36:40+08:00[Asia/Shanghai]',
    'Browser time zone for this request: Asia/Shanghai.',
    'Elapsed since the preceding model-visible message: 25m 46s.',
  ].join('\n');
  assert.equal(isInjectedContext(injected), true);
  const turn = lastTurn([
    { role: 'user', content: '只回复：broker已接通' },
    { role: 'assistant', content: 'broker已接通' },
    { role: 'user', content: injected },
  ]);
  assert.equal(turn.user, '只回复：broker已接通');
  assert.equal(turn.assistant, 'broker已接通');
});
