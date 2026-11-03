'use strict';

/**
 * 切换 adapter 模式：off | shadow | active | status
 * 用法：node tools/core-mode.js shadow
 */

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'data', 'core-mode.json');
const valid = ['off', 'shadow', 'active'];
const arg = String(process.argv[2] || 'status').toLowerCase();

function read() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { mode: 'off' }; }
}

if (arg === 'status') {
  console.log(read());
  process.exit(0);
}

if (!valid.includes(arg)) {
  console.error('用法: node tools/core-mode.js off|shadow|active|status');
  process.exit(1);
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ mode: arg }), 'utf8');
console.log('core mode =', arg);
