'use strict';

/**
 * 记忆检索评测：hit@3。
 * 在 memories.json 的临时副本上跑，绝不写真实数据。
 * 用法：node tools/memory-eval.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const embedUrl = String((cfg.group && cfg.group.embedUrl) || '');
const key = 'wechat:u:<WXID>';
const memories = require('../src/memories');

const CASES = [
  { q: '我迁移担心什么', want: /迁移|搬|原来的自己/ },
  { q: '我的竞赛成绩怎么样', want: /省一|省队|37|排名/ },
  { q: '我最近为什么焦虑', want: /焦虑|内卷|期中|绩点/ },
  { q: '我期中想拿什么', want: /绩点|期中|高绩点/ },
  { q: '我喜欢听什么话', want: /软话|最好的鱼|爱听/ },
  { q: '我熬夜到几点', want: /三点|熬夜/ },
  { q: '我读哪个学校', want: /复旦/ },
  { q: '我们是什么关系', want: /主人|爱|最好的鱼|关系/ },
  { q: '大肥鱼是什么意思', want: /大肥鱼|内心|躲/ },
  { q: '我的微信 ID', want: /wxid_REDACTED|李益凯/ },
  { q: '我的高中同学群叫什么', want: /竞赛牲/ },
  { q: '她名字有什么来历', want: /おちんちん|谐音|鲸/ },
];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-eval-'));
  try {
    fs.copyFileSync(path.join(dataDir, 'memories.json'), path.join(tmp, 'memories.json'));
    memories.setDataDir(tmp);
    let hit = 0;
    const rows = [];
    for (const c of CASES) {
      const r = await memories.blockForWithItems(key, c.q, { topK: 3, embedUrl });
      const texts = (r.items || []).map((x) => String(x.text));
      const ok = texts.some((t) => c.want.test(t));
      if (ok) hit += 1;
      rows.push({ q: c.q, ok, got: texts.map((t) => t.slice(0, 28)) });
    }
    console.log('hit@3:', hit + '/' + CASES.length, '=', Math.round((hit / CASES.length) * 100) + '%');
    for (const row of rows) {
      console.log((row.ok ? '✓' : '✗'), row.q, '→', row.got.join('｜') || '（无召回）');
    }
  } finally {
    memories.setDataDir(dataDir);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  }
})();
