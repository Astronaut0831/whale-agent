import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGuiInputStore } from '../lib/gui-input-store.js';

test('gui input jobs survive store recreation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gui-jobs-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const a = createGuiInputStore(file, { max: 3 });
    a.set('r1', { status: 'queued', text: 'x', at: 1 });
    a.set('r2', { status: 'done', at: 2 });
    const b = createGuiInputStore(file, { max: 3 });
    b.load();
    assert.equal(b.size, 2);
    assert.equal(b.get('r1').status, 'queued');
    assert.equal(b.get('r2').status, 'done');
    b.delete('r1');
    const c = createGuiInputStore(file, { max: 3 });
    c.load();
    assert.equal(c.get('r1'), undefined);
    assert.equal(c.size, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
