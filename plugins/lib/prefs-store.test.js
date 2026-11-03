import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataDir, all, add, removeByIndex } from './prefs-store.js';

test('prefs store supports list/add/remove outside src/', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-prefs-'));
  try {
    setDataDir(dir);
    assert.deepEqual(all(), []);
    await add('说话不超过两句', { source: 'test' });
    await add('说话不超过两句', { source: 'test' });
    assert.equal(all().length, 1);
    assert.equal(all()[0].text, '说话不超过两句');
    assert.equal(removeByIndex(1).text, '说话不超过两句');
    assert.equal(all().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
