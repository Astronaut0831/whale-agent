'use strict';

/**
 * 把旧 bot.db 的私聊历史导入 memory episodes。
 *
 * 为什么不直接改 DSH session：DSH session 是内部格式，硬写会把会话弄坏；
 * memory episodes 是统一入口，digest / recall 会自然吸收。
 *
 * 用法：
 *   node tools\import-legacy-history.js --dry-run
 *   node tools\import-legacy-history.js
 *   node tools\import-legacy-history.js --limit=100 --all-scopes
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const dbPath = path.resolve(ROOT, String(args.db || 'data/bot.db'));
const episodesPath = path.resolve(ROOT, String(args.episodes || 'data/memory-episodes.jsonl'));
const privateOnly = args['all-scopes'] !== true;
const dryRun = args['dry-run'] === true;
const limit = Math.max(0, Number(args.limit) || 0);

function readExisting(file) {
  const ids = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.id) ids.add(String(e.id));
        if (e && e.scope && e.ts && e.user) ids.add(e.scope + '|' + e.ts + '|' + String(e.user).slice(0, 80));
      } catch { /* skip bad line */ }
    }
  } catch { /* first import */ }
  return ids;
}

function episodeId(scope, ts, user) {
  return 'legacy-' + crypto.createHash('sha1').update(scope + '\0' + ts + '\0' + user).digest('hex').slice(0, 14);
}

function main() {
  if (!fs.existsSync(dbPath)) throw new Error('bot.db not found: ' + dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(`
    SELECT session, ts, role, name, uid, text
    FROM messages
    WHERE text IS NOT NULL AND trim(text) <> ''
    ORDER BY ts ASC, id ASC
  `).all();
  db.close();

  const existing = readExisting(episodesPath);
  let pending = '';
  let pendingTs = 0;
  let imported = 0;
  let skipped = 0;
  const out = [];
  for (const r of rows) {
    const scope = String(r.session || '');
    const text = String(r.text || '').trim();
    if (!scope || !text) continue;
    if (privateOnly && !scope.startsWith('wechat:u:')) continue;
    if (r.role === 'user') {
      if (text.startsWith('/')) { pending = ''; skipped += 1; continue; }
      pending = text;
      pendingTs = Number(r.ts) || 0;
      continue;
    }
    if (r.role !== 'assistant' || !pending) continue;
    const user = pending.slice(0, 4000);
    const assistant = text.slice(0, 4000);
    const ts = pendingTs || Number(r.ts) || 0;
    const id = episodeId(scope, ts, user);
    const key = scope + '|' + ts + '|' + user.slice(0, 80);
    if (existing.has(id) || existing.has(key)) { skipped += 1; pending = ''; continue; }
    out.push({ id, scope, user, assistant, ts });
    existing.add(id);
    existing.add(key);
    imported += 1;
    pending = '';
    if (limit && out.length >= limit) break;
  }

  if (!dryRun && out.length) {
    fs.mkdirSync(path.dirname(episodesPath), { recursive: true });
    let backup = '';
    if (fs.existsSync(episodesPath)) {
      backup = episodesPath + '.bak-legacy-' + Date.now();
      fs.copyFileSync(episodesPath, backup);
    }
    fs.appendFileSync(episodesPath, out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    console.error('backup: ' + (backup || '(new file)'));
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    db: dbPath,
    episodesFile: episodesPath,
    scanned: rows.length,
    imported,
    skipped,
    dryRun,
    privateOnly,
    sample: out.slice(0, 2).map((e) => ({ scope: e.scope, ts: e.ts, user: e.user.slice(0, 40), assistant: e.assistant.slice(0, 40) })),
  }, null, 2) + '\n');
}

try { main(); } catch (e) {
  console.error(String((e && e.stack) || e));
  process.exit(1);
}
