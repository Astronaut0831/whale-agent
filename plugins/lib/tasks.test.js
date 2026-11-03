import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataDir, enqueue, next, update, list, markInterrupted } from './tasks.js';

test('task queue persists outside legacy src', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-tasks-'));
  try {
    setDataDir(dir);
    const t = enqueue({ chatId: 'c', chatType: 'private', ownerId: 'o', instruction: 'do it' });
    assert.ok(t.id);
    const n = next();
    assert.equal(n.id, t.id);
    update(t.id, { status: 'done', result: 'ok' });
    assert.equal(list().length, 1);
    assert.equal(markInterrupted(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
