'use strict';

/**
 * 原句级出处：在一条消息里找与事实最匹配的句子/分句，返回文本和 span 偏移。
 * 只做定位，不做改写。
 */

const SENT_RE = /[^。！？!?；;\n]+[。！？!?；;]?/g;
const CLAUSE_RE = /[^，,]+[，,]?/g;

function norm(s) {
  return String(s || '').replace(/[\s，。！？；：、,.!?;:（）()【】\[\]“”"'']/g, '');
}

function bigrams(s) {
  const t = norm(s);
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function overlapScore(fact, seg) {
  const a = bigrams(fact);
  const b = bigrams(seg);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / Math.min(a.size, 8);
}

function trimSpan(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return { text: text.slice(s, e).slice(0, 120), start: s, end: e };
}

function bestSpan(fact, message) {
  const text = String(message || '');
  if (!text.trim()) return { text: '', start: 0, end: 0, score: 0 };
  const cands = [];
  let m;
  SENT_RE.lastIndex = 0;
  while ((m = SENT_RE.exec(text))) {
    if (!m[0].trim()) continue;
    cands.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
    // 句子太长时，再按逗号切分句
    if (m[0].length > 24) {
      let c;
      CLAUSE_RE.lastIndex = 0;
      while ((c = CLAUSE_RE.exec(m[0]))) {
        if (!c[0].trim()) continue;
        cands.push({ raw: c[0], start: m.index + c.index, end: m.index + c.index + c[0].length });
      }
    }
  }
  if (!cands.length) return { ...trimSpan(text, 0, text.length), score: 0 };

  let best = null;
  for (const c of cands) {
    const score = overlapScore(fact, c.raw);
    if (!best || score > best.score || (score === best.score && c.raw.length > best.raw.length)) {
      best = { ...c, score };
    }
  }
  if (!best || best.score === 0) {
    // 没匹配上：取句子级最长的（而不是整条消息），仍保证可读
    const longest = cands.reduce((a, b) => (b.raw.length > a.raw.length ? b : a), cands[0]);
    const sp = trimSpan(text, longest.start, longest.end);
    return { ...sp, score: 0 };
  }
  const sp = trimSpan(text, best.start, best.end);
  return { ...sp, score: best.score };
}

module.exports = { bestSpan, overlapScore };
