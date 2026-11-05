/**
 * Command metadata for the platform adapter.
 * This is the single source for /help visibility and future capability gating.
 *
 * surface:
 *   chat    — shown and handled in chat
 *   console — console only (implemented later)
 *
 * scope:
 *   all         — everyone
 *   owner       — owner only
 *   group-owner — owner in a group
 */
export const COMMANDS = [
  { name: 'help', desc: '查看命令', scope: 'all', platforms: 'all', category: '基础' },
  { name: 'status', desc: '运行状态（主人）', scope: 'owner', platforms: 'all', category: '基础' },
  { name: 'mute', desc: '闭麦 N 分钟（主人，群聊）', scope: 'group-owner', platforms: 'all', category: '群管理' },
  { name: 'unmute', desc: '解除闭麦（主人，群聊）', scope: 'group-owner', platforms: 'all', category: '群管理' },
  { name: 'talk', desc: '群说话频率：少/正常/多（主人，群聊）', scope: 'group-owner', platforms: 'all', category: '群管理' },
  { name: 'corpus', desc: '群语料收集开关（主人，群聊）', scope: 'group-owner', platforms: 'all', category: '群管理' },
  { name: 'proactive', desc: '群主动起话题开关（主人，群聊）', scope: 'group-owner', platforms: 'all', category: '群管理' },
  { name: 'care', desc: '主动关心开关（主人）', scope: 'owner', platforms: 'all', category: '行为' },
  { name: 'remind', desc: '提醒列表/取消（主人）', scope: 'owner', platforms: 'all', category: '行为' },
  { name: 'behavior', desc: '行为参数（主人）', scope: 'owner', platforms: 'all', category: '行为' },
  { name: 'pref', desc: '全局规矩（主人）', scope: 'owner', platforms: 'all', category: '行为' },
  { name: 'facts', desc: '长期记忆搜索/详情/删除/恢复', scope: 'all', platforms: 'all', category: '记忆', capabilities: ['memory'] },
  { name: 'memory', desc: '记忆概览', scope: 'all', platforms: 'all', category: '记忆', capabilities: ['memory'] },
  { name: 'backup', desc: '记忆快照（主人）', scope: 'owner', platforms: 'all', category: '记忆' },
  { name: 'task', desc: '后台任务 list/cancel/指令（主人）', scope: 'owner', platforms: 'all', category: '任务' },
  { name: 'set', desc: '行为配置（主人）', scope: 'owner', platforms: 'all', category: '配置' },
  { name: 'digest', desc: '手动记忆摘要（主人）', scope: 'owner', platforms: 'all', category: '记忆' },
  { name: 'usage', desc: 'token 用量', scope: 'all', platforms: 'all', category: '基础' },
  { name: 'persona', desc: '人设编辑', scope: 'owner', platforms: 'all', surface: 'console', category: '控制台' },
  { name: 'listen', desc: '平台接入白名单', scope: 'owner', platforms: 'all', surface: 'console', category: '控制台' },
  { name: 'online', desc: '平台上线', scope: 'owner', platforms: 'all', surface: 'console', category: '控制台' },
  { name: 'offline', desc: '平台下线', scope: 'owner', platforms: 'all', surface: 'console', category: '控制台' },
  // Removed from the unified architecture; keep metadata only so future /help
  // doesn't accidentally advertise them again.
  { name: 'agent', desc: '后台 agent（已移除）', scope: 'owner', platforms: 'all', removed: true },
  { name: 'ls', desc: '列目录（已移除）', scope: 'owner', platforms: 'all', removed: true },
  { name: 'sendfile', desc: '发文件（已移除）', scope: 'owner', platforms: 'all', removed: true },
  { name: 'dl', desc: '下载 URL（已移除）', scope: 'owner', platforms: 'all', removed: true },
  { name: 'run', desc: '执行脚本（已移除）', scope: 'owner', platforms: 'all', removed: true },
];

export function commandAvailable(cmd, ctx = {}) {
  if (!cmd || cmd.removed) return false;
  if (cmd.surface && cmd.surface !== 'chat') return false;
  if (cmd.platforms !== 'all' && !(Array.isArray(cmd.platforms) ? cmd.platforms : [cmd.platforms]).includes(ctx.platform)) return false;
  if (cmd.chatTypes && !cmd.chatTypes.includes(ctx.chatType)) return false;
  if (cmd.scope === 'owner' && !ctx.isMaster) return false;
  if (cmd.scope === 'group-owner' && (!ctx.isMaster || ctx.chatType !== 'group')) return false;
  if (Array.isArray(cmd.capabilities) && cmd.capabilities.some((c) => !(ctx.capabilities instanceof Set ? ctx.capabilities.has(c) : (ctx.capabilities || []).includes(c)))) return false;
  return true;
}

export function helpText(ctx = {}) {
  const byGroup = new Map();
  for (const cmd of COMMANDS) {
    if (!commandAvailable(cmd, ctx)) continue;
    const category = cmd.category || '其他';
    if (!byGroup.has(category)) byGroup.set(category, []);
    byGroup.get(category).push(cmd);
  }
  return [...byGroup.entries()]
    .map(([group, list]) => '【' + group + '】\n' + list.map((c) => '/' + c.name + '  ' + c.desc).join('\n'))
    .join('\n\n');
}
