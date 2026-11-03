'use strict';

/**
 * 记忆 HTTP 服务：给 DSH agent 的工具调用。
 * 只监听回环；token 复用 bridge inboundToken。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const memories = require('../src/memories');
const narrative = require('../src/narrative');
const memoryBackup = require('../src/memoryBackup');
const { createEpisodeRuntime } = require('./episode-runtime');
const { runConsolidation } = require('./memory-maintenance');
const { runDigestPass } = require('../src/digestCore');
const { autoCorrect } = require('../src/reconsolidate');

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function tokenOf(req) {
  return String(req.headers['x-bot-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
}

function startWorkers({ dataDir, config, llm }) {
  if (!llm) return () => {};
  const rt = createEpisodeRuntime({
    dataDir,
    llm,
    config: config || {},
    logger: { info: (m) => console.error(m), warn: (m) => console.error(m), debug: () => {} },
  });
  let digestBusy = false;
  let consolidateBusy = false;

  const digestTick = async () => {
    if (digestBusy) return;
    digestBusy = true;
    try { await runDigestPass(rt, { force: false }); } catch (e) {
      console.error('[memory] digest worker:', e && e.message);
    } finally { digestBusy = false; }
  };

  const consolidateTick = async () => {
    if (consolidateBusy) return;
    const hour = Number((config && config.memory && config.memory.consolidateHour) ?? 3);
    if (new Date().getHours() < hour) return;
    const stateFile = path.join(dataDir || path.join(__dirname, '..', 'data'), 'memory-consolidate-state.json');
    let lastDay = '';
    try { lastDay = JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastDay || ''; } catch { /* first */ }
    const today = new Date().toISOString().slice(0, 10);
    if (lastDay === today) return;
    consolidateBusy = true;
    try {
      await runConsolidation({ dataDir, llm, config, logger: { info: (m) => console.error(m), warn: (m) => console.error(m) } });
    } catch (e) {
      console.error('[memory] consolidate worker:', e && e.message);
    } finally { consolidateBusy = false; }
  };

  const first = setTimeout(digestTick, 15 * 1000);
  const digestTimer = setInterval(digestTick, 5 * 60 * 1000);
  const consolidateTimer = setInterval(consolidateTick, 30 * 60 * 1000);
  if (first.unref) first.unref();
  if (digestTimer.unref) digestTimer.unref();
  if (consolidateTimer.unref) consolidateTimer.unref();
  return () => { clearTimeout(first); clearInterval(digestTimer); clearInterval(consolidateTimer); };
}

function createMemoryServer({ dataDir, token = '', embedUrl = '', config = null, llm = null, root = null } = {}) {
  if (dataDir) {
    memories.setDataDir(dataDir);
    narrative.setDataDir(dataDir);
  }
  const baseDir = dataDir || path.join(__dirname, '..', 'data');
  const projectRoot = root || path.dirname(baseDir);
  const episodesFile = path.join(baseDir, 'memory-episodes.jsonl');

  return http.createServer(async (req, res) => {
    try {
      if (token && tokenOf(req) !== token) return send(res, 401, { ok: false, error: 'bad token' });
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const body = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : {};

      if (req.method === 'POST' && url.pathname === '/recall') {
        const scope = String(body.scope || '');
        if (!scope) return send(res, 400, { ok: false, error: 'scope required' });
        const r = await memories.blockForAudience(scope, String(body.query || ''), {
          topK: Number(body.limit) || 4,
          embedUrl,
          isMaster: body.isMaster === true,
        });
        let review = null;
        if (body.isMaster === true) {
          try {
            const due = memories.dueForReview({ limit: 1 });
            if (due.length) {
              review = due[0];
              memories.markReviewed(review.id);
            }
          } catch { /* review is best-effort */ }
        }
        return send(res, 200, {
          ok: true,
          review: review && review.text ? { text: review.text } : null,
          items: (r.items || []).map((x) => ({
            text: x.text, importance: x.importance, confidence: x.confidence,
            about: x.about, quote: x.quote, session: x.origin && x.origin.session,
          })),
        });
      }

      if (req.method === 'POST' && url.pathname === '/add') {
        const scope = String(body.scope || '');
        const text = String(body.text || '').trim();
        if (!scope || text.length < 4) return send(res, 400, { ok: false, error: 'scope/text required' });
        const r = await memories.addMany(scope, [text], {
          embedUrl,
          source: 'agent',
          importances: [Number(body.importance) || 0.7],
          evidences: [{
            quote: String(body.quote || text).slice(0, 240),
            msgIds: Array.isArray(body.msgIds) ? body.msgIds : [],
            confidence: Number(body.confidence) || 0.85,
            about: body.about || 'user',
          }],
        });
        return send(res, 200, { ok: true, ...r });
      }

      if (req.method === 'POST' && url.pathname === '/correct') {
        const scope = String(body.scope || '');
        const newFact = String(body.newFact || '').trim();
        if (!scope || newFact.length < 4) return send(res, 400, { ok: false, error: 'scope/newFact required' });
        const r = memories.correct(scope, { oldText: String(body.oldHint || ''), newText: newFact });
        await memories.addMany(scope, [newFact], {
          embedUrl,
          source: 'agent-correct',
          evidences: [{ quote: String(body.quote || newFact).slice(0, 240), msgIds: [], confidence: 0.95, about: body.about || 'user' }],
        });
        return send(res, 200, { ok: true, ...r });
      }

      if (req.method === 'POST' && url.pathname === '/observe') {
        const scope = String(body.scope || '');
        const user = String(body.user || '').trim().slice(0, 2000);
        const assistant = String(body.assistant || '').trim().slice(0, 2000);
        if (!scope || !user) return send(res, 400, { ok: false, error: 'scope/user required' });
        if (/^(Current runtime context\.|<system-reminder>)/i.test(user)
          || user.includes('The following workspace instructions may be relevant')
          || (user.includes('Instructions from:') && user.includes('AGENTS.md'))) {
          return send(res, 400, { ok: false, error: 'injected context rejected' });
        }
        const episode = {
          id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          scope,
          user,
          assistant,
          ts: Number(body.ts) || Date.now(),
        };
        fs.mkdirSync(baseDir, { recursive: true });
        fs.appendFileSync(episodesFile, JSON.stringify(episode) + '\n', 'utf8');
        return send(res, 200, { ok: true, episode: episode.id });
      }

      if (req.method === 'POST' && url.pathname === '/digest/run') {
        if (!llm) return send(res, 400, { ok: false, error: 'no llm configured' });
        const rt = createEpisodeRuntime({
          dataDir: baseDir,
          llm,
          config: config || {},
          logger: { info: (m) => console.error(m), warn: (m) => console.error(m), debug: () => {} },
        });
        const done = await runDigestPass(rt, { force: body.force !== false });
        return send(res, 200, { ok: true, done });
      }

      if (req.method === 'POST' && url.pathname === '/consolidate/run') {
        if (!llm) return send(res, 400, { ok: false, error: 'no llm configured' });
        const r = await runConsolidation({
          dataDir: baseDir,
          llm,
          config: config || {},
          logger: { info: (m) => console.error(m), warn: (m) => console.error(m) },
        });
        return send(res, 200, { ok: true, ...r });
      }

      if (req.method === 'POST' && url.pathname === '/correct-auto') {
        const scope = String(body.scope || '');
        const text = String(body.text || '').trim();
        if (!scope || !text) return send(res, 400, { ok: false, error: 'scope/text required' });
        if (!llm) return send(res, 400, { ok: false, error: 'no llm configured' });
        const r = await autoCorrect({
          llm, key: scope, text, embedUrl, msgId: String(body.msgId || ''),
        });
        return send(res, 200, { ok: true, ...r });
      }

      if (req.method === 'POST' && url.pathname === '/facts') {
        const scope = String(body.scope || '');
        if (!scope) return send(res, 400, { ok: false, error: 'scope required' });
        const op = String(body.op || 'list');
        if (op === 'list') {
          const q = String(body.q || '').trim();
          const all = memories.listFacts(scope);
          const hit = q ? all.filter((x) => String(x.text).includes(q)) : all;
          return send(res, 200, {
            ok: true,
            total: hit.length,
            items: hit.slice(-20).map((x) => ({
              index: x.index, text: x.text, state: x.state, importance: x.importance,
              confidence: x.provenance && x.provenance.confidence, about: x.about,
            })),
          });
        }
        if (op === 'detail') {
          const one = memories.detail(scope, body.ref);
          return send(res, 200, { ok: !!one, item: one });
        }
        if (op === 'remove') {
          const ref = String(body.ref ?? '').trim();
          const gone = /^\d+$/.test(ref) ? memories.removeAt(scope, Number(ref)) : memories.removeByText(scope, ref);
          return send(res, 200, { ok: !!gone, item: gone });
        }
        if (op === 'restore') {
          const one = memories.restore(scope, body.ref);
          return send(res, 200, { ok: !!one, item: one });
        }
        return send(res, 400, { ok: false, error: 'unknown op' });
      }

      if (req.method === 'GET' && url.pathname === '/memory/export') {
        const withSecrets = /(?:^|[?&])secrets=1(?:&|$)/.test(String(req.url || ''));
        const bundle = memoryBackup.collect(projectRoot, { withSecrets });
        return send(res, 200, { ok: true, bundle });
      }
      if (req.method === 'POST' && url.pathname === '/memory/backup') {
        const file = memoryBackup.writeSnapshot(projectRoot, 'manual');
        return send(res, 200, { ok: true, file: file || '' });
      }
      if (req.method === 'GET' && url.pathname === '/memory/backups') {
        return send(res, 200, {
          ok: true,
          dir: memoryBackup.backupDir(projectRoot),
          items: memoryBackup.listBackups(projectRoot),
        });
      }
      if (req.method === 'POST' && url.pathname === '/memory/restore') {
        const name = path.basename(String(body.name || ''));
        if (!name) return send(res, 400, { ok: false, error: 'name required' });
        const file = path.join(memoryBackup.backupDir(projectRoot), name);
        if (!fs.existsSync(file)) return send(res, 400, { ok: false, error: 'backup not found: ' + name });
        const info = memoryBackup.restoreFromFile(projectRoot, file);
        return send(res, 200, { ok: true, ...info });
      }

      if (req.method === 'GET' && url.pathname === '/narrative') {
        const only = String(url.searchParams.get('scope') || '');
        const limit = Number(url.searchParams.get('limit')) || 6;
        return send(res, 200, { ok: true, items: narrative.recent(limit, only ? { only } : {}) });
      }

      return send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e && e.message) });
    }
  });
}

function startMemoryServer({ port = 8791, host = '127.0.0.1', dataDir, token, embedUrl, config = null, llm = null, workers = false, root = null } = {}) {
  const server = createMemoryServer({ dataDir, token, embedUrl, config, llm, root });
  if (workers) server.stopWorkers = startWorkers({ dataDir: dataDir || path.join(__dirname, '..', 'data'), config, llm });
  server.listen(port, host);
  return server;
}

if (require.main === module) {
  const fs = require('node:fs');
  const cfgPath = path.join(__dirname, '..', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const port = Number(process.env.MEMORY_PORT) || 8791;
  const token = String(((cfg.gateway || {}).wechat || {}).inboundToken || '');
  const dataDir = process.env.WHALE_DATA_DIR || path.join(__dirname, '..', 'data');
  const embedUrl = String(((cfg.group || {})).embedUrl || '');
  let llm = null;
  try {
    const { DeepSeekClient } = require('../src/llm');
    llm = new DeepSeekClient({ config: cfg, logger: { info: (m) => console.error(m), warn: (m) => console.error(m), debug: () => {} } });
  } catch (e) {
    console.error('[memory] llm init failed:', e && e.message);
  }
  startMemoryServer({ port, dataDir, token, embedUrl, config: cfg, llm, workers: process.env.MEMORY_WORKERS !== '0', root: path.join(__dirname, '..') });
  console.log('[memory] listening on http://127.0.0.1:' + port);
}

module.exports = { createMemoryServer, startMemoryServer };
