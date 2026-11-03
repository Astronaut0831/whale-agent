'use strict';

/** 模型拆条：语义拆分、失败回退、保留元数据。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitFacts, isCompound, ruleSplit } = require('../src/factSplit');

test('识别复合事实', () => {
  assert.equal(isCompound('她约定别三点熬夜；小八生日作废'), true);
  assert.equal(isCompound('她喜欢猫，养了一只橘色的猫，还给它取名叫团子，每天都要抱一会儿'), true);
  assert.equal(isCompound('复旦大一'), false);
});

test('模型拆条保留 about/msg', async () => {
  const llm = {
    complete: async () => '[{"id":1,"facts":["她约定主人别三点熬夜","小八生日是6月2日"]}]',
  };
  const out = await splitFacts(llm, [
    { fact: '她约定主人别三点熬夜；小八生日是6月2日', about: 'relation', msg: 3 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].about, 'relation');
  assert.equal(out[1].msg, 3);
});

test('模型失败时按分号兜底', async () => {
  const llm = { complete: async () => { throw new Error('down'); } };
  const compound = '甲喜欢苹果；乙喜欢香蕉；丙喜欢橘子';
  const out = await splitFacts(llm, [{ fact: compound, about: 'user', msg: 1 }]);
  assert.deepEqual(out.map((x) => x.fact), ruleSplit(compound));
  assert.equal(out[0].about, 'user');
});
