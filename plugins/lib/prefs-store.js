/** Preferences store used by /pref; keeps the same data/preferences.json shape. */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './runtime.js';

let FILE = path.join(repoRoot, 'data', 'preferences.json');

export function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'preferences.json');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
    return d && Array.isArray(d.items) ? d : { items: [], updatedAt: 0 };
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function all() {
  return load().items || [];
}

export async function add(text, { source = '', ts = Date.now() } = {}) {
  const t = String(text || '').trim().slice(0, 120);
  if (!t) return null;
  const data = load();
  const idx = data.items.findIndex((x) => String(x.text || '') === t);
  const item = { text: t, source, ts, vector: null };
  if (idx >= 0) data.items[idx] = { ...data.items[idx], ...item };
  else data.items.push(item);
  if (data.items.length > 200) data.items = data.items.slice(-200);
  data.updatedAt = Date.now();
  save(data);
  return item;
}

export function removeByIndex(n) {
  const data = load();
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= data.items.length) return null;
  const [gone] = data.items.splice(i, 1);
  data.updatedAt = Date.now();
  save(data);
  return gone || null;
}
