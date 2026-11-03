import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMemoryTools } from '../lib/memory-tools.js';

test('注册三个记忆工具并带上 scope', async () => {
  const tools = [];
  const calls = [];
  const ctx = { tools: { register: (t) => tools.push(t) } };
  const ok = registerMemoryTools(ctx, {
    memoryUrl: 'http://mem',
    token: 't',
    scope: 'wechat:u:m1',
    isMaster: true,
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ items: [{ text: '甲喜欢羽毛球' }] }) };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(tools.map((t) => t.name), ['memory_recall', 'memory_add', 'memory_correct']);

  const recall = tools.find((t) => t.name === 'memory_recall');
  const out = await recall.execute({ query: '甲喜欢什么' });
  assert.ok(JSON.stringify(out).includes('羽毛球'));
  assert.equal(calls[0].body.scope, 'wechat:u:m1');
  assert.equal(calls[0].body.isMaster, true);
});
