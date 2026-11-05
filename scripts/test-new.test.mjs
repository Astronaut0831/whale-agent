import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const runner = fileURLToPath(new URL('./test-new.mjs', import.meta.url));

for (const directory of ['tools', 'plugins/whale-sticker-tool/test']) {
  test(`new-stack runner includes ${directory} tests`, () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-test-discovery-'));
    try {
      // Keep an existing root present: a successful run must not hide omissions.
      const baseline = path.join(cwd, 'plugins/lib');
      const target = path.join(cwd, directory);
      fs.mkdirSync(baseline, { recursive: true });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(baseline, 'baseline.test.js'),
        "require('node:test')('baseline sentinel', () => {});\n");
      fs.writeFileSync(path.join(target, 'sentinel.test.js'),
        "require('node:test')('discovery target sentinel', () => {});\n");
      const result = spawnSync(process.execPath, [runner], {
        cwd, encoding: 'utf8', timeout: 30000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(result.stdout, /discovery target sentinel/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('new-stack runner fails when no tests are discovered', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-test-empty-'));
  try {
    const result = spawnSync(process.execPath, [runner], {
      cwd, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no new-stack tests found/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
