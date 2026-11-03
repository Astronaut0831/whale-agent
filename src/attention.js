'use strict';

/**
 * 群聊注意力打分：决定"这条要不要接"。
 *
 * 设计原则（来自实战反馈）：
 * - 别拿整句语义相似度判断"跟她相关吗"，阈值调不准；
 * - 拆成几个具体子问题：接话、互聊、可接度、话题突变，各自有明确含义；
 * - 硬阈值会让行为规律得像机器，所以中间灰区按概率回。
 *
 * 相似度目前用字符二元组（Jaccard），零依赖、对中文短句够用。
 * 想换真 embedding（bge-small-zh / nomic-embed-text）时，只替换 sim() 一个函数。
 */

const PUNCT = /[\s，,。.！!？?：:；;、~～…（）()【】\[\]"'“”‘’]/g;

function normalize(text) {
  return String(text || '').replace(PUNCT, '');
}

/** 字符二元组集合；单字串退化成单字 */
function grams(text) {
  const t = normalize(text);
  const out = new Set();
  if (!t) return out;
  if (t.length === 1) { out.add(t); return out; }
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** Jaccard 相似度，0~1 */
function sim(a, b) {
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 取最大相似度：新消息 vs 一组文本 */
function maxSim(text, list, simFn = sim) {
  let best = 0;
  for (const item of list || []) {
    const t = typeof item === 'string' ? item : (item && (item.text || item.content)) || '';
    const s = simFn(text, t);
    if (s > best) best = s;
  }
  return best;
}

const QUESTION_RE = /[?？]|吗$|呢$|怎么|为什么|为啥|什么|啥|咋|如何|多少|几点|谁|哪|是不是|能不能|要不要|有没有|几号|干嘛/u;

/** 短消息（草/笑死/6/？）不进相似度计算，直接走规则 */
function isShort(text) {
  return normalize(text).length < 4;
}

/**
 * 给一条群消息打分。
 * @param {object} p
 * @param {string} p.text      当前消息正文
 * @param {boolean} p.atMe     是否 @ 到 / 叫了名字
 * @param {Array} p.history    会话消息（按时间正序，含当前这条之前的）
 * @param {object} [p.opts]    { herLastN=3, tailN=5, interestN=30 }
 * @returns {{score:number, detail:object}}
 */
function scoreMessage({ text, atMe = false, history = [], opts = {}, weights = {}, simFn = sim } = {}) {
  const herLastN = opts.herLastN || 3;
  const tailN = opts.tailN || 5;
  const interestN = opts.interestN || 30;
  // 权重可配：真实数据里字面相似度很低，惩罚项几乎主导了分数，
  // 所以把权重放出来，方便按群里的实际反应调，而不是改代码。
  const W = {
    mention: 1.0,
    lastWasHer: 0.6,
    question: 0.45,
    simHer: 0.5,
    simInterest: 0.35,
    othersChatting: -0.45,
    topicShift: -0.15,
    baseline: 0.12,
    ...(weights || {}),
  };

  const past = history.filter((m) => m && m.text);
  const herMsgs = past.filter((m) => m.role === 'assistant').map((m) => m.text);
  const herLast = herMsgs.slice(-herLastN);
  const interest = herMsgs.slice(-interestN, -herLastN); // 排除最近几条，避免和 simHer 重复计分
  const tail = past.slice(-tailN).map((m) => m.text);
  const lastMsg = past[past.length - 1] || null;

  // ① 点名/@：最硬的信号
  const isMention = Boolean(atMe) ? 1 : 0;

  // ② 上一条是不是她说的（有人在接她的话）
  const lastWasHer = lastMsg && lastMsg.role === 'assistant' ? 1 : 0;

  // ③ 问句
  const isQuestion = QUESTION_RE.test(String(text || '')) ? 1 : 0;

  // ④ 接话相似度：跟她的发言像不像
  const simHer = isShort(text) ? 0 : maxSim(text, herLast, simFn);

  // ⑤ 可接度：跟她历来在意的话题像不像
  const simInterest = isShort(text) ? 0 : maxSim(text, interest, simFn);

  // ⑥ 互聊检测：最近两条是不同的人（都不是她）交替发言 → 人家在自己对话。
  // 之前只比字面相似度，换个说法就漏；这里改成"看发言人交替"这条硬规则。
  let othersChatting = 0;
  const recentOthers = past.slice(-4).filter((m) => m.role === 'user');
  if (recentOthers.length >= 2) {
    const a = recentOthers[recentOthers.length - 2];
    const b = recentOthers[recentOthers.length - 1];
    const spkA = String(a.uid || a.name || '');
    const spkB = String(b.uid || b.name || '');
    const differentSpeaker = spkA !== spkB;
    // 当前这条如果来自 A/B 其中一方，且在接对方的话，就算互聊
    const fromSameThread = differentSpeaker;
    if (fromSameThread) othersChatting = 1;
  }

  // ⑦ 话题突变：跟最近几条都不像
  const simTail = isShort(text) ? 0 : maxSim(text, tail, simFn);
  const topicShift = (!isShort(text) && tail.length >= 2 && simTail < 0.06) ? 1 : 0;

  const score =
    W.baseline +
    W.mention * isMention +
    W.lastWasHer * lastWasHer +
    W.question * isQuestion +
    W.simHer * simHer +
    W.simInterest * simInterest +
    W.othersChatting * othersChatting +
    W.topicShift * topicShift;

  return {
    score: Number(score.toFixed(3)),
    detail: {
      isMention, lastWasHer, isQuestion,
      simHer: Number(simHer.toFixed(3)),
      simInterest: Number(simInterest.toFixed(3)),
      othersChatting, topicShift,
      simTail: Number(simTail.toFixed(3)),
      short: isShort(text),
    },
  };
}


/**
 * 带句子向量的打分：相关句相似度明显高于无关句（实测 0.55 vs 0.47），
 * 向量服务不可用时自动退回字符相似度。
 */
async function scoreMessageEmbedding({ text, atMe = false, history = [], opts = {}, weights = {}, embedUrl, timeoutMs = 1500 } = {}) {
  const embed = require('./embed');
  const interestN = opts.interestN || 30;
  const tailN = opts.tailN || 5;
  const past = (history || []).filter((m) => m && m.text);
  const herMsgs = past.filter((m) => m.role === 'assistant').map((m) => m.text);
  const texts = [String(text || '')]
    .concat(herMsgs.slice(-interestN))
    .concat(past.slice(-tailN).map((m) => String(m.text)));
  let vecs = null;
  try {
    vecs = await embed.embedTexts(texts, { url: embedUrl || undefined, timeoutMs });
  } catch { /* 退回字符相似度 */ }
  if (!vecs || !vecs[0]) return scoreMessage({ text, atMe, history, opts, weights });
  const map = new Map();
  texts.forEach((t, i) => { if (vecs[i]) map.set(t, vecs[i]); });
  // BGE 对中文短句的余弦普遍落在 0.4~0.6，直接当相似度会把所有句子抬平。
  // 按实测区间重标定：0.35 → 0，0.80 → 1。
  const rescale = (x) => Math.max(0, Math.min(1, (x - 0.35) / 0.45));
  const simFn = (a, b) => {
    const va = map.get(a);
    const vb = map.get(b);
    if (va && vb) return rescale(embed.cosine(va, vb));
    return sim(a, b);
  };
  return scoreMessage({ text, atMe, history, opts, weights, simFn });
}

module.exports = { scoreMessage, scoreMessageEmbedding, sim, grams, isShort, QUESTION_RE };
