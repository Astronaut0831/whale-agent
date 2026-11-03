'use strict';

/**
 * L4 自我认知（selfNote）
 *
 * 前三层记的都是"对方"，这一层记的是"她自己"：
 *   "我好像越来越会等他说完再回了"
 *
 * 关键设计（照搬参考项目的经验）：
 * - 不每轮注入：只在"隔了很久重新说话"或新会话第一次唤醒时读一次，等于"想起来"
 * - 上限 40 条，同一句重复写只刷新时间
 * - 由她自己写，不是主人灌输
 */

const fs = require('node:fs');
const path = require('node:path');

let FILE = path.join(__dirname, '..', 'data', 'selfnotes.json');
const MAX = 40;

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'selfnotes.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

function save(d) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(d), 'utf8');
  } catch { /* ignore */ }
}

/** 写一条自我观察（同文本只刷新时间） */
function add(text, { source = 'digest' } = {}) {
  const t = String(text || '').trim().replace(/^["'“”]|["'“”]$/g, '').slice(0, 80);
  if (t.length < 4) return null;
  const d = load();
  const idx = d.items.findIndex((x) => x.text === t);
  if (idx >= 0) d.items[idx].ts = Date.now();
  else d.items.push({ text: t, ts: Date.now(), source });
  if (d.items.length > MAX) d.items = d.items.slice(-MAX);
  d.updatedAt = Date.now();
  save(d);
  return t;
}

/** 取最近几条（注入用） */
function recent(n = 5) {
  const d = load();
  return d.items.slice(-n).map((x) => x.text);
}

/** 拼接成 prompt 块；没有就返回空串 */
function block(n = 5) {
  const items = recent(n);
  if (!items.length) return '';
  return '\n\n【你对自己的认识】（隔了一段时间才想起来，别当口头禅反复说）\n'
    + items.map((x) => '- ' + x).join('\n');
}

function count() {
  return load().items.length;
}

module.exports = { add, recent, block, count, setDataDir, load };
