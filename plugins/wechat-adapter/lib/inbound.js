/** 入站路由：认证、幂等、off/legacy 代理、shadow/active 占位。 */

import { normalizeInbound, decideMode } from './normalize.js';

export function checkToken({ headers = {}, url = '' } = {}, token = '') {
  if (!token) return true;
  const h = headers['x-bot-token'] || headers['X-Bot-Token'] || '';
  let q = '';
  try { q = new URL(url, 'http://127.0.0.1').searchParams.get('token') || ''; } catch { q = ''; }
  return String(h) === String(token) || String(q) === String(token);
}

export function createSeen(ttlMs = 10 * 60 * 1000) {
  const m = new Map();
  const prune = (now) => {
    for (const [k, ts] of m) if (now - ts > ttlMs) m.delete(k);
  };
  return {
    has(id) { prune(Date.now()); return m.has(id); },
    add(id) { m.set(id, Date.now()); },
    get size() { return m.size; },
  };
}

export async function proxyLegacy(payload, { legacyBase, fetchImpl = fetch, token = '' } = {}) {
  if (!legacyBase) throw new Error('legacy base not configured');
  const url = String(legacyBase).replace(/\/+$/, '') + '/webhook/wechat';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-whale-bridge': '1',
      ...(token ? { 'x-bot-token': token } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * 处理一条入站消息。
 * off/legacy → 同步代理旧 bot；shadow/active 由 Task 5 接入。
 */
export async function handleInbound(payload, deps = {}) {
  const msg = normalizeInbound(payload);
  const mode = decideMode({ mode: deps.mode, masterWxid: deps.masterWxid }, msg);

  if (deps.seen && deps.seen.has(msg.msgId)) {
    return { mode, duplicate: true, status: 200, data: { ok: true, duplicate: true } };
  }
  if (deps.seen) deps.seen.add(msg.msgId);

  if (mode === 'off' || mode === 'legacy') {
    const r = await proxyLegacy(payload, deps);
    return { mode, duplicate: false, status: r.status, data: r.data, ok: r.ok };
  }

  return {
    mode,
    duplicate: false,
    status: 501,
    data: { ok: false, error: 'mode not implemented yet' },
  };
}
