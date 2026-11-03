'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memories = require('../src/memories');
const { looksLikeCorrection, parseCorrection, autoCorrect } = require('../src/reconsolidate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-recon-'));
memories.setDataDir(tmp);
const key = 'wechat:u:master';

test('识别纠正语气', () => {
  assert.equal(looksLikeCorrection('不对，其实是6月2日'), true);
  assert.equal(looksLikeCorrection('今天天气不错'), false);
});

test('解析模型纠正 JSON', () => {
  const r = parseCorrection('{"correct":true,"old_hint":"生日","new_fact":"小八生日是6月2日","confidence":0.95}');
  assert.equal(r.newFact, '小八生日是6月2日');
  assert.equal(r.confidence, 0.95);
  assert.equal(parseCorrection('{"correct":false}'), null);
});

test('自动纠正会推翻旧值并写入新值', async () => {
  await memories.addMany(key, ['小八生日是5月1日'], { embedUrl: null, evidences: [{ quote: '旧话', confidence: 0.8 }] });
  const llm = {
    complete: async () => '{"correct":true,"old_hint":"生日","new_fact":"小八生日是6月2日","confidence":0.95}',
  };
  const r = await autoCorrect({ llm, key, text: '不对，小八生日其实是6月2日', embedUrl: '', msgId: 'm_1' });
  assert.equal(r.applied, true);
  assert.ok(r.superseded >= 1);
  const active = memories.listFacts(key).filter((x) => String(x.text).includes('小八'));
  assert.equal(active.length, 1);
  assert.match(String(active[0].text), /6月2日/);
  assert.equal(active[0].confidence, 0.95);
});

test('没有纠正语气时不调模型', async () => {
  let called = 0;
  const llm = { complete: async () => { called += 1; return '{"correct":false}'; } };
  const r = await autoCorrect({ llm, key, text: '今天天气不错' });
  assert.equal(r.applied, false);
  assert.equal(called, 0);
});
