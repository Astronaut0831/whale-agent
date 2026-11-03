/** DSH agent 会话管理：sessionKey → sessionId 映射、串行队列、超时。 */

import fs from 'node:fs';
import path from 'node:path';

export function lastAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'assistant') continue;
    const content = m.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      const text = content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('').trim();
      if (text) return text;
    }
  }
  return '';
}

export function createStore(file) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };
  return {
    get(key) { return read()[key] || ''; },
    set(key, id) { const d = read(); d[key] = id; write(d); },
    del(key) { const d = read(); delete d[key]; write(d); },
  };
}

const queues = new Map();

function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

function newSessionId(sessionKey) {
  const safe = String(sessionKey).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
  return `core-${safe}-${Date.now().toString(36)}`;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout?.(); reject(new Error('agent timeout')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function doTurn({ ctx, sessionKey, message, timeoutMs = 60000, store, agentOptions, setupAgent }) {
  let sessionId = store.get(sessionKey);
  let handle = null;
  const setup = typeof setupAgent === 'function'
    ? async (agentCtx) => { await setupAgent(agentCtx, sessionKey); }
    : undefined;
  if (sessionId) {
    try {
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
    } catch {
      handle = null;
    }
  }
  if (!handle) {
    sessionId = newSessionId(sessionKey);
    handle = await ctx.agents.create({ sessionId, agentOptions, setup });
    store.set(sessionKey, sessionId);
  }

  const agent = handle.agent;
  agent.followup({
    content: [{ type: 'text', text: message }],
    source: { kind: 'wechat' },
  });
  const start = Date.now();
  let text = '';
  while (Date.now() - start < timeoutMs) {
    const messages = agent.session.deriveMessages();
    text = lastAssistantText(messages);
    if (text) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!text) {
    try { agent.cancel('timeout'); } catch { /* ignore */ }
    throw new Error('agent timeout: no assistant text: seq=' + agent.session.seq
      + ' status=' + JSON.stringify(agent.status || {}));
  }
  await withTimeout(agent.whenIdle(), 5000, () => {}).catch(() => {});
  return { text, sessionId };
}

export function runTurn(opts) {
  return enqueue(opts.sessionKey, () => doTurn(opts));
}
