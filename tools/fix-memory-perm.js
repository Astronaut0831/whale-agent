// A：/memory 行为统一为"群共享小本本"，并让 /facts 的"看"对所有人开放（删仍限主人）
const fs = require('fs');
const p = 'D:/dsh-workspace/chat/whale_gril/src/bot.js';
let s = fs.readFileSync(p, 'utf8');

// ---------- 1) /memory 重写 ----------
const oldStart = '      case \'memory\': {';
const oldEnd = "        return finish(`本鲸的小本本：${parts.join('｜')}`.slice(0, 400));\n      }";

const startIdx = s.indexOf(oldStart);
const endIdx = s.indexOf(oldEnd, startIdx);

if (startIdx > 0 && endIdx > 0) {
  const newBlock = [
    "      case 'memory': {",
    '        // 有人把「/memory 李益凯：wxid_xxx」当"记住"用，带参数时转给 remember',
    '        if (command.arg && command.arg.trim() && !/^(搜|搜索|找|查)/.test(command.arg.trim())) {',
    "          command = { ...command, type: 'remember', arg: command.arg };",
    '          return this.runCommand({ command, msg, key, profile, state, nowMs, atMe, isMaster });',
    '        }',
    '        // 群共享：所有人都能看整本小本子（不做按人隔离）',
    '        const rows = this.store.listNotes(key);',
    '        if (!rows.length) {',
    "          return finish('人家还什么都没记住呢。想让我记住就说「记住：你怕黑」这种，我就能记好久…大概。');",
    '        }',
    '        const ask = String(command.arg || "").trim().replace(/^(搜|找|查)[\\s:：]*/, "");',
    '        const order = rows.slice().sort((a, b) => (b.uid === msg.senderId ? 1 : 0) - (a.uid === msg.senderId ? 1 : 0));',
    '        const lines = [];',
    '        for (const r of order) {',
    '          const notes = r.notes.filter((n) => !ask || String(n).includes(ask));',
    '          if (!notes.length) continue;',
    "          const who = r.uid === msg.senderId ? '你' : r.name;",
    '          lines.push(`${who}：${notes.join("；")}`);',
    '        }',
    '        if (!lines.length) return finish(`小本本里没有和「${ask}」有关的。`);',
    '        const head = ask ? `和「${ask}」有关的：` : `小本本（全群共享，共 ${rows.length} 人）：`;',
    '        return finish((head + "\\n" + lines.join("\\n")).slice(0, 600));',
    '      }',
  ].join('\n');
  s = s.slice(0, startIdx) + newBlock + s.slice(endIdx + oldEnd.length);
  console.log('OK /memory 重写');
} else {
  console.log('!! /memory 块没匹配');
}

// ---------- 2) /facts 读开放，删仍限主人 ----------
s = s.replace(
  "      case 'facts': {\n        if (!isMaster) return finish('这个只有主人能看。');",
  "      case 'facts': {"
);
s = s.replace(
  "        if (/^(删|删除|忘掉|forget)/.test(arg)) {",
  "        if (/^(删|删除|忘掉|forget)/.test(arg)) {\n          if (!isMaster) return finish('删记忆只有主人能做。');"
);

// ---------- 3) 权限表：facts 不再整体限主人 ----------
s = s.replace(
  "const MASTER_ONLY_COMMANDS = new Set(['persona', 'set', 'pref', 'digest', 'facts', 'usage', 'backup', 'dl', 'ls', 'run', 'reset', 'mute', 'unmute', 'status']);",
  "const MASTER_ONLY_COMMANDS = new Set(['persona', 'set', 'pref', 'digest', 'usage', 'backup', 'dl', 'ls', 'run', 'reset', 'mute', 'unmute', 'status']);"
);

// ---------- 4) /help 调整 ----------
s = s.replace(
  "  { group: '主人', usage: '/facts', what: '看/搜/删长期事实（/facts 删 3）' },",
  "  { group: '所有人', usage: '/facts', what: '看/搜长期事实（删只有主人能做）' },\n  { group: '主人', usage: '/facts 删 3', what: '删一条长期事实' },"
);

fs.writeFileSync(p, s, 'utf8');
console.log('完成');
