'use strict';

/**
 * 墓碑（tombstone）：用户明确说"别记"之后，同一句话不许再被写回记忆。
 *
 * 设计：
 * - 只存指纹（sha1）+ 短标签，不存原文
 * - 按会话隔离（群里的遗忘不影响私聊）
 * - 主人创建的永久；群友创建的 180 天后失效
 * - 总量上限 5000，超了先淘汰最老的群友墓碑
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let FILE = path.join(__dirname, '..', 'data', 'tombstones.json');
const MAX = 5000;
const MEMBER_TTL_DAYS = 180;

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'tombstones.json');
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
    fs.writeFileSync(FILE, JSON.stringify(d), 'utf8');
  } catch { /* 失败不影响主流程 */ }
}

function norm(x) {
  return String(x || '').replace(/[\s，。！？、；：""''（）()【】\[\]·…—]/g, '').toLowerCase();
}

function hashOf(text) {
  return crypto.createHash('sha1').update(norm(text)).digest('hex');
}

/** 写一条墓碑 */
function add(text, { scope = '', by = 'member' } = {}) {
  const t = String(text || '').trim();
  if (t.length < 2) return null;
  const h = hashOf(t);
  const d = load();
  const hit = d.items.find((x) => x.h === h && String(x.s || '') === String(scope || ''));
  if (hit) {
    hit.ts = Date.now();
    hit.by = by;
    save(d);
    return hit;
  }
  const item = { h, l: t.slice(0, 12), ts: Date.now(), s: String(scope || ''), by };
  d.items.push(item);
  d.items = prune(d.items);
  save(d);
  return item;
}

/** 淘汰：先清过期群友墓碑，再按上限淘汰最老的群友墓碑 */
function prune(items) {
  const now = Date.now();
  const ttl = MEMBER_TTL_DAYS * 24 * 3600 * 1000;
  let out = items.filter((x) => x.by === 'master' || now - Number(x.ts || 0) < ttl);
  if (out.length > MAX) {
    const members = out.filter((x) => x.by !== 'master').sort((a, b) => Number(a.ts) - Number(b.ts));
    const masters = out.filter((x) => x.by === 'master');
    const allowed = Math.max(0, MAX - masters.length);
    out = masters.concat(members.slice(-allowed));
  }
  return out;
}

/** 是否命中墓碑（同会话；包含关系也算命中） */
function hit(text, scope = '') {
  const d = load();
  const n = norm(text);
  if (!n) return false;
  return d.items.some((x) => {
    if (String(x.s || '') !== String(scope || '')) return false;
    const a = norm(x.l);
    // 只有短标签可用，做双向包含判断
    return a && (n.includes(a) || a.includes(n));
  });
}

/** 从一批文本里过滤掉命中的 */
function filter(texts, scope = '') {
  return (texts || []).filter((t) => !hit(t, scope));
}

function stats() {
  const d = load();
  return { total: d.items.length, master: d.items.filter((x) => x.by === 'master').length };
}

module.exports = { add, hit, filter, stats, prune, setDataDir, load, hashOf, norm };
