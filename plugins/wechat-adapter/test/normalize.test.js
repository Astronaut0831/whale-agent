import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInbound, decideMode } from '../lib/normalize.js';
import { splitBubbles } from '../lib/bubbles.js';

test('私聊文本归一化', () => {
  const m = normalizeInbound({
    chat_id: 'wxid_master', chat_type: 'private', msg_id: 'm1',
    sender_id: 'wxid_master', nickname: '主人', text: '在吗', at_me: true,
  });
  assert.equal(m.sessionKey, 'wechat:u:wxid_master');
  assert.equal(m.chatType, 'private');
  assert.equal(m.text, '在吗');
  assert.equal(m.atMe, true);
});

test('群聊不接管', () => {
  const m = normalizeInbound({ chat_id: 'g1@chatroom', chat_type: 'group', msg_id: 'm2', text: 'hi' });
  assert.equal(decideMode({ mode: 'active', masterWxid: 'wxid_master' }, m), 'legacy');
});

test('主人私聊 active 接管', () => {
  const m = normalizeInbound({ chat_id: 'wxid_master', chat_type: 'private', msg_id: 'm3', text: 'hi' });
  assert.equal(decideMode({ mode: 'active', masterWxid: 'wxid_master' }, m), 'active');
  assert.equal(decideMode({ mode: 'off', masterWxid: 'wxid_master' }, m), 'off');
});

test('缺 msg_id 报错', () => {
  assert.throws(() => normalizeInbound({ chat_id: 'x', chat_type: 'private', text: 'hi' }), /msg_id/);
});

test('气泡按标点拆分且不超上限', () => {
  const out = splitBubbles('第一句。第二句！第三句？第四句。第五句。', { maxBubbles: 3, maxChars: 100 });
  assert.equal(out.length, 3);
  assert.match(out[0], /第一句/);
});

test('空文本不产生气泡', () => {
  assert.deepEqual(splitBubbles('   '), []);
});
