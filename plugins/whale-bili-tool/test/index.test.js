import test from 'node:test';
import assert from 'node:assert/strict';
import { bvidOf, registerBiliTool } from './index.js';

test('bvidOf accepts Bilibili URLs and bare BV ids', () => {
  assert.equal(bvidOf('https://www.bilibili.com/video/BV1PF4g6ME26'), 'BV1PF4g6ME26');
  assert.equal(bvidOf('BV1PF4g6ME26'), 'BV1PF4g6ME26');
  assert.equal(bvidOf('not a video'), '');
});

test('bili tool registers once per agent context', () => {
  const tools = [];
  const ctx = { tools: { register: (t) => tools.push(t) } };
  assert.equal(registerBiliTool(ctx), true);
  assert.equal(registerBiliTool(ctx), false);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'bili_watch');
});
