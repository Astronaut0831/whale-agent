import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prefsBlock, selfnoteBlock } from './context-data.js';

test('context data reads prefs and selfnotes without src/ modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-context-data-'));
  fs.writeFileSync(path.join(dir, 'preferences.json'), '\uFEFF' + JSON.stringify({ items: [{ text: '早睡' }] }));
  fs.writeFileSync(path.join(dir, 'selfnotes.json'), JSON.stringify({ items: [{ text: '爱较真' }] }));
  try {
    assert.match(prefsBlock({ dataDir: dir }), /早睡/);
    assert.match(selfnoteBlock({ dataDir: dir }), /爱较真/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
