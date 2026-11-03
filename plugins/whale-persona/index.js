/** 把人格文件注入 DSH 系统提示。 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveTarget, repoRoot } from '../lib/runtime.js';

export const name = 'whale-persona';
export const inject = ['systemPrompt'];

export function readPersona(path) {
  try { return String(fs.readFileSync(path, 'utf8')).trim(); } catch { return ''; }
}

export function apply(ctx, config = {}) {
  const file = String(config.personaFile || path.join(repoRoot, 'personas', 'whale-agent.md'));
  const explicitTarget = Object.prototype.hasOwnProperty.call(config, 'targetSessionId');
  const targetSessionId = resolveTarget(config);
  const envScope = String(process.env.WHALE_SESSION_SCOPE || '');

  // 微信 headless：有 env scope 时沿用 profile 级 persona。
  // GUI：只给配置/ runtime state 里的目标 session 挂 section，其他 GUI 会话不注入。
  if (envScope || (!explicitTarget && !targetSessionId)) {
    const text = readPersona(file);
    if (text) ctx.systemPrompt.section({ name: 'whale-persona', order: 100, text });
    return;
  }
  if (!targetSessionId) return;

  ctx.on('agent/created', ({ agent } = {}) => {
    const sid = agent && agent.session && agent.session.id;
    if (!sid || String(sid) !== targetSessionId) return;
    if (!agent.ctx || !agent.ctx.systemPrompt) return;
    const text = readPersona(file);
    if (text) {
      agent.ctx.systemPrompt.section({ name: 'whale-persona', order: 100, text });
    }
  });
}

export default { name, inject, apply };
