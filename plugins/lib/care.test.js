import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindows, inWindows, careDue, pickTemplate } from './care.js';
test('care logic works outside legacy src', () => {
  const w=parseWindows('00:00-24:00'); assert.ok(Array.isArray(w)); assert.equal(typeof inWindows(Date.now(),w),'boolean'); assert.equal(typeof pickTemplate(),'string');
  assert.equal(typeof careDue({}, {}),'object');
});
