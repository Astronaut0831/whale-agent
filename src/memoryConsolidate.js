'use strict';

/**
 * 夜间离线巩固：
 *   1) 机械合并“几乎一模一样”的事实（高阈值，避免误伤）；
 *   2) 边界情况（相似但措辞不同）交给模型判断是否同一件事；
 *   3) 清理长期低价值条目。
 * 默认每天 03:00 后跑一次；由 server 启动。
 *
 * 模型调用说明：上游对批量 JSON 请求会偶发返回空内容，
 * 所以按 3 对一批 + 最多 4 次重试；空批次直接放弃，绝不猜。
 */

const fs = require('node:fs');
const path = require('node:path');
const memories = require('./memories');

let started = false;

function dataDirOf(runtime) {
  return (runtime && runtime.config && runtime.config.paths && runtime.config.paths.dataDir)
    || path.join(__dirname, '..', 'data');
}

function statePath(dir) {
  return path.join(dir, 'memory-consolidate-state.json');
}

function simScore(a, b) {
  const ab = memories.keywordScore(a, b);
  const ba = memories.keywordScore(b, a);
  return (ab + ba) / 2;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEDUPE_SYSTEM = '判断每一对是否在说同一件事（重复，或互相矛盾）。'
  + '只输出 JSON 数组：[{"id":1,"same":true,"keep":"A"或"B","merged":"合并后的一句事实","reason":"不超过15字"}]。'
  + 'same 为 true 时，用 merged 把两边的关键信息合成一句不超过 50 字的话（保留细节，不要丢信息）。'
  + '不确定就 same:false。不要解释，不要输出别的字。';

async function judgeBatch(runtime, key, batch) {
  const listing = batch
    .map((p, k) => `${k + 1}. A：${p.a}\n   B：${p.b}`)
    .join('\n');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const raw = await runtime.llm.complete({
        system: DEDUPE_SYSTEM,
        turns: [{ role: 'user', content: listing }],
        maxTokens: 1500,
        skipGovernor: true,
      });
      if (String(raw || '').trim()) return String(raw);
    } catch (e) {
      if (runtime.logger && runtime.logger.debug) {
        runtime.logger.debug('[记忆巩固] ' + key + ' 第 ' + (attempt + 1) + ' 次判重失败：' + (e && e.message));
      }
    }
    await sleep(500);
  }
  return '';
}

async function modelDedupe(runtime, key, items) {
  if (!runtime || !runtime.llm || typeof runtime.llm.complete !== 'function') {
    return { merged: 0, skipped: true };
  }
  const maxPairs = Number((runtime.config.memory || {}).consolidateMaxPairs) || 18;
  const active = (items || []).filter((x) => (x.state || 'active') === 'active' && x.text);
  const pairs = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const s = simScore(active[i].text, active[j].text);
      if (s >= 0.2 && s < 0.9) pairs.push({ i, j, s });
    }
  }
  if (!pairs.length) return { merged: 0 };
  pairs.sort((a, b) => b.s - a.s);
  const use = pairs.slice(0, maxPairs);

  let merged = 0;
  let emptyBatches = 0;
  for (let start = 0; start < use.length; start += 3) {
    const batch = use.slice(start, start + 3);
    const raw = await judgeBatch(runtime, key, batch.map((p) => ({ a: active[p.i].text, b: active[p.j].text })));
    if (!raw) {
      emptyBatches += 1;
      continue;
    }
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) continue;
    let arr = [];
    try { arr = JSON.parse(m[0]); } catch { continue; }
    for (const v of Array.isArray(arr) ? arr : []) {
      const local = batch[Number(v && v.id) - 1];
      if (!local || v.same !== true) continue;
      const a = active[local.i];
      const b = active[local.j];
      if ((a.state || 'active') !== 'active' || (b.state || 'active') !== 'active') continue;
      const keep = String(v.keep || 'A').toUpperCase() === 'B' ? b : a;
      const drop = keep === a ? b : a;
      const mergedText = String(v.merged || '').trim();
      if (mergedText.length >= 4) {
        const dropped = String(drop.text || '');
        const nums = dropped.match(/\d+|[一二三四五六七八九十]+/g) || [];
        const missing = nums.filter((n) => !mergedText.includes(n));
        const finalText = missing.length ? (mergedText + '；' + dropped).slice(0, 180) : mergedText;
        memories.updateTextById(key, keep.id, finalText);
      }
      const done = memories.supersedeById(key, drop.id, 'model-consolidation', keep.id);
      if (done) merged += 1;
    }
  }
  if (runtime.logger) {
    runtime.logger.info('[记忆巩固] ' + key + ' 候选 ' + use.length + ' 对 / 合并 ' + merged
      + ' / 空批次 ' + emptyBatches);
  }
  return { merged, emptyBatches };
}

async function runOnce(runtime) {
  const dir = dataDirOf(runtime);
  memories.setDataDir(dir);
  const keys = Object.keys((memories.load() || {}).sessions || {});
  let merged = 0;
  let modelMerged = 0;
  let pruned = 0;
  let failed = 0;
  let replayedTotal = 0;
  const detail = [];
  for (const key of keys) {
    try {
      const mech = memories.consolidate(key, { simThreshold: 0.9, numberRule: false });
      merged += mech.merged;
      pruned += mech.pruned;
      pruned += memories.applyForgetting(key);
      const facts = memories.listFacts(key);
      const md = await modelDedupe(runtime, key, facts);
      modelMerged += md.merged || 0;
      // 睡眠期显著性重放：优先强化高情绪/高价值事实
      const replay = memories.salientForReplay(key, { limit: 5 });
      const replayed = memories.reinforce(replay.map((x) => x.id));
      replayedTotal += replayed;
      if (mech.merged || (md.merged || 0) || replayed) {
        detail.push({ key, mechanical: mech.merged, model: md.merged || 0, replayed });
      }
    } catch (e) {
      failed += 1;
    }
  }
  if (runtime && runtime.logger) {
    runtime.logger.info('[记忆巩固] 会话 ' + keys.length + ' 个：机械合并 ' + merged
      + ' / 模型合并 ' + modelMerged + ' / 重放 ' + replayedTotal + ' / 清理 ' + pruned + ' / 失败会话 ' + failed);
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({
      lastDay: new Date().toISOString().slice(0, 10),
      at: Date.now(),
      keys: keys.length,
      merged,
      modelMerged,
      replayed: replayedTotal,
      pruned,
      detail,
    }), 'utf8');
  } catch { /* ignore */ }
  return { keys: keys.length, merged, modelMerged, replayed: replayedTotal, pruned, failed, detail };
}

function start(runtime) {
  if (started) return;
  started = true;
  const hourCfg = Number((runtime.config.memory || {}).consolidateHour);
  const hour = Number.isFinite(hourCfg) ? hourCfg : 3;
  const tick = () => {
    try {
      const dir = dataDirOf(runtime);
      let st = {};
      try { st = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) || {}; } catch { /* first */ }
      const today = new Date().toISOString().slice(0, 10);
      if (st.lastDay === today) return;
      if (new Date().getHours() < hour) return;
      runOnce(runtime).catch((e) => {
        runtime.logger && runtime.logger.warn && runtime.logger.warn('[记忆巩固] 失败：' + (e && e.message));
      });
    } catch (e) {
      runtime.logger && runtime.logger.warn && runtime.logger.warn('[记忆巩固] 跳过：' + (e && e.message));
    }
  };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, 30 * 60 * 1000);
}

module.exports = { start, runOnce, modelDedupe };
