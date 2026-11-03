import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScope, resolveIsMaster } from '../index.js';

test('isMaster 只由配置或 env 决定，不默认 true', () => {
  assert.equal(resolveIsMaster({}, {}), false);
  assert.equal(resolveIsMaster({}, { WHALE_IS_MASTER: '1' }), true);
  assert.equal(resolveIsMaster({}, { WHALE_IS_MASTER: '0' }), false);
  assert.equal(resolveIsMaster({ isMaster: true }, { WHALE_IS_MASTER: '0' }), true);
  assert.equal(resolveIsMaster({ isMaster: false }, { WHALE_IS_MASTER: '1' }), false);
});

const CONFIG = { targetSessionId: 'session-target', scope: 'gui:whale' };

test('env scope 优先，微信 headless 不变', () => {
  assert.equal(resolveScope({ session: { id: 'session-other' } }, CONFIG, 'wechat:u:owner'), 'wechat:u:owner');
});

test('无 env 时只给目标 session 注册', () => {
  assert.equal(resolveScope({ session: { id: 'session-target' } }, CONFIG, ''), 'gui:whale');
  assert.equal(resolveScope({ session: { id: 'session-other' } }, CONFIG, ''), '');
  assert.equal(resolveScope({}, CONFIG, ''), '');
});

test('没有 targetSessionId 时 GUI 不生效', () => {
  assert.equal(resolveScope({ session: { id: 'session-target' } }, { scope: 'gui:whale' }, ''), '');
});
