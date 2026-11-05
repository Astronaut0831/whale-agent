import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope, createOutbound, formatForAgent } from '../lib/envelope.js';
import { normalizeInbound } from '../lib/normalize.js';

test('统一 envelope：字段、sessionKey、格式', () => {
  const env = createEnvelope({
    platform: 'wechat', chatId: 'g1@chatroom', chatType: 'group', msgId: 'm1',
    senderId: 'u1', senderName: '甲', text: '在吗', atMe: true, ts: 1700000000000,
  });
  assert.equal(env.v, 1);
  assert.equal(env.sessionKey, 'wechat:g:g1@chatroom');
  assert.equal(env.threadId, 'wechat:group:g1@chatroom');
  assert.equal(env.message.sender.name, '甲');
  assert.equal(env.message.atMe, true);
  assert.equal(formatForAgent(env), '[wechat群聊] 甲：在吗');
});

test('微信入站自动带 envelope', () => {
  const msg = normalizeInbound({
    chat_id: 'wxid_master', chat_type: 'private', msg_id: 'm2',
    sender_id: 'wxid_master', nickname: '主人', text: '你好',
  });
  assert.equal(msg.envelope.platform, 'wechat');
  assert.equal(msg.envelope.sessionKey, 'wechat:u:wxid_master');
  assert.equal(formatForAgent(msg.envelope), '[wechat私聊] 主人：你好');
});

test('outbound 保留回复目标', () => {
  const env = createEnvelope({ platform: 'wechat', chatId: 'c1', chatType: 'private', msgId: 'm3' });
  const out = createOutbound(env, { bubbles: ['a', 'b'] });
  assert.equal(out.replyTo, 'm3');
  assert.deepEqual(out.bubbles, ['a', 'b']);
  assert.equal(out.sessionKey, undefined);
});
