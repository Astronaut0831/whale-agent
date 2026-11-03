/** Read prompt context data directly, without depending on the legacy src/ modules. */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './runtime.js';

function items(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function itemText(x) {
  if (typeof x === 'string') return x;
  return String((x && x.text) || '');
}

export function prefsBlock({ max = 12, dataDir = path.join(repoRoot, 'data') } = {}) {
  const list = items(path.join(dataDir, 'preferences.json')).slice(-max);
  const lines = list.map(itemText).filter(Boolean).map((x) => '- ' + x);
  if (!lines.length) return '';
  return '\n\n【主人定下的规矩】（全局生效，跟谁说话都算数）\n' + lines.join('\n');
}

export function selfnoteBlock({ n = 5, dataDir = path.join(repoRoot, 'data') } = {}) {
  const list = items(path.join(dataDir, 'selfnotes.json')).slice(-n);
  const lines = list.map(itemText).filter(Boolean).map((x) => '- ' + x);
  if (!lines.length) return '';
  return '\n\n【你对自己的认识】（隔了一段时间才想起来，别当口头禅反复说）\n' + lines.join('\n');
}
