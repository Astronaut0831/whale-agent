import fs from 'node:fs';
import { createGuiBroker, extractTokenFromLog } from '../plugins/wechat-adapter/lib/gui-broker.js';

const log = fs.readFileSync('data/gui-3080.log', 'utf8');
const token = extractTokenFromLog(log);
if (!token) throw new Error('no token');
const sessionId = '<SESSION_ID>';
const b = createGuiBroker({ baseUrl: 'http://127.0.0.1:3080', token, sessionId, timeoutMs: 120000 });
const out = await Promise.all([
  b.prompt('并发测试A：只回复A'),
  b.prompt('并发测试B：只回复B'),
]);
console.log(JSON.stringify(out.map((x) => ({ text: x.text, turn: x.turn, seq: x.seq, traceId: x.traceId })), null, 2));
if (!(out[0].turn < out[1].turn && out[0].seq < out[1].seq)) {
  throw new Error('not serialized');
}
