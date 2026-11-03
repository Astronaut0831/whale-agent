import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../client.js', import.meta.url));
const source = fs.readFileSync(file, 'utf8');

function loadModule(fetchImpl) {
  let loaded;
  const window = { __ModuleLoader__: { load: (m) => { loaded = m; } } };
  new Function('window', source)(window);
  const exports = loaded.factory(() => { throw new Error('no require'); });
  const conv = {
    calls: [],
    async send(text) { this.calls.push(['send', text]); },
    async sendSession(session, text, ids, mode) { this.calls.push(['sendSession', session, text, ids, mode]); },
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  exports.apply({ conversation: conv, get: () => conv });
  return { conv, exports, restore: () => { globalThis.fetch = oldFetch; } };
}

test('GUI send 走 broker，成功时不直接提交', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ ok: true }) }; };
  const { conv, restore } = loadModule(fetchImpl);
  try {
    await conv.send('hello');
    assert.equal(calls.length, 1);
    assert.equal(conv.calls.length, 0);
  } finally { restore(); }
});

test('broker 端点失败时回退原提交', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return { ok: false, status: 503, json: async () => ({ ok: false }) }; };
  const { conv, restore } = loadModule(fetchImpl);
  try {
    await conv.send('fallback');
    assert.equal(calls.length, 1);
    assert.deepEqual(conv.calls[0], ['send', 'fallback']);
  } finally { restore(); }
});

test('带附件的 sendSession 不劫持', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ ok: true }) }; };
  const { conv, restore } = loadModule(fetchImpl);
  try {
    await conv.sendSession('s1', 'with-file', ['a1'], 'queue');
    assert.equal(calls.length, 0);
    assert.deepEqual(conv.calls[0], ['sendSession', 's1', 'with-file', ['a1'], 'queue']);
  } finally { restore(); }
});
