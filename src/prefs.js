'use strict';

/**
 * 偏好记忆：把"你对她的要求"沉淀成持久偏好，按相关度注入 prompt。
 *
 * 链路：私聊里的反馈 → 提取成一条条偏好 → 向量化存盘
 *      → 每轮把当前消息和偏好做余弦 → 取最相关的几条塞进 prompt
 *
 * 存盘：data/preferences.json（向量和文本一起存，省一次重算）
 */

const fs = require('node:fs');
const path = require('node:path');
const embed = require('./embed');
const vecUtil = require('./vec');

let FILE = path.join(__dirname, '..', 'data', 'preferences.json');

/** 数据目录搬到别的盘时，启动阶段调这个改路径 */
function setDataDir(dir) {
  if (!dir) return;
  FILE = path.join(String(dir), 'preferences.json');
}
const MIN_SCORE = 0.45;   // 低于这个余弦不算相关

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** 加一条偏好（同文本去重，新的覆盖旧的权重） */
async function add(text, { source = '', ts = Date.now() } = {}) {
  const t = String(text || '').trim().slice(0, 120);
  if (!t) return null;
  const data = load();
  // 语义去重：意思一样就别再加一条（向量余弦 > 0.78 视为同一条）
  const vecs0 = await embed.embedTexts([t], { timeoutMs: 1500 });
  const v0 = vecs0 && vecs0[0];
  let near = -1;
  if (v0) {
    data.items.forEach((x, i) => {
      const xv = vecUtil.unpackVec(x.vector);
      if (xv && embed.cosine(v0, xv) > 0.78) near = i;
    });
  }
  const idx = data.items.findIndex((x) => x.text === t);
  const vecs = vecs0;
  const vec = vecs && vecs[0] ? vecs[0] : null;
  const item = { text: t, source, ts, vector: vec ? vecUtil.packVec(vec) : null };
  if (idx >= 0) data.items[idx] = { ...data.items[idx], ...item };
  else if (near >= 0) data.items[near] = { ...data.items[near], ...item };
  else data.items.push(item);
  if (data.items.length > 200) data.items = data.items.slice(-200);
  data.updatedAt = Date.now();
  save(data);
  return item;
}

/** 给一批消息，用模型抽成"偏好"语句 */
async function extractFromMessages(llm, texts, logger) {
  const joined = texts.filter(Boolean).slice(-40).join('\n');
  if (!joined.trim()) return [];
  const system = [
    '从下面这段对话里，抽出**主人对 AI 的长期要求**，写成可以直接执行的短句。',
    '规则：',
    '1) 只抽"以后一直要这样"的，忽略一次性问题；',
    '2) 每条不超过 20 字，动词开头，必须是 AI 能照做的具体行为，例如「说话不超过两句」「别用颜文字」「叫我主人」「回答前先说结论」「不用敬语」；',
    '3) 不要抽象形容词（"温柔""聪明""像人一点"这类没法执行的一律丢掉）；',
    '4) 同一件事只留最清楚的一条。',
    '输出 JSON 数组，元素形如 {"pref":"说话不超过两句"}，最多 5 条；没有就输出 []。不要解释。',
  ].join('\n');
  try {
    const out = await llm.complete({
      system,
      turns: [{ role: 'user', content: joined }],
      maxTokens: 500,
      skipGovernor: true,
    });
    const m = String(out || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return arr.map((x) => String((x && x.pref) || '').trim()).filter(Boolean).slice(0, 5);
  } catch (err) {
    logger && logger.warn && logger.warn('偏好提取失败：' + (err && err.message));
    return [];
  }
}

/** 全部偏好（按时间正序） */
function all() {
  return load().items || [];
}

/** 删掉第 n 条（从 1 开始数，给 /pref del 用） */
function removeByIndex(n) {
  const data = load();
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= data.items.length) return null;
  const [gone] = data.items.splice(i, 1);
  save(data);
  return gone;
}

/**
 * 全部偏好一起写进 prompt 用的一段。
 * 全局生效：不管跟谁说话都带这些要求（不再是"仅主人"）。
 */
function renderAll({ max = 12 } = {}) {
  const items = all();
  if (!items.length) return '';
  const lines = items.slice(-max).map((x) => '- ' + x.text);
  return '\n\n【主人定下的规矩】（全局生效，跟谁说话都算数）\n' + lines.join('\n');
}

/** 按当前消息检索最相关的偏好 */
async function relevant(text, { topK = 3, embedUrl, timeoutMs = 1500 } = {}) {
  const data = load();
  if (!data.items.length) return [];
  const vecs = await embed.embedTexts([String(text || '')], { url: embedUrl, timeoutMs });
  const qv = vecs && vecs[0];
  if (!qv) {
    // 向量服务不可用就退回"最近 2 条"
    return data.items.slice(-2).map((x) => ({ ...x, score: 0 }));
  }
  const scored = data.items
    .map((x) => ({ x, v: vecUtil.unpackVec(x.vector) }))
    .filter((it) => it.v)
    .map((it) => ({ ...it.x, score: embed.cosine(qv, it.v) }))
    .sort((a, b) => b.score - a.score);
  const hit = scored.filter((x) => x.score >= MIN_SCORE).slice(0, topK);
  return hit.length ? hit : [];
}

/** 拼成给模型看的一段（检索版，保留给按话题取用） */
async function blockFor(text, opts = {}) {
  const items = await relevant(text, opts);
  if (!items.length) return '';
  const lines = items.map((x) => '- ' + x.text);
  return '\n\n【主人以前提过的要求】（还在生效，照着做）\n' + lines.join('\n');
}

module.exports = { load, save, add, all, removeByIndex, renderAll, extractFromMessages, relevant, blockFor, setDataDir, get FILE() { return FILE; } };
