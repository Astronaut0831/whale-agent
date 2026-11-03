import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataDir, append, stats, list, fileFor } from './corpus.js';

test('corpus append/stats rotates outside legacy src', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-corpus-'));
  try {
    setDataDir(dir);
    assert.equal(append('g1@chatroom', { ts: 1, name: 'a', uid: 'u', text: 'hi' }), true);
    const st = stats('g1@chatroom');
    assert.equal(st.lines, 1);
    assert.ok(fs.existsSync(fileFor('g1@chatroom')));
    assert.equal(list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
