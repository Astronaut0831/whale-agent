// 清理测试用合成消息：msg_id 不含 ":" 的都是我通过 webhook 注入的
// （真实桥接消息的 id 形如 "<GROUP_ID_B>:message__message_0.db:24"）
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = 'D:/dsh-workspace/chat/whale_gril/data/bot.db';
fs.copyFileSync(dbPath, dbPath + '.before-cleanup');
console.log('已备份:', dbPath + '.before-cleanup');

const db = new DatabaseSync(dbPath);
const synthetic = db.prepare("SELECT id, session, ts, role, text FROM messages WHERE msg_id IS NOT NULL AND msg_id NOT LIKE '%:%'").all();
console.log('合成消息:', synthetic.length, '条');

let removed = 0;
const del = db.prepare('DELETE FROM messages WHERE id = ?');
for (const m of synthetic) {
  // 连带删掉紧跟其后的她的回复（同会话、3 条以内、90 秒内）
  const replies = db.prepare(
    "SELECT id FROM messages WHERE session = ? AND id > ? AND id <= ? AND role = 'assistant' AND ts - ? < 90000"
  ).all(m.session, m.id, m.id + 3, m.ts);
  for (const r of replies) {
    del.run(r.id);
    removed += 1;
  }
  del.run(m.id);
  removed += 1;
}
console.log('删除合计（含她的回复）:', removed);

const left = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
console.log('剩余消息:', left);
for (const r of db.prepare('SELECT session, COUNT(*) AS n FROM messages GROUP BY session').all()) {
  console.log(' ', r.session, r.n);
}
db.close();
