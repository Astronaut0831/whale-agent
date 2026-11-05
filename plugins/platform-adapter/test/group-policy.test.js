import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGroupPolicy } from '../lib/group-policy.js';

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-group-'));
  const history = { load: () => overrides.history || [] };
  const policy = createGroupPolicy({
    config: {
      persona: { master: { wxids: ['master'] } },
      group: { scoreMode: true, cooldownSec: 0, addressedCooldownSec: 0, ...overrides.group },
    },
    history,
    stateFile: path.join(dir, 'state.json'),
    now: () => overrides.now || 1000000,
    rng: () => overrides.rng ?? 0.99,
  });
  return { dir, policy };
}

test('@/点名优先，且 addressed 冷却生效', async () => {
  const { dir, policy } = setup({ group: { addressedCooldownSec: 3 } });
  assert.equal((await policy.shouldWake({ chatId: 'g1', text: '在吗', atMe: true, senderId: 'u1' })).wake, true);
  policy.recordReply({ chatId: 'g1' });
  const second = await policy.shouldWake({ chatId: 'g1', text: '在吗', atMe: true, senderId: 'u1' });
  assert.equal(second.wake, false);
  assert.equal(second.reason, 'cooldown');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('问号、明确叫她说话会唤醒', async () => {
  const { dir, policy } = setup();
  assert.equal((await policy.shouldWake({ chatId: 'g1', text: '？', senderId: 'u1' })).reason, 'question_mark');
  assert.equal((await policy.shouldWake({ chatId: 'g1', text: '鲸鲸出来说句话', senderId: 'u1' })).reason, 'directed');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('没人叫她、低分时不接', async () => {
  const { dir, policy } = setup({
    history: [
      { role: 'user', text: '今天吃什么', uid: 'a', name: '甲' },
      { role: 'user', text: '随便', uid: 'b', name: '乙' },
      { role: 'user', text: '甲你去买', uid: 'a', name: '甲' },
      { role: 'user', text: '乙你做饭', uid: 'b', name: '乙' },
    ],
  });
  const out = await policy.shouldWake({ chatId: 'g1', text: '我下午去图书馆', senderId: 'c' });
  assert.equal(out.wake, false);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
