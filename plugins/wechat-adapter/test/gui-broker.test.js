import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuiBroker, extractTokenFromLog } from '../lib/gui-broker.js';

function json(value, headers = {}) {
  return { ok: true, status: 200, headers: { getSetCookie: () => [], get: () => null, ...headers }, text: async () => JSON.stringify(value) };
}

function serverResponse(value, ok = true) {
  return json({ type: 'server-response', rpcId: 'r', result: ok ? { ok: true, value } : { ok: false, error: { message: value } } });
}

function item({ seq = 10, response = '', running = false, updated = 1000, prompt = '' } = {}) {
  return {
    sessionId: 'target',
    running,
    updatedAt: updated,
    projections: {
      asOfSeq: seq,
      values: { turnOutline: [{ turn: 1, seq, prompt, response }] },
    },
  };
}

test('extractTokenFromLog', () => {
  assert.equal(extractTokenFromLog('dsh web: http://127.0.0.1:3080/?token=abc-def'), 'abc-def');
  assert.equal(extractTokenFromLog('?token=old\n?token=new'), 'new');
  assert.equal(extractTokenFromLog('no token'), '');
});

test('prompt sends args.request and reads turnOutline reply', async () => {
  let phase = 'before';
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (String(url).includes('/?token=')) return json({}, { getSetCookie: () => ['dsh-auth=x; Path=/'] });
    if (String(url).endsWith('/api/session/list')) {
      const old = item({ seq: 10, response: '旧回复', updated: 1000 });
      const fresh = item({ seq: 20, response: '新回复', updated: 2000, prompt: '你好' });
      return serverResponse({ items: [phase === 'before' ? old : fresh] });
    }
    if (String(url).endsWith('/api/session/prompt')) {
      phase = 'after';
      return serverResponse({ accepted: true });
    }
    throw new Error('unexpected ' + url);
  };
  const broker = createGuiBroker({
    baseUrl: 'http://gui', token: 't', sessionId: 'target',
    fetchImpl, sleep: async () => {}, now: () => 1,
  });
  const out = await broker.prompt('你好');
  assert.equal(out.text, '新回复');
  const promptCall = calls.find((c) => c.url.endsWith('/api/session/prompt'));
  const body = JSON.parse(promptCall.opts.body);
  assert.equal(body.payload.args.request.sessionId, 'target');
  assert.equal(body.payload.args.request.content[0].text, '你好');
  assert.equal(body.payload.args.request.mode, 'queue');
});

test('enabled=false equivalent: broker throws instead of silently succeeding', async () => {
  const broker = createGuiBroker({
    baseUrl: 'http://gui', token: 't', sessionId: 'target',
    fetchImpl: async (url) => String(url).includes('/?token=')
      ? json({}, { getSetCookie: () => ['dsh-auth=x'] })
      : serverResponse({ items: [] }),
    sleep: async () => {}, now: () => 1,
  });
  await assert.rejects(() => broker.prompt('x'), /target session not visible/);
});

test('serializes concurrent prompts', async () => {
  const order = [];
  let n = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/?token=')) return json({}, { getSetCookie: () => ['dsh-auth=x'] });
    if (String(url).endsWith('/api/session/list')) {
      return serverResponse({ items: [item({ seq: 10 + n, response: 'reply' + n, updated: 1000 + n })] });
    }
    if (String(url).endsWith('/api/session/prompt')) {
      n += 1;
      order.push('prompt' + n);
      return serverResponse({ accepted: true });
    }
    throw new Error('unexpected');
  };
  const broker = createGuiBroker({
    baseUrl: 'http://gui', token: 't', sessionId: 'target',
    fetchImpl, sleep: async () => {}, now: () => 1,
  });
  const [a, b] = await Promise.all([broker.prompt('a'), broker.prompt('b')]);
  assert.equal(a.text, 'reply1');
  assert.equal(b.text, 'reply2');
  assert.deepEqual(order, ['prompt1', 'prompt2']);
});
