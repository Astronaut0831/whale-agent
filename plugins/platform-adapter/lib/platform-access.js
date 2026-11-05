/** Per-platform access policy and observed-but-not-approved chats. */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/runtime.js';

const MAX_ITEMS = 500;
const MAX_SEEN = 500;
let FILE = path.join(repoRoot, 'data', 'platform-access.json');
let SEEN_FILE = path.join(repoRoot, 'data', 'platform-seen.json');

export function setAccessFiles(dir) {
  const base = String(dir || '').trim();
  if (base) {
    FILE = path.join(base, 'platform-access.json');
    SEEN_FILE = path.join(base, 'platform-seen.json');
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* keep adapter alive */ }
}

function cleanIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, MAX_ITEMS);
}

function defaults() {
  return {
    wechat: { groups: [], privates: [] },
    qq: { groups: [], privates: [], allowAllGroups: false, owner: '' },
  };
}

function normalize(input) {
  const d = defaults();
  const src = input && typeof input === 'object' ? input : {};
  for (const platform of Object.keys(d)) {
    const p = src[platform] && typeof src[platform] === 'object' ? src[platform] : {};
    d[platform].groups = cleanIds(p.groups);
    d[platform].privates = cleanIds(p.privates);
    if ('allowAllGroups' in d[platform]) d[platform].allowAllGroups = p.allowAllGroups === true;
    if ('owner' in d[platform]) d[platform].owner = String(p.owner || '').trim().slice(0, 64);
  }
  return d;
}

export function loadAccess() {
  return normalize(readJson(FILE, defaults()));
}

export function getAccess(platform) {
  const all = loadAccess();
  return all[String(platform)] || null;
}

export function updateAccess(platform, patch = {}) {
  const p = String(platform || '').toLowerCase();
  const all = loadAccess();
  if (!all[p]) throw new Error('unknown platform: ' + p);
  if (Array.isArray(patch.groups)) all[p].groups = cleanIds(patch.groups);
  if (Array.isArray(patch.privates)) all[p].privates = cleanIds(patch.privates);
  if ('allowAllGroups' in all[p]) all[p].allowAllGroups = patch.allowAllGroups === true;
  if ('owner' in all[p] && typeof patch.owner === 'string') all[p].owner = patch.owner.trim().slice(0, 64);
  atomic(FILE, all);
  return all[p];
}

export function loadSeen() {
  const d = readJson(SEEN_FILE, {});
  return d && typeof d === 'object' ? d : {};
}

export function recordSeen({ platform, chatType, chatId, name }) {
  const p = String(platform || '').toLowerCase();
  const t = chatType === 'group' ? 'groups' : 'privates';
  const id = String(chatId || '').trim();
  if (!p || !id) return;
  const all = loadSeen();
  const bucket = all[p] && typeof all[p] === 'object' ? all[p] : (all[p] = {});
  const kind = bucket[t] && typeof bucket[t] === 'object' ? bucket[t] : (bucket[t] = {});
  const prev = kind[id] || {};
  kind[id] = { name: String(name || prev.name || ''), lastAt: Date.now(), count: Number(prev.count || 0) + 1 };
  const entries = Object.entries(kind).sort((a, b) => Number(b[1].lastAt || 0) - Number(a[1].lastAt || 0)).slice(0, MAX_SEEN);
  bucket[t] = Object.fromEntries(entries);
  atomic(SEEN_FILE, all);
}
