import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTarget, resolveMemoryToken } from './runtime.js';

test('runtime state supplies target/token when profile is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-runtime-'));
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, JSON.stringify({ guiSessionId: 'sid-1', memoryToken: 'tok-1' }));
  try {
    assert.equal(resolveTarget({ runtimeFile: file }), 'sid-1');
    assert.equal(resolveTarget({ runtimeFile: file, targetSessionId: 'explicit' }), 'explicit');
    assert.equal(resolveMemoryToken({ runtimeFile: file }), 'tok-1');
    assert.equal(resolveMemoryToken({ runtimeFile: file, token: 'explicit-token' }), 'explicit-token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime state tolerates UTF-8 BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-runtime-bom-'));
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ guiSessionId: 'sid-bom', memoryToken: 'tok-bom' }));
  try {
    assert.equal(resolveTarget({ runtimeFile: file }), 'sid-bom');
    assert.equal(resolveMemoryToken({ runtimeFile: file }), 'tok-bom');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
