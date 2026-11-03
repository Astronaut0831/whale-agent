'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bestSpan } = require('../src/quoteSpan');

test('定位到消息内的原句', () => {
  const msg = '她：别哭啊，这都半夜了。小八的生日是6月2日，不是5月1日。';
  const s = bestSpan('小八的生日是6月2日', msg);
  assert.match(s.text, /6月2日/);
  assert.doesNotMatch(s.text, /别哭/);
  assert.ok(s.start >= 0 && s.end <= msg.length);
  assert.equal(msg.slice(s.start, s.end).trim(), s.text);
});

test('无匹配时返回句子而不是整条消息', () => {
  const msg = '第一句。第二句更长一些但没有关系。第三句。';
  const s = bestSpan('完全无关的内容', msg);
  assert.ok(s.text.length > 0);
  assert.ok(s.text.length < msg.length);
  assert.ok(s.start >= 0);
});
