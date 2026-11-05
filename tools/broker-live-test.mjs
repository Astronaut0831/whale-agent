import fs from 'node:fs';
import { createGuiBroker, extractTokenFromLog } from '../plugins/platform-adapter/lib/gui-broker.js';

const log = fs.readFileSync('data/gui-3080.log', 'utf8');
const token = extractTokenFromLog(log);
const b = createGuiBroker({
  baseUrl: 'http://127.0.0.1:3080',
  token,
  sessionId: '<SESSION_ID>',
  timeoutMs: 120000,
});
console.log('token?', Boolean(token), 'health', await b.health());
const out = await b.prompt(process.argv[2] || '自测：broker 注入，只回复收到。');
console.log(JSON.stringify(out).slice(0, 500));
