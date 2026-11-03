'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const memories = require('../src/memories');
const { runConsolidation } = require('./memory-maintenance');

test('夜间巩固：对现有会话跑完整 runOnce', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-maint-'));
  memories.setDataDir(dir);
  try {
    await memories.addMany('wechat:u:m', ['甲喜欢打羽毛球', '甲住在重庆'], { embedUrl: '' });
    const r = await runConsolidation({
      dataDir: dir,
      config: { memory: {} },
      llm: { complete: async () => '[]' },
    });
    assert.ok(r.keys >= 1);
    assert.equal(typeof r.merged, 'number');
    assert.equal(typeof r.replayed, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
