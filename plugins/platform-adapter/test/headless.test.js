import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseRunEvents, runHeadlessTurn } from '../lib/headless.js';

function fakeSpawn(capture, { code = 0, events = [] } = {}) {
  return (cmd, args) => {
    capture.cmd = cmd;
    capture.args = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      for (const e of events) child.stdout.write(JSON.stringify(e) + '\n');
      child.emit('close', code);
    });
    return child;
  };
}

test('解析 session/final 事件', () => {
  const out = '{"type":"session","sessionId":"s1"}\n{"type":"final","text":"好"}\n';
  assert.deepEqual(parseRunEvents(out), { sessionId: 's1', finalText: '好' });
});

test('首次运行不带 session-id，运行后写入 store', async () => {
  const storeMap = new Map();
  const store = { get: (k) => storeMap.get(k) || '', set: (k, v) => storeMap.set(k, v) };
  const cap = {};
  const out = await runHeadlessTurn({
    sessionKey: 'wechat:u:m1', message: '在吗', store,
    spawnImpl: fakeSpawn(cap, { events: [{ type: 'session', sessionId: 's1' }, { type: 'final', text: '在' }] }),
  });
  assert.equal(out.text, '在');
  assert.equal(cap.args.includes('--session-id'), false);
  assert.equal(storeMap.get('wechat:u:m1'), 's1');
});

test('已有会话时带 session-id', async () => {
  const store = { get: () => 's1', set: () => {} };
  const cap = {};
  await runHeadlessTurn({
    sessionKey: 'k', message: '继续', store,
    spawnImpl: fakeSpawn(cap, { events: [{ type: 'final', text: '好' }] }),
  });
  assert.ok(cap.args.includes('--profile'));
  assert.ok(cap.args.includes('--json'));
  assert.ok(cap.args.includes('--session-id'));
  assert.ok(cap.args.includes('s1'));
});

test('失败返回拒绝', async () => {
  const store = { get: () => '', set: () => {} };
  await assert.rejects(
    runHeadlessTurn({ sessionKey: 'k', message: 'x', store, spawnImpl: fakeSpawn({}, { code: 1, events: [] }) }),
    /headless failed/,
  );
});
