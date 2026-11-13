import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuard } from './services.mjs';

test('qq transport requires OneBot', () => {
  assert.deepEqual(
    startGuard('qq-transport', { onebot: false, bridgeRunning: false }),
    { ok: false, status: 409, error: 'SnowLuma OneBot 未在线：先打开 5099 登录并启动 OneBot' },
  );
});

test('wechat bridge requires explicit confirmation', () => {
  assert.equal(
    startGuard('wechat-bridge', { onebot: true, bridgeRunning: false }).status,
    400,
  );
});

test('wechat bridge accepts confirmed start', () => {
  assert.equal(
    startGuard('wechat-bridge', { onebot: true, bridgeRunning: false }, { confirmBotWindow: true }).ok,
    true,
  );
});

test('unknown service is rejected', () => {
  assert.equal(startGuard('rm-rf', { onebot: true, bridgeRunning: false }).status, 400);
});

test('already running is idempotent', () => {
  assert.equal(startGuard('qq-transport', { onebot: false, bridgeRunning: true }).alreadyRunning, true);
});
