/** Behavior knobs (bounded, audited, resettable) without the legacy src/ module. */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './runtime.js';

let FILE = path.join(repoRoot, 'data', 'behavior.json');

const DEFAULTS = {
  mergeWindowMs: 900,
  addressedCooldownSec: 3,
  maxBubbles: 2,
  engagedMinutes: 6,
};

const BOUNDS = {
  mergeWindowMs: [0, 3000],
  addressedCooldownSec: [0, 30],
  maxBubbles: [1, 4],
  engagedMinutes: [1, 30],
};

export function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'behavior.json');
}

function loadRaw() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
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

export function get(key) {
  if (!(key in BOUNDS)) return undefined;
  const raw = loadRaw()[key];
  if (raw === undefined) return DEFAULTS[key];
  const v = clamp(key, raw);
  return v === null ? DEFAULTS[key] : v;
}

export function set(key, value) {
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
  } catch { /* audit failure must not block */ }
  return { ok: true, key, old, value: v };
}

export function reset() {
  try { fs.unlinkSync(FILE); } catch { /* absent */ }
  return all();
}

export function all() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = get(k);
  return out;
}

export { DEFAULTS, BOUNDS };
