
/**
 * 主动性模块
 *  A. 定时提醒：解析「提醒我…」→ 到点主动发消息（只发给主人私聊）
 *  B. 主动关心：从长期记忆里抽事件，让模型自己判断要不要开口
 *  C. 群聊起话题：群安静太久时，自己起一个话题（可联网找），开关由主人控制
 */

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './runtime.js';
import crypto from 'node:crypto';

let FILE = path.join(repoRoot, 'data', 'proactive.json');

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'proactive.json');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      reminders: Array.isArray(d.reminders) ? d.reminders : [],
      counters: d.counters && typeof d.counters === 'object' ? d.counters : {},
      lastCareAt: Number(d.lastCareAt) || 0,
      lastGroupAt: d.lastGroupAt && typeof d.lastGroupAt === 'object' ? d.lastGroupAt : {},
    };
  } catch {
    return { reminders: [], counters: {}, lastCareAt: 0, lastGroupAt: {} };
  }
}

function save(d) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* ignore */ }
}

function today() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
}

function bump(d, key) {
  const day = today();
  d.counters[day] = d.counters[day] || { care: 0, group: {} };
  if (key === 'care') d.counters[day].care = (d.counters[day].care || 0) + 1;
  else if (key.startsWith('group:')) {
    const cid = key.slice(6);
    d.counters[day].group[cid] = (d.counters[day].group[cid] || 0) + 1;
  }
  // 只留最近 7 天
  const keys = Object.keys(d.counters).sort();
  while (keys.length > 7) delete d.counters[keys.shift()];
}

function countToday(d, key) {
  const c = d.counters[today()] || { care: 0, group: {} };
  if (key === 'care') return Number(c.care) || 0;
  return Number((c.group || {})[key.slice(6)]) || 0;
}

// ---------- A. 提醒 ----------

/** 解析「提醒我…」：让模型给出时间点（ISO）和事项 */
async function parseReminder(llm, text, now = new Date()) {
  const system = [
    '把用户这句话解析成一条提醒。只输出 JSON：{"due":"YYYY-MM-DDTHH:mm:ss","what":"不超过30字"}。',
    '按北京时间理解；"明天九点"这种要算出具体日期；说不清时间就输出 {}。',
    '现在是：' + now.toLocaleString('zh-CN', { hour12: false }) + '。',
  ].join('\n');
  const raw = await llm.complete({ system, turns: [{ role: 'user', content: String(text).slice(0, 200) }], maxTokens: 400, skipGovernor: true });
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  if (!o || !o.due || !o.what) return null;
  const due = new Date(String(o.due).replace(' ', 'T'));
  const ts = due.getTime();
  if (!Number.isFinite(ts)) return null;
  // 允许的窗口：1 分钟后 ~ 30 天内
  if (ts < Date.now() + 20 * 1000 || ts > Date.now() + 30 * 24 * 3600 * 1000) return null;
  return { due: ts, what: String(o.what).slice(0, 40) };
}

function addReminder({ chatId, ownerId, due, what }) {
  const d = load();
  const item = { id: 'r_' + crypto.randomBytes(3).toString('hex'), chatId: String(chatId), ownerId: String(ownerId || ''), due: Number(due), what: String(what), createdAt: Date.now(), sent: false };
  d.reminders.push(item);
  d.reminders = d.reminders.filter((x) => !x.sent).concat(d.reminders.filter((x) => x.sent).slice(-50));
  save(d);
  return item;
}

/** 取出到期未发的（并标记已发，避免重复） */
function dueReminders(now = Date.now()) {
  const d = load();
  const out = d.reminders.filter((x) => !x.sent && Number(x.due) <= now);
  if (out.length) {
    for (const x of out) x.sent = true;
    save(d);
  }
  return out;
}

function listReminders() {
  const d = load();
  return d.reminders.filter((x) => !x.sent).sort((a, b) => a.due - b.due);
}

function cancelReminder(idOrTail) {
  const d = load();
  const key = String(idOrTail || '').trim();
  const hit = d.reminders.find((x) => !x.sent && (x.id === key || x.id.endsWith(key)));
  if (!hit) return null;
  hit.sent = true;
  save(d);
  return hit;
}

// ---------- B. 主动关心 ----------

/** 让模型根据记忆决定要不要主动开口；返回 {send, text} */
async function decideCare(llm, { facts, digest, lastTalkAt, now = new Date() }) {
  const factText = (facts || []).slice(0, 15).map((f) => '- ' + String(f.text || '').slice(0, 60)).join('\n');
  const digestText = (digest || []).slice(-8).map((x) => '- ' + String(x).slice(0, 60)).join('\n');
  const system = [
    '你在决定要不要主动给主人发一条微信。像真人一样：不是每次都要发，别打扰、别尬聊。',
    '可以关心他之前提过的事、接着上次的话题、或者分享一件你知道的小事。',
    '只输出 JSON：{"send":true,"text":"一句话（不超过25字，像平时说话）"} 或 {"send":false,"reason":"不超过15字"}。',
    '如果上次聊天就在刚才、或者没有自然的由头，就 send=false。',
  ].join('\n');
  const user = [
    '现在：' + now.toLocaleString('zh-CN', { hour12: false }),
    '上次聊天：' + (lastTalkAt ? Math.round((Date.now() - lastTalkAt) / 60000) + ' 分钟前' : '很久以前'),
    '【你记得的事】\n' + (factText || '（暂无）'),
    '【最近的摘要】\n' + (digestText || '（暂无）'),
  ].join('\n');
  const raw = await llm.complete({ system, turns: [{ role: 'user', content: user }], maxTokens: 400, skipGovernor: true });
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { send: false, reason: 'parse_fail' };
  try {
    const o = JSON.parse(m[0]);
    return { send: o.send === true && Boolean(o.text), text: String(o.text || '').slice(0, 60), reason: String(o.reason || '') };
  } catch {
    return { send: false, reason: 'parse_fail' };
  }
}

function markCareSent() {
  const d = load();
  d.lastCareAt = Date.now();
  bump(d, 'care');
  save(d);
}

function careAllowed(config, now = new Date()) {
  const p = (config && config.proactive) || {};
  const c = p.care || {};
  if (c.enabled === false) return false;
  const h = now.getHours();
  if (h < Number(c.startHour ?? 9) || h >= Number(c.endHour ?? 23)) return false;
  const d = load();
  const careMax = Number(c.maxPerDay ?? 2);
  if (careMax > 0 && countToday(d, 'care') >= careMax) return false;
  if (Date.now() - Number(d.lastCareAt || 0) < Number(c.minGapHours ?? 8) * 3600 * 1000) return false;
  return true;
}

// ---------- C. 群聊起话题 ----------

function groupTopicAllowed(config, chatKey, lastMsgAt, now = new Date()) {
  const p = (config && config.proactive) || {};
  const g = p.group || {};
  if (g.enabled === false) return false;
  const excluded = Array.isArray(g.excludeGroups) ? g.excludeGroups.map(String) : [];
  if (excluded.length && excluded.some((x) => x && String(chatKey || '').includes(x))) return false;
  const h = now.getHours();
  if (h < Number(g.startHour ?? 9) || h >= Number(g.endHour ?? 23)) return false;
  if (lastMsgAt && Date.now() - lastMsgAt < Number(g.minSilenceMinutes ?? 120) * 60000) return false;
  const d = load();
  const groupMax = Number(g.maxPerDay ?? 2);
  if (groupMax > 0 && countToday(d, 'group:' + chatKey) >= groupMax) return false;
  if (Date.now() - Number(d.lastGroupAt[chatKey] || 0) < Number(g.minGapMinutes ?? 180) * 60000) return false;
  return true;
}

function markGroupSent(chatKey) {
  const d = load();
  d.lastGroupAt[chatKey] = Date.now();
  bump(d, 'group:' + chatKey);
  save(d);
}

export {
  setDataDir, load,
  parseReminder, addReminder, dueReminders, listReminders, cancelReminder,
  decideCare, markCareSent, careAllowed,
  groupTopicAllowed, markGroupSent,
};