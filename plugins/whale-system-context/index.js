/**
 * 终态上下文边界：规矩/自省属于系统提示，记忆由 memory_recall 工具按需召回。
 * headless 用 env 传入；GUI 只给 targetSessionId 注入，不污染其它会话。
 */

import { createRequire } from 'node:module';
import { resolveTarget } from '../lib/runtime.js';

const localRequire = createRequire(import.meta.url);

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
  if (!prefs) {
    try { prefs = localRequire('../../src/prefs').renderAll({ max: 12 }) || ''; } catch { /* optional */ }
  }
  if (!self) {
    try { self = localRequire('../../src/selfnote').block(5) || ''; } catch { /* optional */ }
  }
  return buildContextText({ WHALE_PREFS_BLOCK: prefs, WHALE_SELFNOTE_BLOCK: self });
}

function addSection(systemPrompt, text) {
  if (text && systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({ name: 'whale-context', order: 90, text });
  }
}

export function apply(ctx, config = {}) {
  const hasTargetConfig = Object.prototype.hasOwnProperty.call(config, 'targetSessionId');
  const target = hasTargetConfig ? resolveTarget(config) : '';
  if (!target) {
    // headless profile: no target field, profile-wide system section.
    // GUI profile with an explicit empty target: do not leak into other sessions.
    if (hasTargetConfig) return;
    addSection(ctx.systemPrompt, buildContextText(config.env || process.env));
    return;
  }
  ctx.on('agent/created', ({ agent } = {}) => {
    const sid = agent && agent.session && agent.session.id;
    if (!sid || String(sid) !== target) return;
    addSection(agent.ctx && agent.ctx.systemPrompt, legacyContextText(config.env || process.env));
  });
}

export default { name, inject, apply };
