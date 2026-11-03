'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInbound } = require('../src/adapters/gateway');

test('群图片进入后续上下文，不做关键词门槛', () => {
  const base = { chat_id: 'g-img-test2@chatroom', chat_type: 'group', user_id: 'u1', user_name: '九', msg_id: 'm1' };
  const img = normalizeInbound({ ...base, text: '', image_base64: 'QUJD', mime: 'image/png' }, 'wechat');
  assert.equal(img.images.length, 1);
  assert.ok(!img.images[0].followup, '当前图片不是追问');

  const ask = normalizeInbound({ ...base, msg_id: 'm2', text: '现在能看清这张图吗？' }, 'wechat');
  assert.equal(ask.images.length, 1, '后续消息带上图');
  assert.equal(ask.images[0].followup, true, '标记为最近一张图');

  const unrelated = normalizeInbound({ ...base, msg_id: 'm3', text: '今天吃什么' }, 'wechat');
  assert.equal(unrelated.images.length, 1, '无关文字也带上，由她自己判断');

  const other = normalizeInbound({ chat_id: 'g-noimg@chatroom', chat_type: 'group', user_id: 'u2', text: '在吗', msg_id: 'm4' }, 'wechat');
  assert.equal(other.images.length, 0, '没发过图的会话不带图');
});

test('图片取不到时清掉旧图缓存', () => {
  const base = { chat_id: 'g-err@chatroom', chat_type: 'group', user_id: 'u1', user_name: '九', msg_id: 'e1' };
  normalizeInbound({ ...base, text: '', image_base64: 'QUJD', mime: 'image/png' }, 'wechat');
  const err = normalizeInbound({ ...base, msg_id: 'e2', text: '（对方发了一张图片，但这张图本机没取到）', image_error: true }, 'wechat');
  assert.equal(err.images.length, 0, '错误消息不带旧图');
  assert.equal(err.imageError, true);
  const after = normalizeInbound({ ...base, msg_id: 'e3', text: '随便说句' }, 'wechat');
  assert.equal(after.images.length, 0, '旧图缓存应已清空');
});
