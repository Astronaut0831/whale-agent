/** Bridge the official QQ agent loop to the existing whale memory/persona core. */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../lib/runtime.js';
import { registerMemoryTools } from '../wechat-adapter/lib/memory-tools.js';
import { recallContext } from '../wechat-adapter/lib/memory-context.js';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function lastTurn(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let user = '';
  let assistant = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const role = list[i] && list[i].role;
    let text = '';
    const content = list[i] && list[i].content;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
    if (!text) continue;
    if (!assistant && role === 'assistant') assistant = text;
    if (assistant && role === 'user') { user = text; break; }
  }
  return { user, assistant };
}

export const name = 'whale-qq-memory';

export function apply(ctx, config = {}) {
  console.log('[whale-qq-memory] loaded');
  const rootCfg = readJson(path.join(repoRoot, 'config.json'));
  const memoryUrl = String(config.memoryUrl || 'http://127.0.0.1:8791').replace(/\/+$/, '');
  const token = String(config.token || (rootCfg.gateway && rootCfg.gateway.wechat && rootCfg.gateway.wechat.inboundToken) || '');
  const masterWxid = String(config.masterWxid || (rootCfg.persona && rootCfg.persona.master && rootCfg.persona.master.wxids && rootCfg.persona.master.wxids[0]) || '');
  const masterOpenid = String(config.masterOpenid || '');
  const masterScope = masterWxid ? 'wechat:u:' + masterWxid : 'wechat:u:master';
  const persona = (() => {
    try {
      const file = String(config.personaFile || path.join(repoRoot, 'personas', 'whale-agent.md'));
      return fs.readFileSync(file, 'utf8');
    } catch { return ''; }
  })();

  const records = new WeakMap();        // agent -> { scope, isMaster, lastText }
  const sessions = new Map();           // sessionId -> { scope, isMaster, agent }
  const registered = new WeakSet();

  function scopeOf(record) {
    if (record.scope === 'group') return 'qq:g:' + record.peerId;
    if (masterOpenid && record.peerId === masterOpenid) return masterScope;
    return 'qq:u:' + record.peerId;
  }

  function attach(record) {
    if (!record || !record.agent || !record.agent.ctx) return;
    console.log('[whale-qq-memory] attach scope=' + String(record.scope || '') + ' peer=' + String(record.peerId || '').slice(0, 8));
    const chatKind = record.scope === 'group' ? 'group' : 'c2c';
    const peerId = String(record.peerId || '');
    const existing = records.get(record.agent);
    const meta = existing || {
      chatKind,
      peerId,
      scope: chatKind === 'group' ? 'qq:g:' + peerId : (masterOpenid && peerId === masterOpenid ? masterScope : 'qq:u:' + peerId),
      isMaster: chatKind !== 'group' && Boolean(masterOpenid) && peerId === masterOpenid,
      lastText: '',
    };
    records.set(record.agent, meta);
    sessions.set(record.sessionId, { ...meta, agent: record.agent });
    console.log('[whale-qq-memory] memory=' + meta.scope + ' master=' + String(meta.isMaster) + ' tools=' + Boolean(record.agent.ctx && record.agent.ctx.tools));
    if (!registered.has(record.agent)) {
      registered.add(record.agent);
      try {
        registerMemoryTools(record.agent.ctx, { memoryUrl, token, scope: meta.scope, isMaster: meta.isMaster });
      } catch (e) { console.log('[whale-qq-memory] tools failed: ' + (e && e.message || e)); }
    }
  }

  ctx.on('qqbot/session-ready', ({ record } = {}) => attach(record));

  ctx.on('qqbot/inbound', ({ msg } = {}) => {
    if (!msg) return;
    const chatKind = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = chatKind === 'group' ? String(msg.groupOpenid || '') : String(msg.senderId || '');
    for (const [sid, item] of sessions) {
      if (item.chatKind === chatKind && item.peerId === peerId) {
        item.lastText = String(msg.content || '');
        sessions.set(sid, item);
      }
    }
  });

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    if (!context || !context.agent) return assembled;
    const meta = records.get(context.agent);
    if (!meta) return assembled;
    const sections = [...(assembled.sections || [])];
    if (persona) sections.push({ name: 'whale-persona-qq', order: 95, text: persona });
    try {
      const recall = await recallContext({ memoryUrl, token, scope: meta.scope, query: meta.lastText || '', isMaster: meta.isMaster, timeoutMs: 1200 });
      if (recall) sections.push({ name: 'whale-memory-qq', order: 96, text: recall });
    } catch { /* recall best effort */ }
    return { ...assembled, sections };
  });

  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/end' || !session) return;
    console.log('[whale-qq-memory] turn/end session=' + String(session.id || '').slice(0, 12) + ' known=' + sessions.has(session.id));
    const meta = sessions.get(session.id);
    if (!meta) return;
    const reason = event.data && event.data.reason;
    if (reason && reason.kind && reason.kind !== 'completed') return;
    let messages = [];
    try { messages = session.deriveMessages ? session.deriveMessages() : []; } catch { return; }
    const { user, assistant } = lastTurn(messages);
    const text = String(user || '').trim();
    if (!text) return;
    fetch(memoryUrl + '/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
      body: JSON.stringify({ scope: meta.scope, user: text, assistant, ts: Date.now() }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  });
}

export default { name, apply };
