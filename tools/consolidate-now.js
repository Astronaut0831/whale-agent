'use strict';

/**
 * 立刻触发一次记忆巩固（后台任务 + 轮询状态），测试用。
 * 用法：node tools/consolidate-now.js
 */

const fs = require('node:fs');
const path = require('node:path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const port = Number((cfg.server && cfg.server.port) || 8787);
const base = 'http://127.0.0.1:' + port;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const start = await fetch(base + '/api/memory/consolidate', { method: 'POST' });
  const sd = await start.json();
  console.log('启动:', JSON.stringify(sd));
  const t0 = Date.now();
  for (;;) {
    await sleep(5000);
    const r = await fetch(base + '/api/memory/consolidate/status');
    const d = await r.json();
    const j = d.job || {};
    if (!j.running) {
      console.log('完成，用时', Math.round((Date.now() - t0) / 1000) + 's');
      console.log('结果:', JSON.stringify(j.result || { error: j.error }));
      break;
    }
    console.log('运行中…', Math.round((Date.now() - t0) / 1000) + 's');
  }
})();
