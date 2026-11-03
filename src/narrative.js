'use strict';

/**
 * 叙事线：把各会话的摘要按时间并成一条，带来源标签。
 * 记忆主体统一（洛克的记忆连续性），但披露仍按观众隔离（戈夫曼）。
 */

const fs = require('node:fs');
const path = require('node:path');

let FILE = path.join(__dirname, '..', 'data', 'narrative.json');
const MAX = 400;

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'narrative.json');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { items: Array.isArray(d.items) ? d.items : [] };
  } catch {
    return { items: [] };
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

/** 摘要跑完后追加一条（同会话的连续摘要合并成一条，避免碎） */
function append({ session, title = '', chatType = 'group', lines = [], from = 0, to = 0, count = 0 }) {
  const texts = (lines || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8);
  if (!texts.length) return null;
  const d = load();
  const last = d.items[d.items.length - 1];
  const now = Date.now();
  if (last && last.session === session && now - Number(last.at || 0) < 60 * 60 * 1000) {
    last.lines = last.lines.concat(texts).slice(-12);
    last.at = now;
    last.title = title || last.title;
    save(d);
    return last;
  }
  const item = { at: now, session, title, chatType, lines: texts, from: Number(from) || 0, to: Number(to) || 0, count: Number(count) || 0 };
  d.items.push(item);
  if (d.items.length > MAX) d.items = d.items.slice(-MAX);
  save(d);
  return item;
}

/** 最近的叙事（可按会话过滤/排除），用于提示词注入 */
function recent(limit = 6, { exclude = '', only = '' } = {}) {
  const d = load();
  return d.items
    .filter((x) => (only ? x.session === only : true))
    .filter((x) => (exclude ? x.session !== exclude : true))
    .slice(-limit)
    .reverse();
}

function stats() {
  const d = load();
  return { total: d.items.length, sessions: new Set(d.items.map((x) => x.session)).size };
}

module.exports = { append, recent, stats, setDataDir, load };
