import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToken, createSeen, handleInbound } from '../lib/inbound.js';

const payload = {
  chat_id: 'wxid_master', chat_type: 'private', msg_id: 'm1',
  sender_id: 'wxid_master', text: '在吗', at_me: true,
};

function fakeFetch(rec) {
  return async (url, opts) => {
    rec.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, bubbles: ['在'] }),
    };
  };
}

test('token 校验', () => {
  assert.equal(checkToken({ headers: { 'x-bot-token': 't1' } }, 't1'), true);
  assert.equal(checkToken({ headers: { 'x-bot-token': 'bad' } }, 't1'), false);
  assert.equal(checkToken({ url: '/webhook/wechat?token=t1' }, 't1'), true);
});

test('off 代理到旧 bot', async () => {
  const rec = [];
  const seen = createSeen();
  const out = await handleInbound(payload, {
    mode: 'off', masterWxid: 'wxid_master', legacyBase: 'http://127.0.0.1:8787',
    token: 't', seen, fetchImpl: fakeFetch(rec),
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { ok: true, bubbles: ['在'] });
  assert.equal(rec.length, 1);
  assert.equal(rec[0].url, 'http://127.0.0.1:8787/webhook/wechat');
  assert.equal(rec[0].opts.headers['x-bot-token'], 't');
});

test('重复 msg_id 不再代理', async () => {
  const rec = [];
  const seen = createSeen();
  const deps = { mode: 'off', masterWxid: 'wxid_master', legacyBase: 'http://x', token: '', seen, fetchImpl: fakeFetch(rec) };
  await handleInbound(payload, deps);
  const out = await handleInbound(payload, deps);
  assert.equal(out.duplicate, true);
  assert.equal(rec.length, 1, '第二次不应再请求旧 bot');
});

test('群聊在 active 下仍走 legacy', async () => {
  const rec = [];
  const seen = createSeen();
  const out = await handleInbound({ ...payload, chat_id: 'g1@chatroom', chat_type: 'group', msg_id: 'm2' }, {
    mode: 'active', masterWxid: 'wxid_master', legacyBase: 'http://x', token: '', seen, fetchImpl: fakeFetch(rec),
  });
  assert.equal(out.mode, 'legacy');
  assert.equal(rec.length, 1);
});
