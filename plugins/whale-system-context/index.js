/**
 * 终态上下文边界：规矩/自省属于系统提示，记忆由 memory_recall 工具按需召回。
 * headless 用 env 传入；GUI 只给 targetSessionId 注入，不污染其它会话。
 */

import { resolveTarget, scopeForSession } from '../lib/runtime.js';
import { prefsBlock, selfnoteBlock } from '../lib/context-data.js';

export const name = 'whale-system-context';
export const inject = ['systemPrompt', 'agents'];

export function buildContextText(env = process.env) {
  const prefs = String(env.WHALE_PREFS_BLOCK || '').trim();
  const self = String(env.WHALE_SELFNOTE_BLOCK || '').trim();
  const parts = [];
  if (prefs) parts.push(prefs);
  if (self) parts.push(self);
  parts.push('【记忆使用】需要回忆主人或本会话的长期事实时，调用 memory_recall；不要把记忆内容当作用户本轮原话，也不要逐条复述规矩。');
  return parts.join('\n\n');
}

function legacyContextText(env) {
  let prefs = String(env.WHALE_PREFS_BLOCK || '').trim();
  let self = String(env.WHALE_SELFNOTE_BLOCK || '').trim();
  if (!prefs) prefs = prefsBlock({ max: 12 });
  if (!self) self = selfnoteBlock({ n: 5 });
  return buildContextText({ WHALE_PREFS_BLOCK: prefs, WHALE_SELFNOTE_BLOCK: self });
}

function addSection(systemPrompt, text) {
  if (text && systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({ name: 'whale-context', order: 90, text });
  }
}

export function apply(ctx, config = {}) {
  const hasTargetConfig = Object.prototype.hasOwnProperty.call(config, 'targetSessionId');
  if (!hasTargetConfig) {
    // headless profile: no target field, profile-wide system section.
    addSection(ctx.systemPrompt, buildContextText(config.env || process.env));
    return;
  }
  const addFor = (agent) => {
    addSection(agent && agent.ctx && agent.ctx.systemPrompt, legacyContextText(config.env || process.env));
  };
  // 群/私聊独立会话：也给一段，但比主会话短（规矩少一点、自省少一点）。
  const addShortFor = (agent) => {
    const prefs = prefsBlock({ max: 4 });
    const self = selfnoteBlock({ n: 2 });
    const text = buildContextText({ WHALE_PREFS_BLOCK: prefs, WHALE_SELFNOTE_BLOCK: self });
    addSection(agent && agent.ctx && agent.ctx.systemPrompt, text);
  };
  const allowSession = (sid) => {
    const target = resolveTarget(config);
    if (target && sid && String(sid) === target) return 'full';
    if (sid && scopeForSession(sid, config)) return 'short';
    return '';
  };
  ctx.on('agent/created', ({ agent } = {}) => {
    const sid = agent && agent.session && agent.session.id;
    const mode = allowSession(sid);
    if (!mode) return;
    if (mode === 'full') addFor(agent); else addShortFor(agent);
  });
  // A target can be resumed before the plugin was applied; add the section on
  // the next turn as well. Same section name replaces the previous layer.
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/start') return;
    const sid = session && session.id;
    const mode = allowSession(sid);
    if (!mode) return;
    const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sid) : null;
    if (!agent) return;
    if (mode === 'full') addFor(agent); else addShortFor(agent);
  });
}

export default { name, inject, apply };
