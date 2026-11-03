'use strict';

/**
 * 立刻触发一次记忆摘要（测试用）。
 * 用法：node tools/digest-now.js
 */

const fs = require('node:fs');
const path = require('node:path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const port = Number((cfg.server && cfg.server.port) || 8787);

(async () => {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:' + port + '/api/digest/run', { method: 'POST' });
  const d = await r.json();
  if (!d.ok) {
    console.log('失败:', JSON.stringify(d));
    process.exitCode = 1;
    return;
  }
  const items = Array.isArray(d.items) ? d.items : [];
  console.log('会话数:', items.length, '| 耗时', Math.round((Date.now() - t0) / 1000) + 's');
  for (const it of items) {
    console.log('-', it.key, '→', it.added, '条要点');
  }
  if (!items.length) console.log('（没有到触发条件的会话）');
})();
