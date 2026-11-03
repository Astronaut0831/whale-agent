/** 给 headless agent 注册 send_sticker 工具：入队后由桥接发送。 */

export const name = 'whale-sticker-tool';
export const inject = ['agents'];

export function chatIdOfScope(scope) {
  return String(scope || '').replace(/^wechat:[ug]:/, '');
}

export function registerStickerTool(agentCtx, { adapterUrl, token = '', scope, fetchImpl = fetch } = {}) {
  if (!agentCtx || !agentCtx.tools || !scope) return false;
  const chatId = chatIdOfScope(scope);
  if (!chatId) return false;
  agentCtx.tools.register({
    name: 'send_sticker',
    description: 'Send one sticker/emoji image from the local sticker library. Use only when a sticker truly fits; do not use for every message.',
    parameters: {
      type: 'object',
      properties: {
        emotion: { type: 'string', description: 'Emotion category, e.g. cute, angry, meh, happy' },
      },
      required: ['emotion'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, jobId: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const r = await fetchImpl(String(adapterUrl).replace(/\/+$/, '') + '/api/stickers/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
        body: JSON.stringify({ chatId, emotion: String(args.emotion || 'meh') }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || 'sticker enqueue failed');
      return { ok: true, jobId: String((d.job && d.job.id) || '') };
    },
  });
  return true;
}

export function apply(ctx, config = {}) {
  ctx.on('agent/created', ({ agent } = {}) => {
    const scope = String(process.env.WHALE_SESSION_SCOPE || '');
    if (!scope || !agent || !agent.ctx) return;
    registerStickerTool(agent.ctx, {
      adapterUrl: String(process.env.WHALE_ADAPTER_URL || config.adapterUrl || 'http://127.0.0.1:8788'),
      token: String(process.env.WHALE_MEMORY_TOKEN || config.token || ''),
      scope,
    });
  });
}

export default { name, inject, apply };
