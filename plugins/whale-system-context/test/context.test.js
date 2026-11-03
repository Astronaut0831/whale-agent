import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContextText, apply } from '../index.js';

test('context text includes rules, self note, memory policy', () => {
  const text = buildContextText({ WHALE_PREFS_BLOCK: '规则A', WHALE_SELFNOTE_BLOCK: '自省B' });
  assert.match(text, /规则A/);
  assert.match(text, /自省B/);
  assert.match(text, /memory_recall/);
});

test('apply registers a systemPrompt section', () => {
  const sections = [];
  apply({ systemPrompt: { section: (s) => sections.push(s) } }, { env: { WHALE_PREFS_BLOCK: '规则A' } });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'whale-context');
});

test('targetSessionId 只注入目标会话', () => {
  const handlers = [];
  apply({
    systemPrompt: { section: () => {} },
    on: (name, cb) => { if (name === 'agent/created') handlers.push(cb); },
  }, { targetSessionId: 'target', env: { WHALE_PREFS_BLOCK: '规则T' } });
  const other = [];
  const target = [];
  handlers[0]({ agent: { session: { id: 'other' }, ctx: { systemPrompt: { section: (s) => other.push(s) } } } });
  handlers[0]({ agent: { session: { id: 'target' }, ctx: { systemPrompt: { section: (s) => target.push(s) } } } });
  assert.equal(other.length, 0);
  assert.equal(target.length, 1);
  assert.match(target[0].text, /规则T/);
});

test('targetSessionId 为空时从 runtime 解析 target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-context-runtime-'));
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ guiSessionId: 'runtime-target' }));
  try {
    const handlers = [];
    apply({
      systemPrompt: { section: () => {} },
      on: (name, cb) => { if (name === 'agent/created') handlers.push(cb); },
    }, { targetSessionId: '', runtimeFile: file, env: { WHALE_PREFS_BLOCK: '规则R' } });
    const other = [];
    const target = [];
    handlers[0]({ agent: { session: { id: 'other' }, ctx: { systemPrompt: { section: (s) => other.push(s) } } } });
    handlers[0]({ agent: { session: { id: 'runtime-target' }, ctx: { systemPrompt: { section: (s) => target.push(s) } } } });
    assert.equal(other.length, 0);
    assert.equal(target.length, 1);
    assert.match(target[0].text, /规则R/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
