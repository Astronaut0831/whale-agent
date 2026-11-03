import test from 'node:test';
import assert from 'node:assert/strict';
import { recallContext } from '../lib/memory-context.js';

test('命中时返回记忆块', async () => {
  const out = await recallContext({
    memoryUrl: 'http://mem', token: 't', scope: 'wechat:u:m1', query: '问',
    fetchImpl: async () => ({ ok: true, json: async () => ({ items: [{ text: '甲喜欢羽毛球' }] }) }),
  });
  assert.match(out, /甲喜欢羽毛球/);
  assert.match(out, /你记得的事/);
});

test('无命中或失败返回空', async () => {
  assert.equal(await recallContext({
    memoryUrl: 'http://mem', scope: 's', query: 'q',
    fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }),
  }), '');
  assert.equal(await recallContext({
    memoryUrl: 'http://mem', scope: 's', query: 'q',
    fetchImpl: async () => { throw new Error('down'); },
  }), '');
});
