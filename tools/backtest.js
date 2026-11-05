'use strict';

/**
 * 离线回测：取最近真实私聊，用 whale-headless 生成回复，与旧 bot 历史回复对比。
 * 不经过桥接、不发送微信。
 *
 * 用法：node tools/backtest.js [N]
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dbFile = path.join(root, 'data', 'bot.db');
const outFile = path.join(root, 'data', 'backtest.json');
const key = 'wechat:u:<WXID>';
const limit = Number(process.argv[2]) || 5;

(async () => {
  const { runHeadlessTurn } = await import('../plugins/platform-adapter/lib/headless.js');
  const { recallContext } = await import('../plugins/platform-adapter/lib/memory-context.js');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const token = String(((cfg.gateway || {}).wechat || {}).inboundToken || '');
  const db = new DatabaseSync(dbFile);
  const rows = db.prepare('SELECT role,text,ts FROM messages WHERE session=? ORDER BY ts ASC').all(key);
  db.close();

  const turns = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role !== 'user') continue;
    const next = rows[i + 1];
    turns.push({
      user: String(rows[i].text || ''),
      legacy: next && next.role === 'assistant' ? String(next.text || '') : '',
      ts: rows[i].ts,
    });
  }
  const picked = turns.filter((t) => t.user && t.legacy).slice(-limit);
  const store = new Map();
  const results = [];

  for (let i = 0; i < picked.length; i++) {
    const t = picked[i];
    const context = picked.slice(Math.max(0, i - 3), i)
      .map((x) => '用户：' + x.user + '\n她：' + x.legacy).join('\n');
    const mem = await recallContext({
      memoryUrl: 'http://127.0.0.1:8791', token, scope: key, query: t.user, isMaster: true,
    });
    const prompt = (mem ? mem + '\n\n' : '')
      + (context ? '最近对话：\n' + context + '\n\n' : '')
      + '用户：' + t.user + '\n\n请以“哦鲸鲸”的身份只回复最后这条用户消息，输出回复正文，不要解释。';
    process.stdout.write('[' + (i + 1) + '/' + picked.length + '] ' + t.user.slice(0, 30) + ' ... ');
    try {
      const out = await runHeadlessTurn({
        sessionKey: 'backtest-' + i,
        message: prompt,
        store: { get: (k) => store.get(k) || '', set: (k, v) => store.set(k, v) },
        profile: 'whale-headless',
        timeoutMs: 120000,
      });
      results.push({ user: t.user, agent: out.text, legacy: t.legacy, ms: null });
      console.log('ok');
    } catch (e) {
      results.push({ user: t.user, agent: '', legacy: t.legacy, error: String(e && e.message) });
      console.log('fail:', e && e.message);
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
  console.log('\nwritten', outFile);
  for (const r of results) {
    console.log('\n用户:', r.user.replace(/\n/g, ' ').slice(0, 80));
    console.log('agent :', String(r.agent || r.error || '').replace(/\n/g, ' ').slice(0, 120));
    console.log('legacy:', String(r.legacy || '').replace(/\n/g, ' ').slice(0, 120));
  }
})();
