import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScope } from '../index.js';

const CONFIG = { targetSessionId: 'session-target', scope: 'gui:whale' };

test('env scope 优先，保持微信 headless 行为', () => {
  assert.equal(resolveScope('session-other', CONFIG, 'wechat:u:owner'), 'wechat:u:owner');
  assert.equal(resolveScope('session-target', CONFIG, 'wechat:g:g1'), 'wechat:g:g1');
});

test('无 env 时只有目标 session 命中', () => {
  assert.equal(resolveScope('session-target', CONFIG, ''), 'gui:whale');
  assert.equal(resolveScope('session-other', CONFIG, ''), '');
  assert.equal(resolveScope(undefined, CONFIG, ''), '');
});

test('没有 targetSessionId 时 GUI 不生效', () => {
  assert.equal(resolveScope('session-target', { scope: 'gui:whale' }, ''), '');
});

test('目标命中但 scope 为空时返回空，不写空 scope', () => {
  assert.equal(resolveScope('session-target', { targetSessionId: 'session-target' }, ''), '');
});
