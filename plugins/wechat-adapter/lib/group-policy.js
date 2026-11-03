/** 群聊注意力策略：原样调用旧 bot 的 src/attention.js，补上冷却/上限/灰区。 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);
let attention = null;
try { attention = localRequire('../../../src/attention.js'); } catch { /* fallback below */ }

const DIRECTED = /(来(给|和)?(大家|群里|群友)?说|跟大家(说|聊)|开麦|说句话|出来说|你说两句)/;

export function createGroupPolicy({ config = {}, history, stateFile, now = Date.now, rng = Math.random, judge = null, behavior = null } = {}) {
  const group = config.group || {};
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { /* first */ }
  const save = () => { try { fs.mkdirSync(stateFile.replace(/[\\/][^\\/]+$/, ''), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8'); } catch { /* ignore */ } };
  const keyOf = (msg) => String(msg.chatId || '');
  const get = (msg) => state[keyOf(msg)] || (state[keyOf(msg)] = { lastReplyAt: 0, replyTimes: [] });

  const shouldWake = async (msg) => {
    const t = now();
    const s = get(msg);
    const text = String(msg.text || '').trim();
    const atMe = Boolean(msg.atMe || msg.replyToBot);
    const isMaster = String(msg.senderId || '') === String((config.persona && config.persona.master && config.persona.master.wxids && config.persona.master.wxids[0]) || '');
    const addressed = atMe;

    if (addressed) {
      if (Number(s.silentUntil) > t && group.muteIgnoresAt === true) return { wake: false, reason: 'silent' };
      const behaviorCd = behavior && typeof behavior.get === 'function' ? behavior.get('addressedCooldownSec') : undefined;
      const cd = Number(behaviorCd ?? group.addressedCooldownSec ?? 3) * 1000;
      if (s.lastReplyAt && t - s.lastReplyAt < cd) return { wake: false, reason: 'cooldown' };
      s.silentUntil = 0;
      return { wake: true, reason: 'addressed', score: null };
    }
    if (/^[?？]+$/.test(text)) return { wake: true, reason: 'question_mark', score: null };
    if (DIRECTED.test(text)) return { wake: true, reason: 'directed', score: null };
    if (Number(s.silentUntil) > t) return { wake: false, reason: 'silent' };
    if (isMaster && group.masterAlwaysReply === true) return { wake: true, reason: 'master', score: null };

    const cd = Number(group.cooldownSec ?? 20) * 1000;
    const tooSoon = s.lastReplyAt && t - s.lastReplyAt < cd;
    const cap = Number(group.maxRepliesPerHour || 0);
    if (cap > 0 && !isMaster) {
      s.replyTimes = (s.replyTimes || []).filter((x) => Number(x) > t - 3600 * 1000);
      if (s.replyTimes.length >= cap) return { wake: false, reason: 'hourly_cap' };
    }
    if (group.requireAt === false && !tooSoon) return { wake: true, reason: 'require_at_off' };

    if (group.scoreMode !== false && attention) {
      try {
        const hist = history ? history.load(msg.chatId, 40).filter((m) => !msg.msgId || String(m.msgId) !== String(msg.msgId)) : [];
        const { score, detail } = attention.scoreMessage({
          text, atMe, history: hist, weights: group.attentionWeights || {},
        });
        const baseHI = Number(group.scoreHigh) || 1.0;
        const baseLO = Number(group.scoreLow) || 0.3;
        const talk = String(s.talkativeness || 'normal');
        const bias = talk === 'quiet' ? 0.15 : talk === 'chatty' ? -0.15 : 0;
        const HI = baseHI + bias;
        const LO = Math.max(0.01, baseLO + bias * 0.5);
        const out = { score, detail };
        if (detail.lastWasHer && detail.isQuestion) return { wake: true, reason: 'followup_question', ...out };
        if (score >= HI) return { wake: true, reason: 'score_high', ...out };
        if (score < LO) return { wake: false, reason: 'score_low', ...out };
        // 灰区：旧 bot 用模型判断这句话是不是在跟她说
        if (group.grayJudge !== false && typeof judge === 'function') {
          try {
            const v = await judge({ chatId: msg.chatId, history: hist, senderName: msg.senderName, text });
            if (v && v.toBot) return { wake: true, reason: 'score_gray_model', ...out };
            return { wake: false, reason: 'score_gray_model_skip', ...out };
          } catch { /* fall through to probability */ }
        }
        const p = (score - LO) / Math.max(0.0001, HI - LO);
        if (rng() < p) return { wake: true, reason: 'score_gray', ...out };
        return { wake: false, reason: 'score_gray_miss', ...out };
      } catch { /* fall through to free chat */ }
    }
    if (group.freeChat && rng() < Math.max(0, Math.min(1, Number(group.freeChatChance) || 0))) {
      if (!tooSoon) return { wake: true, reason: 'free_chat', score: null };
    }
    return { wake: false, reason: text ? 'not_addressed' : 'no_text', score: null };
  };

  const recordReply = (msg) => {
    const s = get(msg);
    const t = now();
    s.lastReplyAt = t;
    s.replyTimes = (s.replyTimes || []).concat(t).filter((x) => Number(x) > t - 3600 * 1000).slice(-100);
    save();
  };

  const observe = (msg) => {
    if (!history) return;
    history.observe({
      chatId: msg.chatId, role: 'user', text: msg.text, name: msg.senderName,
      uid: msg.senderId, msgId: msg.msgId, ts: msg.ts,
    });
  };
  const observeReply = (msg, text) => {
    if (!history) return;
    history.observe({
      chatId: msg.chatId, role: 'assistant', text, name: '她', uid: 'bot', msgId: 'a_' + String(msg.msgId), ts: Date.now(),
    });
  };

  const mute = (chatId, minutes = 30) => {
    const s = get({ chatId });
    const t = now();
    s.silentUntil = t + Math.max(1, Number(minutes) || 30) * 60000;
    s.silentReason = 'mute';
    save();
    return s.silentUntil;
  };
  const unmute = (chatId) => {
    const s = get({ chatId });
    s.silentUntil = 0;
    s.silentReason = '';
    save();
  };
  const setTalk = (chatId, level) => {
    const s = get({ chatId });
    s.talkativeness = ['quiet', 'normal', 'chatty'].includes(level) ? level : 'normal';
    save();
    return s.talkativeness;
  };
  const getTalk = (chatId) => get({ chatId }).talkativeness || 'normal';
  const isMuted = (chatId) => Number(get({ chatId }).silentUntil) > now();

  return { shouldWake, recordReply, observe, observeReply, mute, unmute, setTalk, getTalk, isMuted };
}
