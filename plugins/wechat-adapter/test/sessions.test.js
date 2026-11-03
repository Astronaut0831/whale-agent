import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, lastAssistantText, runTurn } from '../lib/sessions.js';

function fakeCtx(record) {
  return {
    agents: {
      async create(opts) {
        record.created = opts.sessionId;
        return makeHandle(record);
      },
      async resume(opts) {
        record.resumed = opts.resumeSessionId;
        return makeHandle(record);
      },
    },
  };
}

function makeHandle(record) {
  const agent = {
    followup(msg) { record.followup = msg; },
    cancel(cause) { record.cancel = cause; },
    whenIdle() { return record.idle || Promise.resolve(); },
    session: {
      deriveMessages() {
        return record.messages !== undefined ? record.messages : [{ role: 'assistant', content: [{ type: 'text', text: '好呀' }] }];
      },
    },
  };
  return { agent };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sess-'));
  return { store: createStore(path.join(dir, 'sessions.json')), dir };
}

test('首次创建会话并取回复', async () => {
  const rec = {};
  const { store, dir } = tmpStore();
  const out = await runTurn({
    ctx: fakeCtx(rec), sessionKey: 'wechat:u:m1', message: '在吗', timeoutMs: 1000, store,
  });
  assert.equal(out.text, '好呀');
  assert.ok(rec.created);
  assert.equal(store.get('wechat:u:m1'), rec.created);
  assert.equal(rec.followup.content[0].text, '在吗');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('已有映射时恢复会话', async () => {
  const rec = {};
  const { store, dir } = tmpStore();
  store.set('wechat:u:m1', 'sid-1');
  await runTurn({ ctx: fakeCtx(rec), sessionKey: 'wechat:u:m1', message: '继续', timeoutMs: 1000, store });
  assert.equal(rec.resumed, 'sid-1');
  assert.equal(rec.created, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('超时会 cancel 并报错', async () => {
  const rec = { idle: new Promise(() => {}), messages: [] };
  const { store, dir } = tmpStore();
  await assert.rejects(
    runTurn({ ctx: fakeCtx(rec), sessionKey: 'wechat:u:m2', message: '卡住', timeoutMs: 20, store }),
    /timeout/,
  );
  assert.equal(rec.cancel, 'timeout');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('提取最后一条 assistant 文本', () => {
  assert.equal(lastAssistantText([
    { role: 'user', content: [{ type: 'text', text: '问' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
  ]), '答');
  assert.equal(lastAssistantText([{ role: 'assistant', content: '字符串' }]), '字符串');
  assert.equal(lastAssistantText([]), '');
});
