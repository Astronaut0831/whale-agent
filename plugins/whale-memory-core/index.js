/** 记忆核心：每轮结束把对话写进海马体，由记忆服务处理短/长期。 */

import { resolveTarget, resolveMemoryToken, scopeForSession } from '../lib/runtime.js';

export const name = 'whale-memory-core';

export function textOf(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function isInjectedContext(text) {
  const s = String(text || '');
  if (/^Current runtime context\./i.test(s)) return true;
  if (/^Time sampled while preparing turn/i.test(s)) return true;
  if (/^Browser time zone for this request:/i.test(s)) return true;
  if (/^Elapsed since the preceding/i.test(s)) return true;
  if (/^<system-reminder>/i.test(s)) return true;
  if (s.includes('The following workspace instructions may be relevant')) return true;
  if (s.includes('Instructions from:') && s.includes('AGENTS.md')) return true;
  if (s.includes('Current working directory:') && s.includes('DSH file policy')) return true;
  return false;
}

export function lastTurn(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let user = '';
  let assistant = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const role = list[i] && list[i].role;
    const text = textOf(list[i]);
    if (!text) continue;
    if (role === 'user' && isInjectedContext(text)) continue;
    if (!assistant && role === 'assistant') assistant = text;
    if (assistant && role === 'user') { user = text; break; }
  }
  return { user, assistant };
}

export function resolveScope(sessionId, config = {}, envScope = '') {
  const env = String(envScope || '');
  if (env) return env;
  // 群/私聊独立会话：按 chat-sessions.json 反查出各自的 scope
  const perChat = scopeForSession(sessionId, config);
  if (perChat) return perChat;
  const target = String(config.targetSessionId || '');
  if (!target || !sessionId || String(sessionId) !== target) return '';
  return String(config.scope || '');
}

export function apply(ctx, config = {}) {
  const memoryUrl = String(config.memoryUrl || process.env.WHALE_MEMORY_URL || 'http://127.0.0.1:8791').replace(/\/+$/, '');
  const token = resolveMemoryToken(config) || String(process.env.WHALE_MEMORY_TOKEN || '');
  const seen = new Set();
  let lastObserveErrorAt = 0;
  let lastObserveError = '';

  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/end') return;
    const reason = event.data && event.data.reason;
    if (reason && reason.kind && reason.kind !== 'completed') return;
    // 微信 headless：环境变量 scope 优先，保持原行为。
    // GUI：没有 env 时只允许配置/ runtime state 里的目标 session。
    const effective = { ...config, targetSessionId: resolveTarget(config) };
    const scope = resolveScope(session && session.id, effective, process.env.WHALE_SESSION_SCOPE);
    if (!scope || !session) return;
    const turn = event.data && event.data.turn;
    const key = String(session.id || scope) + ':' + String(turn || event.seq || '');
    if (seen.has(key)) return;
    if (seen.size >= 5000) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.add(key);

    let messages;
    try { messages = session.deriveMessages(); } catch { return; }
    const { user, assistant } = lastTurn(messages);
    const rawUser = String(process.env.WHALE_RAW_USER || '').trim();
    const observeUser = rawUser || user;
    if (!observeUser) return;

    fetch(memoryUrl + '/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
      body: JSON.stringify({ scope, user: observeUser, assistant, ts: Date.now() }),
      signal: AbortSignal.timeout(3000),
    }).catch((e) => {
      const msg = String((e && e.message) || e);
      const now = Date.now();
      if (msg !== lastObserveError || now - lastObserveErrorAt > 60000) {
        lastObserveError = msg;
        lastObserveErrorAt = now;
        console.error('[memory-core] observe failed: ' + msg);
      }
    });
  });
}

export default { name, apply };
