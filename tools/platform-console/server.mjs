#!/usr/bin/env node
/**
 * Whale platform console, read-only v0.1.
 * Binds 127.0.0.1:3100, serves the Vue build and a small status API.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const DIST = path.join(DIR, 'dist');
const HOST = process.env.CONSOLE_HOST || '127.0.0.1';
const PORT = Number(process.env.CONSOLE_PORT) || 3100;
const QQ_ROOT = process.env.QQ_BRIDGE_ROOT || 'D:/dsh-workspace/research/qq-bridge';
const WEB_LOG = process.env.DSH_WEB_LOG || path.join(os.homedir(), 'AppData', 'Local', 'dsh', 'web.log');
const SNOWLUMA_URL = process.env.SNOWLUMA_URL || 'http://127.0.0.1:5099';
const ADAPTER_URL = process.env.ADAPTER_URL || 'http://127.0.0.1:8788';

const PORTS = [
  { name: 'DSH GUI', port: 3080 },
  { name: 'platform-adapter', port: 8788 },
  { name: 'memory-server', port: 8791 },
  { name: 'embedding', port: 8790 },
  { name: 'SnowLuma HTTP', port: 3000 },
  { name: 'SnowLuma WS', port: 3001 },
  { name: 'SnowLuma WebUI', port: 5099 },
];

function checkPort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tail(file, lines = 80) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 128 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

async function adapterHealth() {
  try {
    const r = await fetch(ADAPTER_URL + '/wechat/ping', { signal: AbortSignal.timeout(1500) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, body: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function getStatus() {
  const ports = await Promise.all(PORTS.map(async (p) => ({ ...p, ok: await checkPort(p.port) })));
  const bridgeReady = readJson(path.join(ROOT, 'data', 'bridge-ready.json'));
  const qq = readJson(path.join(QQ_ROOT, 'state', 'adapter-transport-status.json'));
  const adapter = await adapterHealth();
  const wechatPid = Number(bridgeReady && bridgeReady.pid) || 0;
  return {
    at: Date.now(),
    ports,
    adapter,
    wechat: {
      ready: Boolean(bridgeReady && bridgeReady.readyAt),
      readyAt: bridgeReady && bridgeReady.readyAt || null,
      pid: wechatPid || null,
      alive: wechatPid ? pidAlive(wechatPid) : false,
    },
    qqTransport: qq || null,
    snowluma: {
      url: SNOWLUMA_URL,
      webui: ports.find((p) => p.port === 5099)?.ok || false,
      onebot: ports.find((p) => p.port === 3000)?.ok && ports.find((p) => p.port === 3001)?.ok,
    },
    links: {
      gui: 'http://127.0.0.1:3080',
      snowluma: SNOWLUMA_URL,
    },
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.resolve(DIST, '.' + rel);
  if (!full.startsWith(DIST) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Whale console: run `npm run build` first (and `npm start`).');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const LOG_FILES = {
  adapter: path.join(ROOT, 'data', 'adapter.log'),
  wechatBridge: path.join(ROOT, 'data', 'wechat-bridge-4x.log'),
  web: WEB_LOG,
  qqTransport: path.join(QQ_ROOT, 'adapter-transport.log'),
  qqSnowluma: path.join(QQ_ROOT, 'adapter-transport.log'),
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
    if (url.pathname === '/api/status') {
      return sendJson(res, 200, await getStatus());
    }
    if (url.pathname === '/api/logs') {
      const source = String(url.searchParams.get('source') || 'adapter');
      const file = LOG_FILES[source];
      if (!file) return sendJson(res, 404, { ok: false, error: 'unknown log source' });
      const lines = Math.min(300, Math.max(10, Number(url.searchParams.get('tail')) || 80));
      return sendJson(res, 200, { ok: true, source, file: path.basename(file), lines: tail(file, lines) });
    }
    if (url.pathname === '/api/platforms') {
      return sendJson(res, 200, {
        ok: true,
        platforms: [
          { id: 'wechat', name: '微信', transport: 'wechat bridge' },
          { id: 'qq', name: 'QQ', transport: 'SnowLuma OneBot → transport-only' },
        ],
        snowlumaUrl: SNOWLUMA_URL,
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'read-only console' });
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[console] http://${HOST}:${PORT} (read-only)`);
  console.log(`[console] adapter=${ADAPTER_URL} qq=${QQ_ROOT} snowluma=${SNOWLUMA_URL}`);
});
