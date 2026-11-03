#!/usr/bin/env node
// Run only the new DSH memory/adapter stack tests; legacy tests are separate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = [
  'plugins/wechat-adapter/test',
  'plugins/whale-memory-tools/test',
  'plugins/whale-memory-core/test',
  'plugins/whale-system-context/test',
  'plugins/lib',
];
const files = [];
for (const dir of roots) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.test.js')) files.push(path.join(dir, name));
  }
}
if (!files.length) {
  console.error('no new-stack tests found');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
