/** 把记忆 HTTP 服务注册成 agent 工具。 */

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

export function registerMemoryTools(agentCtx, { memoryUrl, token = '', scope, isMaster = false, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!agentCtx || !agentCtx.tools || !memoryUrl || !scope) return false;

  const call = async (path, body) => {
    const r = await fetchImpl(String(memoryUrl).replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
      body: JSON.stringify({ scope, isMaster, ...body }),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 10000)),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data && data.error ? data.error : 'memory HTTP ' + r.status);
    return data;
  };

  agentCtx.tools.register({
    name: 'memory_recall',
    description: 'Recall long-term facts about this chat before answering when the user refers to something remembered. Returns relevant facts only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall' },
        limit: { type: 'number', description: 'Max facts, default 4' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } } },
      render: textRender,
    },
    async execute(args) {
      const d = await call('/recall', { query: String(args.query || ''), limit: Number(args.limit) || 4 });
      return { items: d.items || [] };
    },
  });

  agentCtx.tools.register({
    name: 'memory_add',
    description: 'Store one durable fact about the user or this chat. Only when the user says something worth remembering.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One atomic fact' },
        about: { type: 'string', description: 'user | her | relation | other' },
        importance: { type: 'number', description: '0..1' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { added: { type: 'number' }, ok: { type: 'boolean' } } },
      render: textRender,
    },
    async execute(args) {
      const d = await call('/add', {
        text: String(args.text || ''),
        about: String(args.about || 'user'),
        importance: Number(args.importance) || 0.7,
      });
      return { added: d.added || 0, ok: true };
    },
  });

  agentCtx.tools.register({
    name: 'memory_correct',
    description: 'Correct a previously remembered fact when the user says it is wrong. Marks the old fact outdated and stores the corrected one.',
    parameters: {
      type: 'object',
      properties: {
        old_hint: { type: 'string', description: 'Keyword of the old fact' },
        new_fact: { type: 'string', description: 'The corrected fact' },
      },
      required: ['new_fact'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { superseded: { type: 'number' }, ok: { type: 'boolean' } } },
      render: textRender,
    },
    async execute(args) {
      const d = await call('/correct', {
        oldHint: String(args.old_hint || ''),
        newFact: String(args.new_fact || ''),
      });
      return { superseded: d.superseded || 0, ok: true };
    },
  });

  return true;
}
