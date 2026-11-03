'use strict';

/** 离线巩固：模型判重与失败回退。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memories = require('../src/memories');
const mc = require('../src/memoryConsolidate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cons-'));
memories.setDataDir(tmp);
const key = 'wechat:g:md@chatroom';
const logger = { info() {}, warn() {} };

test('模型判断重复时合并近义事实', async () => {
  await memories.addMany(key, ['小美的猫叫团子', '小美养了只猫叫团子', '完全无关：今天下雨了'], { embedUrl: null });
  const llm = {
    complete: async () => '[{"id":1,"same":true,"keep":"A","reason":"同一只猫"}]',
  };
  const r = await mc.runOnce({ config: { paths: { dataDir: tmp } }, llm, logger });
  assert.ok(r.modelMerged >= 1, '模型应合并一对');
  const active = memories.listFacts(key).filter((x) => String(x.text).includes('团子'));
  assert.equal(active.length, 1, '近义事实只留一条');
});

test('模型失败时不乱合并', async () => {
  const key2 = 'wechat:g:fail@chatroom';
  await memories.addMany(key2, ['小红的狗叫旺财', '小红养了只狗叫旺财'], { embedUrl: null });
  const llm = { complete: async () => { throw new Error('model down'); } };
  const r = await mc.runOnce({ config: { paths: { dataDir: tmp } }, llm, logger });
  assert.equal(r.modelMerged, 0, '模型失败不应合并');
  const active = memories.listFacts(key2).filter((x) => String(x.text).includes('旺财'));
  assert.equal(active.length, 2, '两条都保留，等下次判断');
});

test('模型合并时采用合并文本', async () => {
  const key3 = 'wechat:g:merged@chatroom';
  await memories.addMany(key3, ['小蓝喜欢猫', '小蓝养了一只猫'], { embedUrl: null });
  const llm = {
    complete: async () => '[{"id":1,"same":true,"keep":"A","merged":"小蓝喜欢猫，并且养了一只猫","reason":"同一件事"}]',
  };
  const r = await mc.runOnce({ config: { paths: { dataDir: tmp } }, llm, logger });
  assert.ok(r.modelMerged >= 1, '应合并一对');
  const active = memories.listFacts(key3).filter((x) => String(x.text).includes('小蓝'));
  assert.equal(active.length, 1, '合并后只留一条');
  assert.match(String(active[0].text), /养了一只猫/, '应使用合并文本');
});
