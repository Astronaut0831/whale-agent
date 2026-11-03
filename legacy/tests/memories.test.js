'use strict';

/**
 * 统一记忆（src/memories.js）：召回、隐私隔离、覆盖、删除、预算的基线测试。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memories = require('../src/memories');
const tombstones = require('../src/tombstones');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-'));
memories.setDataDir(tmp);
tombstones.setDataDir(tmp);

const A = 'wechat:g:groupA@chatroom';
const B = 'wechat:g:groupB@chatroom';
const P = 'wechat:u:master';

test('同会话能召回自己写的事实', async () => {
  await memories.addMany(A, ['张三喜欢打羽毛球'], { embedUrl: null });
  const block = await memories.blockFor(A, '张三喜欢什么运动', { topK: 4 });
  assert.match(String(block), /羽毛球/);
});

test('群与群之间隔离', async () => {
  await memories.addMany(B, ['李四在B群说过他怕辣'], { embedUrl: null });
  const own = await memories.blockForAudience(B, '李四怕什么', { topK: 4, isMaster: false });
  assert.match(String(own.text || ''), /怕辣/);
  const leak = await memories.blockForAudience(A, '李四怕什么', { topK: 4, isMaster: false });
  assert.doesNotMatch(String(leak.text || ''), /怕辣/);
});

test('主人私聊可跨会话回忆', async () => {
  const r = await memories.blockForAudience(P, '张三喜欢什么运动', { topK: 4, isMaster: true });
  assert.match(String(r.text || ''), /羽毛球/);
});

test('同一主体新值覆盖旧值', async () => {
  await memories.addMany(A, ['王五的生日是3月1日'], { embedUrl: null });
  await memories.addMany(A, ['王五的生日是4月2日'], { embedUrl: null });
  const facts = memories.listFacts(A).map((x) => String(x.text));
  const active = facts.filter((t) => t.includes('生日'));
  assert.ok(active.some((t) => t.includes('4月2日')), '应包含新值');
  assert.equal(active.filter((t) => t.includes('3月1日')).length, 0, '旧值应被标记覆盖');
});

test('删除后不再召回', async () => {
  await memories.addMany(A, ['赵六养了一只叫豆豆的猫'], { embedUrl: null });
  const hit = memories.listFacts(A).find((x) => String(x.text).includes('豆豆'));
  assert.ok(hit, '应先存在');
  memories.removeAt(A, hit.id);
  const block = await memories.blockFor(A, '赵六的猫叫什么', { topK: 4 });
  assert.doesNotMatch(String(block), /豆豆/);
});

test('topK 预算生效', async () => {
  await memories.addMany(A, ['事实一：苹果', '事实二：香蕉', '事实三：橘子'], { embedUrl: null });
  const r = await memories.blockForWithItems(A, '水果', { topK: 1 });
  assert.ok((r.items || []).length <= 1);
});

test('事实带出处与置信度', async () => {
  await memories.addMany(A, ['周七的生日是9月9日'], {
    embedUrl: null,
    evidences: [{ quote: '周七：我9月9过生日', msgIds: ['m_1'], confidence: 0.9 }],
  });
  const f = memories.listFacts(A).find((x) => String(x.text).includes('周七'));
  assert.ok(f, '应写入成功');
  assert.equal(f.quote, '周七：我9月9过生日');
  assert.deepEqual(f.msgIds, ['m_1']);
  assert.equal(f.confidence, 0.9);
});

test('情感/承诺事实获得更高显著性', async () => {
  await memories.addMany(A, ['桌上有三个杯子'], { embedUrl: null });
  await memories.addMany(A, ['主人今天很焦虑，睡不着'], { embedUrl: null });
  await memories.addMany(A, ['我们约定不把这件事告诉别人'], { embedUrl: null });
  const neutral = memories.listFacts(A).find((x) => String(x.text).includes('杯子'));
  const emo = memories.listFacts(A).find((x) => String(x.text).includes('焦虑'));
  const commit = memories.listFacts(A).find((x) => String(x.text).includes('约定'));
  assert.ok(neutral && emo && commit, '三类事实都应存在');
  assert.ok(emo.importance > neutral.importance, '情感事实应高于中性事实');
  assert.ok(commit.importance > neutral.importance, '承诺事实应高于中性事实');
});

test('近义事实召回时互相抑制', async () => {
  await memories.addMany(A, [
    '主人叫李益凯，是最高权限者',
    '主人是李益凯，权限最高',
    '李益凯是主人，最高权限',
    '主人的名字叫李益凯',
  ], { embedUrl: null });
  const r = await memories.blockForWithItems(A, '李益凯是谁', { topK: 4 });
  const texts = (r.items || []).map((x) => String(x.text));
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const ab = memories.keywordScore(texts[i], texts[j]);
      const ba = memories.keywordScore(texts[j], texts[i]);
      assert.ok(!(ab >= 0.6 && ba >= 0.6), '召回应避免近义重复：' + texts[i] + ' | ' + texts[j]);
    }
  }
  const facts = memories.listFacts(A).filter((x) => String(x.text).includes('李益凯'));
  assert.ok(facts.some((x) => Number(x.recallPenalty) > 0), '被抑制项应记录惩罚');
});

test('纠正会推翻旧事实并写入新值', async () => {
  await memories.addMany(A, ['小八的生日是5月1日'], { embedUrl: null });
  const r = memories.correct(A, { oldText: '小八的生日', newText: '小八的生日是6月2日' });
  assert.ok(r.superseded >= 1, '旧事实应被标记推翻');
  await memories.addMany(A, ['小八的生日是6月2日'], {
    embedUrl: null,
    evidences: [{ quote: '小八：我6月2过生日', msgIds: ['m_2'], confidence: 0.95 }],
  });
  const active = memories.listFacts(A).filter((x) => String(x.text).includes('小八的生日'));
  assert.equal(active.length, 1, '只剩新值');
  assert.match(String(active[0].text), /6月2日/);
  assert.equal(active[0].quote, '小八：我6月2过生日');
});

test('离线巩固合并近义事实', async () => {
  await memories.addMany(A, ['巩固测试：猫叫豆豆', '巩固测试：猫的名字是豆豆'], {
    embedUrl: null,
    importances: [0.9, 0.3],
  });
  const r = memories.consolidate(A, { simThreshold: 0.5 });
  assert.ok(r.merged >= 1, '应合并近义条目');
  const active = memories.listFacts(A).filter((x) => String(x.text).startsWith('巩固测试'));
  assert.equal(active.length, 1, '只保留一条');
  assert.match(String(active[0].text), /猫叫豆豆/, '保留高重要性的那条');
});

test('召回会强化事实（提取练习）', async () => {
  await memories.addMany(A, ['钱九喜欢下围棋'], { embedUrl: null });
  await memories.blockForWithItems(A, '钱九喜欢什么', { topK: 2 });
  const f = memories.listFacts(A).find((x) => String(x.text).includes('钱九'));
  assert.ok(Number(f.useCount) >= 1, '应记录使用次数');
  assert.ok(Number(f.lastUsedAt) > 0, '应记录最近使用时间');
});

test('置信度高的记忆优先召回', async () => {
  await memories.addMany(A, ['甲喜欢喝咖啡'], {
    embedUrl: null,
    evidences: [{ quote: '', msgIds: [], confidence: 0.2 }],
  });
  await memories.addMany(A, ['乙喜欢喝咖啡'], {
    embedUrl: null,
    evidences: [{ quote: '', msgIds: [], confidence: 0.95 }],
  });
  const r = await memories.blockForWithItems(A, '喜欢喝咖啡', { topK: 2 });
  assert.match(String((r.items[0] || {}).text || ''), /乙/, '高置信度应排前');
});

test('跨会话召回带来源与低置信提示', async () => {
  await memories.addMany(B, ['郑十怕打雷'], {
    embedUrl: null,
    evidences: [{ quote: '郑十：我怕打雷', msgIds: ['m_9'], confidence: 0.4 }],
  });
  const r = await memories.blockForAudience(P, '郑十怕什么', { topK: 3, isMaster: true });
  assert.match(String(r.text), /来自/);
  assert.match(String(r.text), /置信0\.4/);
});

test('召回后安排间隔复习', async () => {
  await memories.addMany(A, ['孙十的生日是10月10日'], { embedUrl: null, importances: [0.9] });
  await memories.blockForWithItems(A, '孙十生日', { topK: 2 });
  const f = memories.listFacts(A).find((x) => String(x.text).includes('孙十'));
  assert.ok(Number(f.reviewCount) >= 1, '应记录复习次数');
  assert.ok(Number(f.nextReviewAt) > Date.now(), '应安排下次复习');
});

test('到期复习可取并标记', async () => {
  await memories.addMany(A, ['周十喜欢下棋'], { embedUrl: null, importances: [0.9] });
  const file = path.join(tmp, 'memories.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const it = d.sessions[A].items.find((x) => String(x.text).includes('周十'));
  it.nextReviewAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(d, null, 1));
  const due = memories.dueForReview({ minImportance: 0.6 });
  assert.ok(due.some((x) => String(x.text).includes('周十')), '到期应被取出');
  const hit = due.find((x) => String(x.text).includes('周十'));
  memories.markReviewed(hit.id);
  const after = memories.dueForReview({ minImportance: 0.6 });
  assert.ok(!after.some((x) => String(x.text).includes('周十')), '标记后应推迟');
});

test('情景元数据与时间线', async () => {
  await memories.addMany(A, ['吴十喜欢看海'], { embedUrl: null });
  const tl = memories.timeline(A, { limit: 5 });
  const hit = tl.find((x) => String(x.text).includes('吴十'));
  assert.ok(hit, '时间线应包含');
  assert.ok(hit.episode && hit.episode.session === A, '应带 episode');
  assert.ok(hit.when && hit.where, '应有 when/where');
});

test('重放会小幅强化重要性', async () => {
  await memories.addMany(A, ['郑十二怕高'], { embedUrl: null, importances: [0.9] });
  const before = memories.listFacts(A).find((x) => String(x.text).includes('郑十二'));
  const n = memories.reinforce([before.id], { factor: 1.1 });
  assert.equal(n, 1);
  const after = memories.listFacts(A).find((x) => String(x.text).includes('郑十二'));
  assert.ok(after.importance > before.importance, '重要性应提升');
  assert.equal(after.replayCount, 1);
});

test('适应性遗忘淘汰长期低价值事实', async () => {
  await memories.addMany(A, ['冯十提过一次雨伞'], { embedUrl: null, importances: [0.05] });
  const file = path.join(tmp, 'memories.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const it = d.sessions[A].items.find((x) => String(x.text).includes('冯十'));
  it.ts = Date.now() - 100 * 24 * 3600 * 1000;
  it.importance = 0.05;
  it.useCount = 0;
  fs.writeFileSync(file, JSON.stringify(d, null, 1));
  const n = memories.applyForgetting(A);
  assert.ok(n >= 1, '应淘汰低价值旧事实');
  const left = memories.listFacts(A).find((x) => String(x.text).includes('冯十'));
  assert.equal(left, undefined, '不应再出现在 active');
});

test('同主体共享数值的重复会被巩固合并', async () => {
  await memories.addMany(A, ['小九的生日是6月2日', '小九：生日6月2日，之前误记成5月1日'], {
    embedUrl: null,
    importances: [0.8, 0.3],
  });
  const r = memories.consolidate(A, { simThreshold: 0.99 });
  assert.ok(r.merged >= 1, '共享多个数值应判为重复');
});
