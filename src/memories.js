'use strict';

/**
 * 长期记忆库（检索式，混合打分）
 *
 * 设计对齐"结构化记忆 + 按需检索"：
 * - 原子事实存储，带时间戳与来源
 * - 召回 = 0.65 * 向量相似度 + 0.35 * 关键词命中（名字、黑话靠后者）
 * - 再乘时间衰减（越久远权重越低，但没有硬过期）
 * - 同一主体出现新说法时，旧条目标记 superseded（保留 provenance，不再召回）
 */

const fs = require('node:fs');
const path = require('node:path');
const embed = require('./embed');
const tombstones = require('./tombstones');

let FILE = path.join(__dirname, '..', 'data', 'memories.json');

const DEDUPE_COS = 0.82;
const MAX_PER_SESSION = 600;
const DAY = 24 * 3600 * 1000;

// 向量压成 base64 Float32（JSON 数字太占地方：单条 512 维约 10KB → 2.7KB）
const B64 = 'b64:';
function packVec(v) {
  if (!v || !v.length) return null;
  try {
    const arr = v instanceof Float32Array ? v : Float32Array.from(v);
    return B64 + Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
  } catch { return null; }
}

function unpackVec(x) {
  if (!x) return null;
  if (x instanceof Float32Array) return x;
  if (Array.isArray(x)) return Float32Array.from(x);
  if (typeof x === 'string' && x.startsWith(B64)) {
    const buf = Buffer.from(x.slice(B64.length), 'base64');
    const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float32Array(copy);
  }
  return null;
}

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'memories.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { sessions: {}, updatedAt: 0 };
  }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data), 'utf8');
  } catch { /* 存不下来不影响聊天 */ }
}

/** 中文按二元组 + 英文/数字按词，做关键词召回 */
function tokens(text) {
  const s = String(text || '').toLowerCase().replace(/[\s，,。.！!？?：:；;、~～…（）()【】\[\]"'“”‘’]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  return out;
}

function keywordScoreRaw(query, fact) {
  const q = tokens(query);
  const f = tokens(fact);
  if (!q.size || !f.size) return 0;
  let hit = 0;
  for (const t of q) if (f.has(t)) hit += 1;
  return hit / q.size;
}

/** 原句与同义扩展句各算一次，取高分，避免扩展词稀释原查询 */
function keywordScore(query, fact) {
  const base = keywordScoreRaw(query, fact);
  const expanded = expandQuery(query);
  if (expanded === query) return base;
  return Math.max(base, keywordScoreRaw(expanded, fact) * 0.9);
}

/** 主体：冒号前的名字，用来做"新说法覆盖旧说法" */
const EMO_RE = /(喜欢|讨厌|爱|恨|害怕|怕|焦虑|失眠|难过|伤心|开心|高兴|生气|气死|烦|恶心|心痛|在乎|思念|想|哭|崩溃|压力|考试|期考)/g;
const COMMIT_RE = /(约定|答应|一定|必须|不能|别|禁|记住|承诺|保密|发誓|说好)/g;
const SELF_RE = /(我|主人|Astronaut|自己|本鲸)/g;

/** 情感/承诺/自我相关带来的显著性加成（0~1） */
function salienceBoost(text) {
  const t = String(text || '');
  const emo = Math.min(1, ((t.match(EMO_RE) || []).length) * 0.25 + (/[!！]/.test(t) ? 0.1 : 0));
  const commit = Math.min(1, ((t.match(COMMIT_RE) || []).length) * 0.3);
  const self = Math.min(1, ((t.match(SELF_RE) || []).length) * 0.2);
  return Math.max(emo, commit * 0.9, self * 0.6);
}

const SYNONYMS = {
  竞赛: ['省一', '省队', '国集', '数学竞赛', '排名', '名次'],
  成绩: ['排名', '名次', '绩点', '省一', '分数'],
  焦虑: ['担心', '压力', '失眠', '内耗', '怕'],
  喜欢: ['偏好', '爱听', '软话', '中意'],
  熬夜: ['三点', '半夜', '失眠', '通宵'],
  迁移: ['搬家', '搬走', '架构', '换框架'],
  生日: ['出生', '哪天', '日期'],
  猫: ['猫咪', '小猫', '养猫'],
};

/** 查询扩展：把同义/相关词补进查询，改善“问法不同就召不回” */
function expandQuery(text) {
  const t = String(text || '');
  let extra = '';
  for (const [k, vals] of Object.entries(SYNONYMS)) {
    if (t.includes(k)) extra += ' ' + vals.join(' ');
  }
  return extra ? t + extra : t;
}

function nearDuplicate(a, b) {
  if (!a || !b) return false;
  const ab = keywordScore(a, b);
  const ba = keywordScore(b, a);
  if (ab >= 0.6 && ba >= 0.6) return true;
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return false;
  return (na.includes(nb) || nb.includes(na)) && Math.min(na.length, nb.length) / Math.max(na.length, nb.length) >= 0.5;
}

function supersedeById(key, id, reason = 'consolidation', mergedInto = '') {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return null;
  const it = sess.items.find((x) => x.id === id && (x.state || 'active') === 'active');
  if (!it) return null;
  it.state = 'superseded';
  it.stateAt = Date.now();
  it.reason = reason;
  if (mergedInto) it.mergedInto = mergedInto;
  data.updatedAt = Date.now();
  save(data);
  return it;
}

function updateTextById(key, id, text) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return null;
  const it = sess.items.find((x) => x.id === id && (x.state || 'active') === 'active');
  const t = String(text || '').trim();
  if (!it || t.length < 4) return null;
  it.text = t;
  it.subject = subjectOf(t);
  it.vector = null;
  it.ts = Date.now();
  it.confidence = Math.max(Number(it.confidence) || 0.5, 0.7);
  data.updatedAt = Date.now();
  save(data);
  return it;
}

function correct(key, { oldText = '', newText = '' } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return { superseded: 0 };
  const hint = String(oldText || '').trim();
  const nt = String(newText || '').trim();
  if (!nt) return { superseded: 0 };
  let n = 0;
  for (const it of sess.items) {
    if ((it.state || 'active') !== 'active') continue;
    const t = String(it.text || '');
    const hit = hint && (t.includes(hint) || keywordScore(t, hint) >= 0.5 || keywordScore(hint, t) >= 0.5);
    if (!hit) continue;
    it.state = 'superseded';
    it.stateAt = Date.now();
    it.reason = 'correction';
    it.correctedBy = nt.slice(0, 60);
    n += 1;
  }
  if (n) {
    data.updatedAt = Date.now();
    save(data);
  }
  return { superseded: n };
}

const REVIEW_INTERVALS = [DAY, 3 * DAY, 7 * DAY, 30 * DAY];

function touchUsed(data, item) {
  const sk = item._session || (item.origin && item.origin.session);
  const sess = sk && data.sessions && data.sessions[sk];
  const orig = sess && Array.isArray(sess.items) ? sess.items.find((i) => i.id === item.id) : null;
  const now = Date.now();
  for (const t of [orig, item]) {
    if (!t) continue;
    t.useCount = (Number(t.useCount) || 0) + 1;
    t.lastUsedAt = now;
    const imp = Number(t.importance) || 0;
    if (imp >= 0.6) {
      const rc = (Number(t.reviewCount) || 0) + 1;
      t.reviewCount = rc;
      t.nextReviewAt = now + REVIEW_INTERVALS[Math.min(rc - 1, REVIEW_INTERVALS.length - 1)];
    }
  }
}

/** 到期需要复习的重要事实（按重要性排序） */
function dueForReview({ now = Date.now(), limit = 3, minImportance = 0.6 } = {}) {
  const data = load();
  const out = [];
  for (const [k, s] of Object.entries(data.sessions || {})) {
    for (const it of s.items || []) {
      if ((it.state || 'active') !== 'active') continue;
      if (Number(it.importance || 0) < minImportance) continue;
      if (!it.nextReviewAt || Number(it.nextReviewAt) > now) continue;
      out.push({ ...it, _session: k });
    }
  }
  out.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
  return out.slice(0, limit);
}

/** 标记复习过：把下次复习时间往后推 */
function markReviewed(id, { now = Date.now(), extraDays = 7 } = {}) {
  const data = load();
  let hit = null;
  for (const s of Object.values(data.sessions || {})) {
    const it = (s.items || []).find((x) => x.id === id);
    if (it) { it.lastReviewedAt = now; it.nextReviewAt = now + extraDays * DAY; hit = it; break; }
  }
  if (hit) { data.updatedAt = now; save(data); }
  return hit;
}

function bumpPenalty(data, item, delta) {
  const sk = item._session || (item.origin && item.origin.session);
  const sess = sk && data.sessions && data.sessions[sk];
  const orig = sess && Array.isArray(sess.items) ? sess.items.find((i) => i.id === item.id) : null;
  const cur = Math.max(0, Math.min(1, Number((orig || item).recallPenalty) || 0));
  const next = Math.max(0, Math.min(1, cur + delta));
  if (orig) orig.recallPenalty = next;
  item.recallPenalty = next;
  return next;
}

function subjectOf(text) {
  const t = String(text || '').trim();
  const m = t.match(/^([^：:]{1,12})[：:]/) || t.match(/^([^，。！？\s]{1,12}?)(?:的|是)/);
  return m ? m[1].trim() : '';
}

/** 同主体、同谓词、不同数值 → 新值覆盖旧值 */
function shouldSupersede(a, b) {
  const sa = subjectOf(a);
  const sb = subjectOf(b);
  if (!sa || sa !== sb) return false;
  const na = numsOf(a);
  const nb = numsOf(b);
  if (!na || !nb || na === nb) return false;
  return keywordScore(a, b) >= 0.5;
}

function newId() {
  return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// 归一化：去标点空格，用于"严格子串"判断
function normText(x) {
  return String(x || '').replace(/[\s，。！？、；：""''（）()【】\[\]·…—]/g, '');
}

const NEG_RE = /(不|没|别|勿|无|未|禁|莫|停止|取消)/g;
function negCount(x) { return (String(x || '').match(NEG_RE) || []).length; }
const NUM_RE = /\d+(?:\.\d+)?|[一二三四五六七八九十百千万零两]+/g;
function numsOf(x) { return (String(x || '').match(NUM_RE) || []).join(','); }

/** 旧数据迁移：补 id / state / provenance */
function ensureSchema(sess) {
  let changed = false;
  (sess.items || []).forEach((it, i) => {
    if (!it.id) { it.id = 'f_legacy_' + i + '_' + String(it.ts || 0).slice(-6); changed = true; }
    if (!it.state) {
      it.state = it.superseded ? 'superseded' : 'active';
      if (it.superseded) { it.stateAt = Number(it.ts || Date.now()); it.reason = 'legacy'; }
      delete it.superseded;
      changed = true;
    }
    if (!it.provenance) {
      it.provenance = { from: '', to: '', count: 0, kind: it.source || 'unknown', confidence: 0.5, speaker: '' };
      changed = true;
    }
    if (!it.about) { it.about = 'other'; changed = true; }
    if (it.quote === undefined) { it.quote = ''; changed = true; }
    if (it.quoteSpan === undefined) { it.quoteSpan = null; changed = true; }
    if (!it.episode) {
      it.episode = {
        session: (it.origin && it.origin.session) || '',
        chatType: (it.origin && it.origin.chatType) || 'private',
        at: Number(it.ts) || Date.now(),
      };
      changed = true;
    }
    if (!Array.isArray(it.msgIds)) { it.msgIds = []; changed = true; }
    if (it.confidence === undefined) {
      it.confidence = Number((it.provenance || {}).confidence) || 0.5;
      changed = true;
    }
    // 统一主体：每条事实都记录来自哪个会话/观众，检索时跨会话可及，披露时按观众过滤
    if (!it.origin) {
      const parts = String(key || '').split(':');
      const chatType = parts[1] === 'g' ? 'group' : 'private';
      it.origin = { session: key, chatType, speakerName: it.provenance.speaker || '', audience: key };
      it.privacy = chatType;
      changed = true;
    }
    if (it.useCount === undefined) { it.useCount = 0; changed = true; }
  });
  return changed;
}

function mergeLog(key, line) {
  try {
    const dir = require('node:path').dirname(FILE);
    require('./logfile').appendLine(
      require('node:path').join(dir, 'memory-merge.log'),
      '[' + new Date().toISOString() + '] ' + key + ' ' + line,
      { maxMB: 5 }
    );
  } catch { /* 日志失败不影响主流程 */ }
}

/** 两条能否合并：否定词/数字不一致一律拒绝；包含关系必须是严格子串 */
function mergeVerdict(a, b, threshold) {
  if (Math.abs(negCount(a) - negCount(b)) > 0) return { ok: false, why: 'negation' };
  const na = numsOf(a); const nb = numsOf(b);
  if (na !== nb && (na || nb)) return { ok: false, why: 'number' };
  const ab = keywordScore(a, b);
  const ba = keywordScore(b, a);
  if (ab >= threshold && ba >= threshold) return { ok: true, why: 'close', ab, ba };
  const sa = normText(a); const sb = normText(b);
  const strict = sa.includes(sb) || sb.includes(sa);
  const shortRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (strict && shortRatio <= 0.8) return { ok: true, why: 'containment', ab, ba };
  return { ok: false, why: 'weak', ab, ba };
}

async function addMany(key, texts, { embedUrl, source = 'digest', importances = null, provenances = null, provenance = null, evidences = null } = {}) {
  let list = (texts || []).map((t) => String(t || '').trim()).filter((t) => t.length >= 4).slice(0, 20);
  // 墓碑：用户说过不想记的，不许再写回来
  list = tombstones.filter(list, key);
  if (!list.length) return { added: 0, merged: 0, superseded: 0 };
  const data = load();
  const sess = data.sessions[key] || { items: [] };
  sess.items = sess.items || [];
  ensureSchema(sess);
  const vecs = await embed.embedTexts(list, { url: embedUrl, timeoutMs: 2000 });
  let added = 0;
  let merged = 0;
  let superseded = 0;
  list.forEach((text, i) => {
    const vec = vecs && vecs[i];
    const rawImp = Array.isArray(importances) ? Number(importances[i]) : NaN;
    const baseImp = Number.isFinite(rawImp) ? Math.max(0, Math.min(1, rawImp)) : 0.5;
    const boost = salienceBoost(text);
    const imp = Math.max(0, Math.min(1, 0.7 * baseImp + 0.3 * boost));
    const prov = (Array.isArray(provenances) ? provenances[i] : null) || provenance
      || { from: '', to: '', count: 0, kind: source, confidence: source === 'manual' ? 1 : 0.7, speaker: '' };
    const ev = (Array.isArray(evidences) ? evidences[i] : null) || {};
    const about = String(ev.about || prov.about || 'other');
    const episode = { session: key, chatType: String(key).split(':')[1] === 'g' ? 'group' : 'private', at: Date.now() };
    const quote = String(ev.quote || prov.quote || '').slice(0, 240);
    const quoteSpan = ev.quoteSpan || null;
    const msgIds = Array.isArray(ev.msgIds) ? ev.msgIds.map(String).filter(Boolean).slice(0, 8)
      : (Array.isArray(prov.msgIds) ? prov.msgIds.map(String).filter(Boolean).slice(0, 8) : []);
    const confRaw = ev.confidence != null ? ev.confidence : prov.confidence;
    const confidence = Number.isFinite(Number(confRaw)) ? Math.max(0, Math.min(1, Number(confRaw))) : (source === 'manual' ? 1 : 0.7);

    let near = -1;
    if (vec) {
      sess.items.forEach((it, idx) => {
        if (it.state !== 'active') return;
        const iv = unpackVec(it.vector);
        if (iv && embed.cosine(vec, iv) > DEDUPE_COS) near = idx;
      });
    }
    if (near >= 0) {
      sess.items[near] = {
        ...sess.items[near],
        text,
        ts: Date.now(),
        vector: vec ? packVec(vec) : sess.items[near].vector,
        source,
        importance: imp,
        about: about || sess.items[near].about || 'other',
        episode: sess.items[near].episode || episode,
        quote: quote || sess.items[near].quote || '',
        quoteSpan: quoteSpan || sess.items[near].quoteSpan || null,
        msgIds: msgIds.length ? msgIds : (sess.items[near].msgIds || []),
        confidence,
        provenance: { ...prov, mergedTimes: Number((sess.items[near].provenance || {}).mergedTimes || 0) + 1 },
      };
      merged += 1;
      return;
    }

    sess.items.forEach((it) => {
      if ((it.state || 'active') !== 'active') return;
      if (shouldSupersede(text, it.text)) {
        it.state = 'superseded';
        it.stateAt = Date.now();
        it.reason = 'contradiction';
        superseded += 1;
      }
    });
    const subj = subjectOf(text);
    const id = newId();
    // 不再用"同主体 + 相似度"自动覆盖：同一个人可以有多条互补事实，
    // 是否推翻交给摘要后的模型仲裁判断（它能看到来源原话）。
    sess.items.push({
      id, text, ts: Date.now(), vector: vec ? packVec(vec) : null, source, subject: subj,
      importance: imp, useCount: 0, lastUsedAt: 0,
      about, quote, quoteSpan, msgIds, confidence, episode,
      state: 'active', provenance: prov, createdAt: Date.now(),
      origin: { session: key, chatType: String(key).split(':')[1] === 'g' ? 'group' : 'private', speakerName: String(prov.speaker || ''), audience: key },
      privacy: String(key).split(':')[1] === 'g' ? 'group' : 'private',
    });
    added += 1;
  });
  if (sess.items.length > MAX_PER_SESSION) {
    // 超量时优先丢非 active 的旧条目
    const dead = sess.items.filter((x) => x.state !== 'active');
    const overflow = sess.items.length - MAX_PER_SESSION;
    if (dead.length >= overflow) {
      const drop = new Set(dead.slice(0, overflow));
      sess.items = sess.items.filter((x) => !drop.has(x));
    } else {
      // 高显著性优先保留：按 importance 取前 N，再维持原顺序
      const ranked = [...sess.items].sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
      const keep = new Set(ranked.slice(0, MAX_PER_SESSION));
      sess.items = sess.items.filter((x) => keep.has(x));
    }
  }
  data.sessions[key] = sess;
  data.updatedAt = Date.now();
  save(data);
  return { added, merged, superseded };
}

/** 混合打分检索：只取 active */
async function search(key, text, { topK = 4, embedUrl, minScore = 0.35 } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !sess.items.length) return [];
  const alive = sess.items.filter((x) => (x.state || 'active') === 'active');
  if (!alive.length) return [];
  const vecs = await embed.embedTexts([String(text || '')], { url: embedUrl, timeoutMs: 1500 });
  const qv = vecs && vecs[0];
  const now = Date.now();
  const scored = alive.map((x) => {
    const xv = unpackVec(x.vector);
    const cos = qv && xv ? embed.cosine(qv, xv) : 0;
    const kw = keywordScore(text, x.text);
    const rel = 0.55 * cos + 0.45 * kw;
    const anchor = Number(x.lastUsedAt || x.ts || now);
    const ageDays = Math.max(0, (now - anchor) / DAY);
    const recency = Math.exp(-ageDays / 30);
    const importance = Number.isFinite(Number(x.importance)) ? Math.max(0, Math.min(1, Number(x.importance))) : 0.5;
    const penalty = Math.max(0, Math.min(1, Number(x.recallPenalty) || 0));
    const conf = Math.max(0, Math.min(1, Number(x.confidence) || 0.5));
    const score = (0.6 * rel + 0.2 * importance + 0.2 * recency - 0.15 * penalty) * (0.8 + 0.2 * conf);
    return { ...x, score, cos, kw, rel, recency, importance, penalty, conf };
  }).sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  const cutoff = Math.max(minScore, best * 0.78);
  const hit = [];
  let dirty = false;
  for (const x of scored) {
    if (x.score < cutoff || hit.length >= topK) break;
    if (hit.some((p) => nearDuplicate(p.text, x.text))) {
      bumpPenalty(data, x, 0.1);
      dirty = true;
      continue;
    }
    hit.push(x);
    bumpPenalty(data, x, -0.05);
    touchUsed(data, x);
    dirty = true;
  }
  if (dirty) save(data);
  return hit;
}

/** 同 blockFor，但把命中的条目一起返回（观测用） */
async function blockForWithItems(key, text, { topK = 4, embedUrl } = {}) {
  const items = await search(key, text, { topK, embedUrl });
  const body = items.length ? '\n\n【你记得的事】（相关优先）\n' + items.map((x) => '- ' + x.text).join('\n') : '';
  return { text: body, items };
}

async function blockFor(key, text, { topK = 4, embedUrl } = {}) {
  const items = await search(key, text, { topK, embedUrl });
  if (!items.length) return '';
  return '\n\n【你记得的事】（相关优先）\n' + items.map((x) => '- ' + x.text).join('\n');
}

// ---- 管理接口 ----

function listFacts(key, { includeAll = false } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return [];
  if (ensureSchema(sess)) save(data);
  return sess.items
    .map((it, i) => ({ index: i, ...it }))
    .filter((it) => includeAll || it.state === 'active');
}

function findByRef(sess, ref) {
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 0 && n < sess.items.length && String(ref).trim() !== '') {
    return { index: n, item: sess.items[n] };
  }
  const byId = sess.items.findIndex((x) => x.id === String(ref).trim());
  return byId >= 0 ? { index: byId, item: sess.items[byId] } : null;
}

/** 软删除：只改状态，保留可审计记录 */
function removeAt(key, ref) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return null;
  const hit = findByRef(sess, ref);
  if (!hit) return null;
  hit.item.state = 'deleted';
  hit.item.stateAt = Date.now();
  hit.item.reason = 'user';
  data.updatedAt = Date.now();
  save(data);
  return hit.item;
}

function removeByText(key, needle) {
  const n = String(needle || '').trim();
  if (!n) return null;
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return null;
  const it = sess.items.find((x) => x.state === 'active' && String(x.text || '').includes(n));
  if (!it) return null;
  it.state = 'deleted';
  it.stateAt = Date.now();
  it.reason = 'user';
  data.updatedAt = Date.now();
  save(data);
  return it;
}

/** 恢复被删/被取代的条目 */
function restore(key, ref) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return null;
  const hit = findByRef(sess, ref);
  if (!hit) return null;
  hit.item.state = 'active';
  hit.item.stateAt = Date.now();
  hit.item.reason = 'restored';
  delete hit.item.linkedTo;
  data.updatedAt = Date.now();
  save(data);
  return hit.item;
}

/** 一条事实的完整档案 */
function detail(key, ref) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return null;
  if (ensureSchema(sess)) save(data);
  const hit = findByRef(sess, ref);
  if (!hit) return null;
  return { index: hit.index, ...hit.item };
}

/** 清理：非 active 的旧条目，超过保留天数或条数就物理删 */
function pruneSuperseded(key, keep = 50, maxAgeDays = 30) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return 0;
  const now = Date.now();
  const dead = sess.items.filter((x) => x.state && x.state !== 'active');
  const tooOld = dead.filter((x) => now - Number(x.stateAt || x.ts || 0) > maxAgeDays * DAY);
  const remaining = dead.filter((x) => !tooOld.includes(x));
  const overflow = remaining.length > keep ? remaining.slice(0, remaining.length - keep) : [];
  const drop = new Set([...tooOld, ...overflow]);
  if (!drop.size) return 0;
  sess.items = sess.items.filter((x) => !drop.has(x));
  data.updatedAt = Date.now();
  save(data);
  return drop.size;
}

function dedupeSession(key, { threshold = 0.8 } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return { marked: 0, skipped: 0, before: 0, after: 0 };
  if (ensureSchema(sess)) save(data);
  const items = sess.items;
  const before = items.length;
  let marked = 0;
  let skipped = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].state !== 'active') continue;
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[j].state !== 'active') continue;
      const a = String(items[i].text || '');
      const b = String(items[j].text || '');
      if (!a || !b) continue;
      const v = mergeVerdict(a, b, threshold);
      if (!v.ok) {
        if (v.why !== 'weak' && Math.min(v.ab, v.ba) >= 0.55) {
          skipped += 1;
          mergeLog(key, '跳过合并(' + v.why + ')：' + a.slice(0, 30) + ' ｜ ' + b.slice(0, 30));
        }
        continue;
      }
      const keepJ = (b.length > a.length) || (b.length === a.length && Number(items[j].ts || 0) >= Number(items[i].ts || 0));
      const olderIdx = keepJ ? i : j;
      const newerIdx = keepJ ? j : i;
      if (items[olderIdx].state === 'active') {
        items[olderIdx].state = 'merged';
        items[olderIdx].stateAt = Date.now();
        items[olderIdx].reason = 'dedupe:' + v.why;
        items[olderIdx].linkedTo = items[newerIdx].id;
        marked += 1;
        mergeLog(key, '合并(' + v.why + ')：' + items[olderIdx].text.slice(0, 40) + ' → ' + items[newerIdx].text.slice(0, 40));
      }
    }
  }
  if (marked) { data.updatedAt = Date.now(); save(data); }
  return { marked, skipped, before, after: items.length };
}

/** 模型仲裁：标为被新说法取代 */
function markObsolete(key, texts, linkedTo = '') {
  const list = (texts || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return 0;
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return 0;
  if (ensureSchema(sess)) save(data);
  let n = 0;
  for (const it of sess.items) {
    if (it.state !== 'active') continue;
    if (list.some((t) => String(it.text || '').includes(t) || t.includes(String(it.text || '')))) {
      it.state = 'superseded';
      it.stateAt = Date.now();
      it.reason = 'arbiter';
      if (linkedTo) it.linkedTo = linkedTo;
      n += 1;
    }
  }
  if (n) { data.updatedAt = Date.now(); save(data); }
  return n;
}

function markUsed(key, texts) {
  const list = (texts || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return 0;
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return 0;
  let n = 0;
  for (const it of sess.items) {
    if (list.includes(String(it.text || ''))) {
      it.lastUsedAt = Date.now();
      it.useCount = Number(it.useCount || 0) + 1;
      n += 1;
    }
  }
  if (n) { data.updatedAt = Date.now(); save(data); }
  return n;
}

/** 跨会话标记"被用到"（用于全局检索的衰减锚点） */
function markUsedGlobal(texts) {
  const list = (texts || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return 0;
  const data = load();
  let n = 0;
  for (const sess of Object.values(data.sessions || {})) {
    for (const it of sess.items || []) {
      if (list.includes(String(it.text || ''))) {
        it.lastUsedAt = Date.now();
        it.useCount = Number(it.useCount || 0) + 1;
        n += 1;
      }
    }
  }
  if (n) { data.updatedAt = Date.now(); save(data); }
  return n;
}

function stats(key) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return { count: 0, active: 0, superseded: 0, merged: 0, deleted: 0 };
  const by = (st) => sess.items.filter((x) => (x.state || 'active') === st).length;
  return { count: sess.items.length, active: by('active'), superseded: by('superseded'), merged: by('merged'), deleted: by('deleted') };
}

/** 观众过滤：自己的会话永远可看；主人私聊可看全部；其他会话只看自己 */
function audienceAllows(item, key, chatType, isMaster) {
  const o = item.origin || {};
  if (o.session === key) return true;
  if (chatType === 'private' && isMaster) return true;
  return false;
}

/** 跨会话检索：同一主体，但按观众过滤披露范围 */
async function blockForAudience(key, text, { topK = 4, embedUrl, isMaster = false, labelOf = null } = {}) {
  const chatType = String(key).split(':')[1] === 'g' ? 'group' : 'private';
  const data = load();
  const pool = [];
  for (const [skey, sess] of Object.entries(data.sessions || {})) {
    for (const it of sess.items || []) {
      if ((it.state || 'active') !== 'active') continue;
      if (!audienceAllows(it, key, chatType, isMaster)) continue;
      pool.push({ ...it, _session: skey });
    }
  }
  if (!pool.length) return { text: '', items: [] };
  const vecs = await embed.embedTexts([String(text || '')], { url: embedUrl, timeoutMs: 1500 });
  const qv = vecs && vecs[0];
  const now = Date.now();
  const scored = pool.map((x) => {
    const xv = unpackVec(x.vector);
    const cos = qv && xv ? embed.cosine(qv, xv) : 0;
    const kw = keywordScore(text, x.text);
    const rel = 0.55 * cos + 0.45 * kw;
    const anchor = Number(x.lastUsedAt || x.ts || now);
    const recency = Math.exp(-Math.max(0, (now - anchor) / DAY) / 30);
    const importance = Number.isFinite(Number(x.importance)) ? x.importance : 0.5;
    // 同一会话的内容略加分（相当于"你刚在这个场景里经历的"更容易被想起）
    const sameCtx = (x.origin && x.origin.session === key) ? 0.08 : 0;
    const penalty = Math.max(0, Math.min(1, Number(x.recallPenalty) || 0));
    const conf = Math.max(0, Math.min(1, Number(x.confidence) || 0.5));
    const score = (0.6 * rel + 0.2 * importance + 0.2 * recency + sameCtx - 0.15 * penalty) * (0.8 + 0.2 * conf);
    return { ...x, score, penalty, conf };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0].score;
  const cutoff = Math.max(0.35, best * 0.78);
  const hit = [];
  let dirty = false;
  for (const x of scored) {
    if (x.score < cutoff || hit.length >= topK) break;
    if (hit.some((p) => nearDuplicate(p.text, x.text))) {
      bumpPenalty(data, x, 0.1);
      dirty = true;
      continue;
    }
    hit.push(x);
    bumpPenalty(data, x, -0.05);
    touchUsed(data, x);
    dirty = true;
  }
  if (dirty) save(data);
  const label = (it) => {
    const o = it.origin || {};
    if (o.session === key) return '';
    if (labelOf) {
      try { const v = labelOf(o.session); if (v) return '来自「' + v + '」：'; } catch { /* ignore */ }
    }
    return '来自另一个会话：';
  };
  const meta = (it) => {
    const bits = [];
    const d = new Date(Number(it.ts) || Date.now());
    bits.push((d.getMonth() + 1) + '-' + d.getDate());
    const conf = Number(it.confidence);
    if (Number.isFinite(conf) && conf < 0.65) bits.push('置信' + conf.toFixed(1));
    return '（' + bits.join('·') + '）';
  };
  const body = hit.length
    ? '\n\n【你记得的事】（相关优先）\n' + hit.map((it) => '- ' + label(it) + it.text + meta(it)).join('\n')
    : '';
  return { text: body, items: hit };
}

function consolidate(key, { simThreshold = 0.55, staleDays = 180, minImportance = 0.25, numberRule = true } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return { merged: 0, pruned: 0, kept: 0 };
  const active = sess.items.filter((x) => (x.state || 'active') === 'active' && x.text);
  const sim = (a, b) => {
    const ab = keywordScore(a, b);
    const ba = keywordScore(b, a);
    if (ab >= simThreshold && ba >= simThreshold) return true;
    // 同主体 + 同数值组合：即使措辞差异大也视为同一件事
    const sa = subjectOf(a);
    const sb = subjectOf(b);
    if (numberRule && sa && sa === sb) {
      const na = numsOf(a);
      const nb = numsOf(b);
      if (na && nb) {
        const A = new Set(na.split(','));
        const B = new Set(nb.split(','));
        let inter = 0;
        for (const t of A) if (B.has(t)) inter += 1;
        if (inter >= 2) return true;
      }
    }
    return false;
  };
  const kept = [];
  let merged = 0;
  for (const x of [...active].sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))) {
    const dup = kept.find((k) => sim(k.text, x.text));
    if (dup) {
      x.state = 'superseded';
      x.stateAt = Date.now();
      x.reason = 'consolidation';
      x.mergedInto = dup.id;
      merged += 1;
      continue;
    }
    kept.push(x);
  }
  const now = Date.now();
  let pruned = 0;
  for (const x of kept) {
    const ageDays = (now - Number(x.lastUsedAt || x.ts || now)) / DAY;
    if (ageDays > staleDays && Number(x.importance || 0.5) < minImportance && Number(x.useCount || 0) === 0) {
      x.state = 'deleted';
      x.stateAt = now;
      x.reason = 'stale';
      pruned += 1;
    }
  }
  if (merged || pruned) {
    data.updatedAt = now;
    save(data);
  }
  return { merged, pruned, kept: kept.length - pruned };
}

function timeline(key, { limit = 10 } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return [];
  return sess.items
    .filter((x) => (x.state || 'active') === 'active')
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    .slice(0, limit)
    .map((x) => ({
      ...x,
      when: new Date(Number(x.ts) || 0).toISOString(),
      where: (x.episode && x.episode.session) || '',
    }));
}

/** 适应性遗忘：按检索价值淘汰长期低价值事实 */
function applyForgetting(key, { now = Date.now(), minAgeDays = 60, threshold = 0.2 } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return 0;
  let n = 0;
  for (const it of sess.items) {
    if ((it.state || 'active') !== 'active' || !it.text) continue;
    const ageDays = (now - Number(it.ts || now)) / DAY;
    if (ageDays <= minAgeDays) continue;
    const recency = Math.exp(-ageDays / 60);
    const useVal = Math.min(1, (Number(it.useCount) || 0) / 5);
    const value = 0.6 * (Number(it.importance) || 0.5) + 0.3 * useVal + 0.1 * recency;
    if (value < threshold) {
      it.state = 'deleted';
      it.stateAt = now;
      it.reason = 'forgotten';
      n += 1;
    }
  }
  if (n) { data.updatedAt = now; save(data); }
  return n;
}

function salientForReplay(key, { limit = 5, minImportance = 0.65 } = {}) {
  const data = load();
  const sess = data.sessions[key];
  if (!sess || !Array.isArray(sess.items)) return [];
  const now = Date.now();
  return sess.items
    .filter((x) => (x.state || 'active') === 'active' && x.text && Number(x.importance || 0) >= minImportance)
    .map((x) => {
      const ageDays = Math.max(0, (now - Number(x.ts || now)) / DAY);
      const freshness = Math.exp(-ageDays / 30);
      const bonus = (Number(x.replayCount) || 0) === 0 ? 0.1 : 0; // 优先重放还没重放过的
      return { ...x, _score: Number(x.importance || 0) * (0.7 + 0.3 * freshness) + bonus };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

/** 重放强化：小幅提升重要性并记录次数（上限 1） */
function reinforce(ids, { factor = 1.03, now = Date.now() } = {}) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) return 0;
  const set = new Set(list.map(String));
  const data = load();
  let n = 0;
  for (const s of Object.values(data.sessions || {})) {
    for (const it of s.items || []) {
      if (!set.has(String(it.id))) continue;
      it.importance = Math.min(1, (Number(it.importance) || 0.5) * factor);
      it.replayCount = (Number(it.replayCount) || 0) + 1;
      it.lastReplayAt = now;
      n += 1;
    }
  }
  if (n) { data.updatedAt = now; save(data); }
  return n;
}

module.exports = {
  blockForAudience, markUsedGlobal,
  blockForWithItems,
  addMany, search, blockFor, stats, setDataDir, load, subjectOf, keywordScore, correct,
  listFacts, removeAt, removeByText, restore, detail, pruneSuperseded, dedupeSession, markObsolete, markUsed, consolidate, supersedeById, updateTextById, dueForReview, markReviewed, salientForReplay, reinforce, timeline, applyForgetting,
};
