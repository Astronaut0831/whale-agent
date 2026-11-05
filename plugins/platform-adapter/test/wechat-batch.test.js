import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatBatcher } from '../lib/wechat-batch.js';

test('coalesces a rapid burst into one primary payload', async () => {
  const batcher = createChatBatcher({ windowMs: 30 });
  const first = batcher.push('wxid_a', { text: '在吗', msg_id: 'm1', ts: 1, chat_id: 'wxid_a' });
  const second = batcher.push('wxid_a', { text: '今天好累', msg_id: 'm2', ts: 2, chat_id: 'wxid_a' });
  assert.equal(second.primary, false);
  const result = await first;
  assert.equal(result.primary, true);
  assert.equal(result.count, 2);
  assert.equal(result.payload.text, '在吗\n今天好累');
  assert.equal(result.payload.chat_id, 'wxid_a');
  assert.match(result.payload.msg_id, /^batch:m1:m2$/);
  assert.equal(batcher.size(), 0);
});

test('separate chats do not merge', async () => {
  const batcher = createChatBatcher({ windowMs: 30 });
  const a = batcher.push('wxid_a', { text: 'a', msg_id: 'm1' });
  const b = batcher.push('wxid_b', { text: 'b', msg_id: 'm2' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.payload.text, 'a');
  assert.equal(rb.payload.text, 'b');
  assert.equal(ra.count, 1);
});
