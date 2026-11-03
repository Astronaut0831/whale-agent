'use strict';

/**
 * 行为参数（她自己可调，有边界、有审计、可重置）。
 * 存在 data/behavior.json，覆盖 config.json 的默认值。
 */

const fs = require('node:fs');
const path = require('node:path');

let FILE = path.join(__dirname, '..', 'data', 'behavior.json');

const DEFAULTS = {
  mergeWindowMs: 900,        // 连发合并窗口
  addressedCooldownSec: 3,   // 群聊里被 @ 后的冷却
  maxBubbles: 2,             // 最多连发几条
  engagedMinutes: 6,         // 接话窗口时长
};

const BOUNDS = {
  mergeWindowMs: [0, 3000],
  addressedCooldownSec: [0, 30],
  maxBubbles: [1, 4],
  engagedMinutes: [1, 30],
};

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'behavior.json');
}

function loadRaw() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function clamp(key, value) {
  const b = BOUNDS[key];
  if (!b) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(b[0], Math.min(b[1], Math.round(n)));
}

function get(key) {
  if (!(key in BOUNDS)) return undefined;
  const raw = loadRaw()[key];
  if (raw === undefined) return DEFAULTS[key];
  const v = clamp(key, raw);
  return v === null ? DEFAULTS[key] : v;
}

function set(key, value) {
  if (!(key in BOUNDS)) return { ok: false, msg: '不支持的参数：' + key };
  const v = clamp(key, value);
  if (v === null) return { ok: false, msg: '数值不合法' };
  const data = loadRaw();
  const old = get(key);
  data[key] = v;
  data._updatedAt = Date.now();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 1), 'utf8');
  try {
    fs.appendFileSync(path.join(path.dirname(FILE), 'behavior.log'), `[${new Date().toLocaleString('zh-CN')}] ${key}: ${old} → ${v}\n`, 'utf8');
  } catch { /* 审计日志失败不影响生效 */ }
  return { ok: true, key, old, value: v };
}

function reset() {
  try { fs.unlinkSync(FILE); } catch { /* 没有就算了 */ }
  return all();
}

function all() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = get(k);
  return out;
}

module.exports = { setDataDir, get, set, reset, all, DEFAULTS, BOUNDS };
