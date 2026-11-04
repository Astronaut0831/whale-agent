/** 群聊历史：attention 打分需要最近发言，不依赖 DSH session。 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 2000;

export function createGroupHistory(file, { limit = 40 } = {}) {
  const dir = path.dirname(file);
  const append = (entry) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
      const size = fs.statSync(file).size;
      if (size > 2 * 1024 * 1024) {
        const keep = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
        fs.writeFileSync(file, keep.join('\n') + '\n', 'utf8');
      }
    } catch { /* ignore */ }
  };
  const load = (chatId, n = limit) => {
    try {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((x) => x && String(x.chatId) === String(chatId))
        .slice(-n);
    } catch { return []; }
  };
  const observe = ({ chatId, role, text, name = '', uid = '', msgId = '', ts = Date.now(), imagePath = '', mime = '' }) => {
    append({
      chatId: String(chatId), role, text: String(text || ''), name: String(name || ''), uid: String(uid || ''),
      msgId: String(msgId || ''), ts: Number(ts) || Date.now(),
      imagePath: String(imagePath || ''), mime: String(mime || ''),
    });
  };
  return { append, load, observe };
}
