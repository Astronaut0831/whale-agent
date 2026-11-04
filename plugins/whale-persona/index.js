/** 把人格文件注入 DSH 系统提示。 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveTarget, scopeForSession, repoRoot } from '../lib/runtime.js';

export const name = 'whale-persona';
export const inject = ['systemPrompt', 'agents'];

export function readPersona(path) {
  try { return String(fs.readFileSync(path, 'utf8')).trim(); } catch { return ''; }
}

export function apply(ctx, config = {}) {
  const file = String(config.personaFile || path.join(repoRoot, 'personas', 'whale-agent.md'));
  const explicitTarget = Object.prototype.hasOwnProperty.call(config, 'targetSessionId');
  const envScope = String(process.env.WHALE_SESSION_SCOPE || '');

  // 微信 headless：有 env scope 时沿用 profile 级 persona。
  // GUI：只给配置/ runtime state 里的目标 session 挂 section，其他 GUI 会话不注入。
  if (envScope || (!explicitTarget && !resolveTarget(config))) {
    const text = readPersona(file);
    if (text) ctx.systemPrompt.section({ name: 'whale-persona', order: 100, text });
    return;
  }

  const addFor = (agent) => {
    if (!agent || !agent.ctx || !agent.ctx.systemPrompt) return;
    const text = readPersona(file);
    if (text) agent.ctx.systemPrompt.section({ name: 'whale-persona', order: 100, text });
  };
  const allowSession = (sid) => {
    const target = resolveTarget(config);
    if (target && sid && String(sid) === target) return true;
    return Boolean(sid && scopeForSession(sid, config));
  };
  ctx.on('agent/created', ({ agent } = {}) => {
    const sid = agent && agent.session && agent.session.id;
    if (!allowSession(sid)) return;
    addFor(agent);
  });
  // Resumed target/scoped agents can predate this plugin; reattach on the next turn.
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/start') return;
    const sid = session && session.id;
    if (!allowSession(sid)) return;
    const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sid) : null;
    if (agent) addFor(agent);
  });
}

export default { name, inject, apply };
