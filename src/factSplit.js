'use strict';

/**
 * 模型拆条：把复合事实拆成“一条只讲一件事”的原子事实。
 * - 只对疑似复合的事实触发，省 token；
 * - 模型失败/空返回时退回分号规则；
 * - 保留 about / msg / 出处元数据。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 疑似复合：有分号，或较长且包含多个逗号分句 */
function isCompound(fact) {
  const s = String(fact || '').trim();
  if (!s) return false;
  if (/[；;]/.test(s)) return true;
  const commas = (s.match(/[，,]/g) || []).length;
  return s.length >= 28 && commas >= 2;
}

function ruleSplit(fact) {
  return String(fact || '')
    .split(/[；;]/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
    .slice(0, 4);
}

const SYSTEM = '把每条事实拆成若干条“原子事实”：每条只讲一件事，不新增信息，不改原意，保留主语。'
  + '只输出 JSON 数组：[{"id":1,"facts":["…","…"]}]。每条不超过 50 字，不要解释。';

async function splitFacts(llm, items, { enabled = true } = {}) {
  const list = (items || []).filter((x) => x && String(x.fact || '').trim());
  const flagged = list.filter((x) => isCompound(x.fact));
  if (!enabled || !flagged.length) return list;

  const batch = flagged.slice(0, 6);
  const listing = batch.map((x, i) => `${i + 1}. ${String(x.fact).slice(0, 200)}`).join('\n');

  let raw = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      raw = await llm.complete({
        system: SYSTEM,
        turns: [{ role: 'user', content: listing }],
        maxTokens: 2000,
        skipGovernor: true,
      });
    } catch {
      raw = '';
    }
    if (String(raw || '').trim()) break;
    await sleep(400);
  }

  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) {
    // 规则兜底：只拆有分号的
    return list.flatMap((x) => {
      if (!/[；;]/.test(String(x.fact))) return [x];
      return ruleSplit(x.fact).map((fact) => ({ ...x, fact, about: x.about || 'other' }));
    });
  }

  let arr = [];
  try { arr = JSON.parse(m[0]); } catch { return list; }
  const byId = new Map();
  for (const v of Array.isArray(arr) ? arr : []) {
    const idx = Number(v && v.id) - 1;
    const facts = Array.isArray(v && v.facts) ? v.facts.map((t) => String(t || '').trim()).filter((t) => t.length >= 4) : [];
    if (idx >= 0 && idx < batch.length && facts.length) byId.set(batch[idx].fact, facts.slice(0, 4));
  }

  return list.flatMap((x) => {
    const facts = byId.get(x.fact);
    if (!facts) return [x];
    return facts.map((fact) => ({ ...x, fact, about: x.about || 'other' }));
  });
}

module.exports = { isCompound, ruleSplit, splitFacts };
