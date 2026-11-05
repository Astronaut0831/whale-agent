import test from 'node:test';
import assert from 'node:assert/strict';
import { pingPayload } from '../index.js';

test('ping 返回插件标识', () => {
  assert.deepEqual(pingPayload(), { ok: true, plugin: 'platform-adapter' });
});
