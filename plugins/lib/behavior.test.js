import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataDir, get, set, reset, all } from './behavior.js';

test('behavior knobs are bounded and auditable outside src/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-behavior-'));
  try {
    setDataDir(dir);
    assert.equal(get('maxBubbles'), 2);
    assert.equal(set('maxBubbles', 9).value, 4);
    assert.equal(get('maxBubbles'), 4);
    assert.equal(set('maxBubbles', 'x').ok, false);
    assert.equal(get('unknown'), undefined);
    assert.deepEqual(Object.keys(all()).sort(), ['addressedCooldownSec', 'engagedMinutes', 'maxBubbles', 'mergeWindowMs']);
    assert.equal(reset().maxBubbles, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
