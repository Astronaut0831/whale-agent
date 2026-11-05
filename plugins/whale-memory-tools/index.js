/** 给 headless 启动的 agent 注册记忆工具（scope 来自环境变量）。 */

import { registerMemoryTools } from '../platform-adapter/lib/memory-tools.js';
import { resolveTarget, resolveMemoryToken } from '../lib/runtime.js';

export const name = 'whale-memory-tools';
export const inject = ['agents'];

export function resolveScope(agent, config = {}, envScope = '') {
  const env = String(envScope || '');
  if (env) return env;
  const target = String(config.targetSessionId || '');
  const sid = agent && agent.session && agent.session.id;
  if (!target || !sid || String(sid) !== target) return '';
  return String(config.scope || '');
}

export function resolveIsMaster(config = {}, env = process.env) {
  if (config.isMaster !== undefined) {
    return config.isMaster === true || String(config.isMaster || '').toLowerCase() === 'true';
  }
  return String(env.WHALE_IS_MASTER || '') === '1';
}

export function apply(ctx, config = {}) {
  const registered = new Set();
  const attach = (agent) => {
    if (!agent || !agent.ctx) return;
    const sid = agent.session && agent.session.id;
    if (!sid || registered.has(String(sid))) return;
    const effective = { ...config, targetSessionId: resolveTarget(config) };
    // 微信 headless：env scope 优先；GUI：只给目标 session 注册工具。
    const scope = resolveScope(agent, effective, process.env.WHALE_SESSION_SCOPE);
    if (!scope) return;
    const ok = registerMemoryTools(agent.ctx, {
      memoryUrl: String(process.env.WHALE_MEMORY_URL || config.memoryUrl || 'http://127.0.0.1:8791'),
      token: resolveMemoryToken(config) || String(process.env.WHALE_MEMORY_TOKEN || ''),
      scope,
      isMaster: resolveIsMaster(config, process.env),
    });
    if (ok) registered.add(String(sid));
  };
  ctx.on('agent/created', ({ agent } = {}) => attach(agent));
  // Resumed target agents can predate this plugin; attach before their next turn.
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/start' || !session) return;
    const target = resolveTarget(config);
    if (!target || String(session.id) !== target) return;
    const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(session.id) : null;
    if (agent) attach(agent);
  });
}

export default { name, inject, apply };
