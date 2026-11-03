// 从历史消息里抽取原子事实，灌进记忆库
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('D:/dsh-workspace/chat/whale_gril/config.json', 'utf8'));
cfg.paths = { settingsFile: 'D:/dsh-workspace/chat/whale_gril/data/settings.json' };
const { DeepSeekClient } = require('D:/dsh-workspace/chat/whale_gril/src/llm');
const memories = require('D:/dsh-workspace/chat/whale_gril/src/memories');

const logger = { info: console.log, warn: console.log, debug: () => {}, error: console.log };
const llm = new DeepSeekClient({ config: cfg, logger });
const embedUrl = String((cfg.group && cfg.group.embedUrl) || '');

const store = JSON.parse(fs.readFileSync('D:/dsh-workspace/chat/whale_gril/data/store.json', 'utf8'));

const SYSTEM = [
  '从这段群聊里抽**可以长期记住的事实**，写成一句一条的短句（不超过 30 字）。',
  '只抽这些：人物设定（名字/身份/习惯/脾气/关系）、固定梗和约定、发生过的关键事件、群里长期在忙的事。',
  '忽略：一次性的问答、寒暄、她自己说了什么。',
  '没有值得记的就输出 []。',
  '输出 JSON 数组，元素形如 {"fact":"氧化钙芼叔：不许提棍木"}，最多 8 条，不要解释。',
].join('\n');

const CHUNK = 60;

(async () => {
  for (const key of Object.keys(store.sessions)) {
    const msgs = (store.sessions[key].messages || []).filter((m) => m.text);
    if (msgs.length < 30) continue;
    console.log(`\n=== ${key}（${msgs.length} 条）===`);
    for (let i = 0; i < msgs.length; i += CHUNK) {
      const chunk = msgs.slice(i, i + CHUNK);
      const text = chunk.map((m) => `${m.role === 'assistant' ? '她' : (m.name || '群友')}：${String(m.text).slice(0, 120)}`).join('\n');
      try {
        const out = await llm.complete({ system: SYSTEM, turns: [{ role: 'user', content: text }], maxTokens: 2500, skipGovernor: true });
        const m = String(out || '').match(/\[[\s\S]*\]/);
        if (!m) { console.log(`  段 ${i / CHUNK + 1}: 无`); continue; }
        const arr = JSON.parse(m[0]).map((x) => String((x && x.fact) || '').trim()).filter(Boolean);
        if (!arr.length) { console.log(`  段 ${i / CHUNK + 1}: 无`); continue; }
        const r = await memories.addMany(key, arr, { embedUrl, source: '历史抽取' });
        console.log(`  段 ${i / CHUNK + 1}: 抽 ${arr.length} 条 → 新增 ${r.added}，合并 ${r.merged}`);
      } catch (e) {
        console.log(`  段 ${i / CHUNK + 1} 失败: ${e.message}`);
      }
    }
  }
  console.log('\n=== 最终 ===');
  for (const key of Object.keys(store.sessions)) {
    console.log(`${key}: ${memories.stats(key).count} 条`);
  }
})();
