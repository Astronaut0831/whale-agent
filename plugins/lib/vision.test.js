import test from 'node:test';
import assert from 'node:assert/strict';
import { maskKey, sniffMime, status } from './vision.js';
test('vision helpers work outside legacy src', () => {
  assert.equal(typeof maskKey('abcdef123456'),'string');
  assert.equal(typeof sniffMime(Buffer.from([0xff,0xd8,0xff,0xdb])),'string');
  assert.equal(typeof status({}),'object');
});
