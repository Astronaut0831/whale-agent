/**
 * GUI API broker：把微信消息送进持有 target session 写句柄的 GUI 进程。
 *
 * 不能 spawn 第二个 dsh 去 resume target（active write handle），只能走
 * DSH web 的 session/prompt RPC。回复从 session/list 的 turnOutline 取。
 */

const DEFAULT_TIMEOUT_MS = 300000;
const POLL_MS = 500;

function rpcId() {
  return 'broker-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function extractTokenFromLog(text) {
  const all = [...String(text || '').matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)];
  return all.length ? all[all.length - 1][1] : '';
}

export function createGuiBroker({
  baseUrl = 'http://127.0.0.1:3080',
  token = '',
  sessionId = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxQueue = 8,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let cookie = '';
  let chain = Promise.resolve();
  let pending = 0;

  if (!base || !sessionId) throw new Error('gui broker: baseUrl and sessionId required');

  async function bootstrap() {
    if (cookie) return;
    const r = await fetchImpl(base + '/?token=' + encodeURIComponent(token), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const raw = list.length ? list : [r.headers.get('set-cookie') || ''];
    cookie = raw.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
    if (!cookie) throw new Error('gui broker: no dsh auth cookie');
  }

  async function rpc(method, args) {
    await bootstrap();
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: rpcId(),
      method,
      payload: { args },
    });
    const r = await fetchImpl(base + '/api/' + method, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body,
      signal: AbortSignal.timeout(Math.max(15000, timeoutMs)),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('gui broker: non-JSON RPC response'); }
    if (!data || data.type !== 'server-response') throw new Error('gui broker: bad RPC envelope');
    const result = data.result;
    if (!result || result.ok !== true) {
      throw new Error('gui broker: ' + ((result && result.error && result.error.message) || 'RPC failed'));
    }
    return result.value;
  }

  async function listTarget() {
    const value = await rpc('session/list', { _request: {} });
    const items = (value && value.items) || [];
    return items.find((x) => x && x.sessionId === sessionId) || null;
  }

  // turnOutline.response 是界面预览（120 字 + 省略号），不能当正文发出去。
  // 这里从 session/page 读本轮最后一条 assistant/message 的完整文本。
  async function readFullReply(throughSeq, turnSeq) {
    const cut = Number(throughSeq || 0);
    if (!cut) return '';
    try {
      const page = await rpc('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: cut,
          beforeSeq: cut + 1,
          maxMessages: 30,
        },
      });
      const records = (page && page.records) || [];
      let found = null;
      for (const rec of records) {
        const ev = rec && rec.event;
        if (!ev || ev.type !== 'assistant/message') continue;
        if (Number(ev.seq || 0) < Number(turnSeq || 0)) continue;
        found = ev;
      }
      if (!found) return '';
      const content = found.data && found.data.message && found.data.message.content;
      return (Array.isArray(content) ? content : [])
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => String(b.text))
        .join('\n')
        .trim();
    } catch {
      return '';
    }
  }

  async function doPrompt(text, images = []) {
    const traceId = 'gui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    // 群聊/私聊共用一个会话：等上一轮跑完再投，否则会在中途被判空。
    {
      const waitUntil = now() + timeoutMs;
      while (now() < waitUntil) {
        const cur = await listTarget();
        if (!cur || cur.running !== true) break;
        await sleep(POLL_MS);
      }
    }
    const before = await listTarget();
    if (!before) throw new Error('gui broker: target session not visible');
    const beforeSeq = Number((before.projections && before.projections.asOfSeq) || 0);
    const beforeUpdated = Number(before.updatedAt || 0);
    const requestId = rpcId();
    const value = await rpc('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode: 'queue',
        content: [
          { type: 'text', text: String(text || '') },
          ...(Array.isArray(images) ? images : []),
        ],
        clientTimeZone: 'Asia/Shanghai',
      },
    });
    if (!value || value.accepted !== true) throw new Error('gui broker: prompt not accepted');

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(POLL_MS);
      const item = await listTarget();
      if (!item) continue;
      const seq = Number((item.projections && item.projections.asOfSeq) || 0);
      const updated = Number(item.updatedAt || 0);
      const outline = (item.projections && item.projections.values && item.projections.values.turnOutline) || [];
      const fresh = outline.filter((t) => Number(t.seq || 0) > beforeSeq);
      const last = fresh[fresh.length - 1] || outline[outline.length - 1];
      if (!item.running && updated >= beforeUpdated && last && String(last.response || '').trim()) {
        const full = await readFullReply(seq, last.seq);
        return {
          text: String(full || last.response).trim(),
          sessionId,
          turn: last.turn,
          seq: last.seq,
          requestId,
          traceId,
        };
      }
    }
    throw new Error('gui broker: timeout waiting for reply');
  }

  return {
    sessionId,
    async prompt(text, images = []) {
      if (pending >= Math.max(1, Number(maxQueue) || 8)) throw new Error('gui broker: busy (queue full)');
      pending += 1;
      const run = chain.then(() => doPrompt(text, images), () => doPrompt(text, images));
      chain = run.catch(() => {});
      try {
        return await run;
      } finally {
        pending -= 1;
      }
    },
    get pending() { return pending; },
    // 给适配器留一个直接调 RPC 的口子（用于按会话创建新 session）。
    async call(method, args) { return rpc(method, args); },
    async health() {
      const item = await listTarget();
      return { ok: Boolean(item), sessionId, running: Boolean(item && item.running), updatedAt: item && item.updatedAt };
    },
  };
}
