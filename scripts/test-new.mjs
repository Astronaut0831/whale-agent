#!/usr/bin/env node
// Run the maintained DSH stack and test-runner regressions, not legacy tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = [
  'plugins/platform-adapter/test',
  'plugins/whale-memory-tools/test',
  'plugins/whale-memory-core/test',
  'plugins/whale-system-context/test',
  'plugins/whale-sticker-tool/test',
  'plugins/lib',
  'tools',
  'scripts',
];
const files = [];
for (const dir of roots) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (/\.test\.(?:js|mjs)$/.test(name)) files.push(path.join(dir, name));
  }
}
if (!files.length) {
  console.error('no new-stack tests found');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
