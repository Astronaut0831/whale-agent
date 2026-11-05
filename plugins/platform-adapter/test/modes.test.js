import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchInbound } from '../lib/modes.js';

const payload = {
  chat_id: 'wxid_master', chat_type: 'private', msg_id: 'm1',
  sender_id: 'wxid_master', nickname: '主人', text: '在吗',
};

function legacyFetch(rec, bubbles = ['旧回复']) {
  return async (url, opts) => {
    rec.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, bubbles }) };
  };
}

test('shadow 转发旧 bot，agent 只记录', async () => {
  const rec = [];
  const logs = [];
  const out = await dispatchInbound(payload, {
    mode: 'shadow', masterWxid: 'wxid_master', legacyBase: 'http://x', fetchImpl: legacyFetch(rec),
    runTurn: async ({ sessionKey }) => ({ text: '新回复' }),
    log: (x) => logs.push(x),
  });
  assert.deepEqual(out.data, { ok: true, bubbles: ['旧回复'] });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rec.length, 1);
  assert.ok(logs.some((x) => x.kind === 'shadow' && x.text === '新回复'));
});

test('active 成功用 agent 回复并发气泡', async () => {
  const sent = [];
  const out = await dispatchInbound(payload, {
    mode: 'active', masterWxid: 'wxid_master', legacyBase: 'http://x', fetchImpl: legacyFetch([]),
    runTurn: async () => ({ text: '新回复' }),
    splitBubbles: (t) => [t],
    sendBubbles: async (x) => sent.push(x),
    log: () => {},
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.data.bubbles, ['新回复']);
  assert.equal(sent[0].chatId, 'wxid_master');
});

test('active 失败回退旧 bot', async () => {
  const rec = [];
  const out = await dispatchInbound(payload, {
    mode: 'active', masterWxid: 'wxid_master', legacyBase: 'http://x', fetchImpl: legacyFetch(rec),
    runTurn: async () => { throw new Error('agent down'); },
    log: () => {},
  });
  assert.equal(out.fallback, 'agent down');
  assert.deepEqual(out.data, { ok: true, bubbles: ['旧回复'] });
  assert.equal(rec.length, 1);
});

const groupPayload = {
  chat_id: 'g1@chatroom', chat_type: 'group', msg_id: 'gm1',
  sender_id: 'u1', nickname: '甲', text: '随便聊聊',
};

test('群聊全量进 agent，模型可用 [SKIP] 自主不回', async () => {
  const observed = [];
  let ran = false;
  const out = await dispatchInbound(groupPayload, {
    mode: 'active', masterWxid: 'wxid_master', groupEnabled: true, legacyEnabled: false,
    groupObserve: (m) => observed.push(m.msgId),
    groupShouldWake: async () => ({ wake: false, reason: 'score_low', score: 0.2 }),
    runTurn: async () => { ran = true; return { text: '[SKIP]' }; },
    log: () => {},
  });
  assert.equal(out.status, 200);
  assert.equal(out.data.ignored, true);
  assert.equal(out.data.reason, 'model_skip');
  assert.deepEqual(observed, ['gm1']);
  assert.equal(ran, true);
});

test('群聊高分时进 DSH 并记录她的回复', async () => {
  const sent = [];
  const replies = [];
  const out = await dispatchInbound(groupPayload, {
    mode: 'active', masterWxid: 'wxid_master', groupEnabled: true, legacyEnabled: false,
    groupObserve: () => {},
    groupShouldWake: async () => ({ wake: true, reason: 'score_high', score: 1.1 }),
    groupRecordReply: () => {},
    groupObserveReply: (_m, text) => replies.push(text),
    runTurn: async () => ({ text: '好呀' }),
    splitBubbles: (t) => [t],
    sendBubbles: async (x) => sent.push(x),
    log: () => {},
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.data.bubbles, ['好呀']);
  assert.equal(sent[0].chatId, 'g1@chatroom');
  assert.deepEqual(replies, ['好呀']);
});
