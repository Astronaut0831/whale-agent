/** 模式分发：off/legacy 代理，shadow 旁路，active 接管并回退。 */

import { normalizeInbound, decideMode } from './normalize.js';
import { proxyLegacy } from './inbound.js';
import { formatForAgent, createOutbound } from './envelope.js';

export function formatUserMessage(msg) {
  if (msg.envelope) return formatForAgent(msg.envelope);
  const who = msg.senderName || '对方';
  return `[微信${msg.chatType === 'group' ? '群聊' : '私聊'}] ${who}：${msg.text || '（无文字）'}`;
}

export async function dispatchInbound(payload, deps = {}) {
  const t0 = Date.now();
  const msg = normalizeInbound(payload);
  const mode = decideMode({ mode: deps.mode, masterWxid: deps.masterWxid }, msg);
  const beforeTurn = async () => {
    if (typeof deps.beforeTurn !== 'function') return;
    try { await deps.beforeTurn({ msg }); } catch { /* memory correction must not block */ }
  };

  if (deps.groupEnabled && deps.mode === 'active' && msg.chatType === 'group') {
    try { deps.groupObserve?.(msg); deps.groupCollect?.(msg); } catch { /* ignore */ }
    // Full autonomy: every whitelisted group message reaches the agent. The
    // agent decides whether to answer (and may return [SKIP]); no score/cooldown
    // wake gate here.
    const decision = { reason: 'autonomous', score: null };
    try {
      const out = await deps.runTurn({ sessionKey: msg.sessionKey, message: formatUserMessage(msg), rawText: msg.text });
      const rawOut = String(out.text || '').trim();
      if (rawOut === '[SKIP]' || rawOut === 'SKIP') {
        deps.log?.({ kind: 'group-model-skip', msgId: msg.msgId, ms: Date.now() - t0 });
        return { mode: 'group-skip', status: 200, data: { ok: true, ignored: true, reason: 'model_skip' }, ok: true };
      }
      const bubbles = deps.splitBubbles(rawOut);
      if (!bubbles.length) throw new Error('empty reply');
      const outbound = createOutbound(msg.envelope, { bubbles });
      await deps.sendBubbles({ platform: msg.platform, chatId: msg.chatId, chatType: msg.chatType, bubbles, outbound });
      try { deps.groupRecordReply?.(msg); deps.groupObserveReply?.(msg, out.text); } catch { /* ignore */ }
      deps.log?.({ kind: 'active-group', msgId: msg.msgId, reason: decision.reason, score: decision.score, text: out.text, bubbles, ms: Date.now() - t0 });
      return { mode: 'active-group', status: 200, data: { ok: true, bubbles, reason: decision.reason, score: decision.score }, ok: true };
    } catch (e) {
      deps.log?.({ kind: 'group-error', msgId: msg.msgId, error: String(e && e.message), ms: Date.now() - t0 });
      return { mode: 'group-error', status: 200, data: { ok: true, ignored: true, error: String(e && e.message) }, ok: true };
    }
  }

  if (mode === 'off' || mode === 'legacy') {
    if (deps.legacyEnabled === false) {
      deps.log?.({ kind: 'legacy-disabled', msgId: msg.msgId, sessionKey: msg.sessionKey, chatType: msg.chatType });
      return { mode, status: 200, data: { ok: true, ignored: true }, ok: true };
    }
    const r = await proxyLegacy(payload, deps);
    return { mode, status: r.status, data: r.data, ok: r.ok };
  }

  if (mode === 'shadow') {
    if (deps.legacyEnabled === false) return { mode, status: 200, data: { ok: true, ignored: true }, ok: true };
    const r = await proxyLegacy(payload, deps);
    Promise.resolve()
      .then(beforeTurn)
      .then(() => deps.runTurn({ sessionKey: msg.sessionKey, message: formatUserMessage(msg), rawText: msg.text }))
      .then((out) => deps.log?.({
        kind: 'shadow', msgId: msg.msgId, sessionKey: msg.sessionKey,
        text: out && out.text, legacy: r.data, ms: Date.now() - t0,
      }))
      .catch((e) => deps.log?.({ kind: 'shadow-error', msgId: msg.msgId, error: String(e && e.message) }));
    return { mode, status: r.status, data: r.data, ok: r.ok, shadow: true };
  }

  // active
  try {
    await beforeTurn();
    const out = await deps.runTurn({ sessionKey: msg.sessionKey, message: formatUserMessage(msg), rawText: msg.text });
    const bubbles = deps.splitBubbles(String(out.text || ''));
    if (!bubbles.length) throw new Error('empty reply');
    const outbound = createOutbound(msg.envelope, { bubbles });
    await deps.sendBubbles({ platform: msg.platform, chatId: msg.chatId, chatType: msg.chatType, bubbles, outbound });
    deps.log?.({ kind: 'active', msgId: msg.msgId, sessionKey: msg.sessionKey, text: out.text, bubbles, outbound, ms: Date.now() - t0 });
    return { mode, status: 200, data: { ok: true, bubbles, outbound }, ok: true };
  } catch (e) {
    deps.log?.({ kind: 'fallback', msgId: msg.msgId, error: String(e && e.message), ms: Date.now() - t0 });
    if (deps.legacyEnabled === false) {
      return { mode, status: 200, data: { ok: true, ignored: true }, ok: true, fallback: String(e && e.message) };
    }
    const r = await proxyLegacy(payload, deps);
    return { mode, status: r.status, data: r.data, ok: r.ok, fallback: String(e && e.message) };
  }
}
