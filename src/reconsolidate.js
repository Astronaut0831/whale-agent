'use strict';

/**
 * 自动再巩固：用户明确纠正时，模型判断“旧事实是什么、新事实是什么”，
 * 然后推翻旧值、写入新值。只在主人私聊触发（调用方负责门禁）。
 */

const memories = require('./memories');

const CUE_RE = /(不对|不是|其实是|记错|纠正|说错|改一下|应该是|你搞错)/;

function looksLikeCorrection(text) {
  return CUE_RE.test(String(text || ''));
}

function parseCorrection(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!o || o.correct !== true) return null;
    const newFact = String(o.new_fact || '').trim();
    if (newFact.length < 4) return null;
    const conf = Number(o.confidence);
    return {
      oldHint: String(o.old_hint || '').trim(),
      newFact,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.9,
    };
  } catch {
    return null;
  }
}

const SYSTEM = '判断这句话是否在纠正助手记忆里的一个事实。'
  + '如果是，输出 JSON：{"correct":true,"old_hint":"旧事实的关键词","new_fact":"纠正后的完整事实","confidence":0.0到1.0}；'
  + '否则输出 {"correct":false}。不要解释，不要输出别的字。';

async function autoCorrect({ llm, key, text, embedUrl = '', source = '自动纠正', msgId = '' } = {}) {
  if (!looksLikeCorrection(text)) return { applied: false, reason: 'no-cue' };
  let raw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      raw = await llm.complete({
        system: SYSTEM,
        turns: [{ role: 'user', content: String(text || '').slice(0, 300) }],
        maxTokens: 500,
        skipGovernor: true,
      });
    } catch {
      raw = '';
    }
    if (String(raw || '').trim()) break;
  }
  const parsed = parseCorrection(raw);
  if (!parsed) return { applied: false, reason: 'no-fact' };

  const r = memories.correct(key, { oldText: parsed.oldHint, newText: parsed.newFact });
  await memories.addMany(key, [parsed.newFact], {
    embedUrl,
    source,
    evidences: [{
      quote: String(text || '').slice(0, 200),
      msgIds: msgId ? [String(msgId)] : [],
      confidence: parsed.confidence,
      about: 'user',
    }],
  });
  return { applied: true, superseded: r.superseded, newFact: parsed.newFact, confidence: parsed.confidence };
}

module.exports = { looksLikeCorrection, parseCorrection, autoCorrect };
