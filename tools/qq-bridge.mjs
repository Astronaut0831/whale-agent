#!/usr/bin/env node
/**
 * QQ official transport bridge.
 * QQ Gateway -> adapter /webhook/qq; adapter outbox(platform=qq) -> QQ OpenAPI.
 * It never creates an agent itself: DSH persona/memory stay in the adapter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe as describeImage } from '../plugins/lib/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CRED_FILE = process.env.QQ_CRED_FILE || path.join(DATA, 'qq-credentials.json');
const STATE_FILE = path.join(DATA, 'qq-bridge-state.json');
const ADAPTER = (process.env.QQ_ADAPTER_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
function adapterToken() {
  if (process.env.QQ_ADAPTER_TOKEN) return process.env.QQ_ADAPTER_TOKEN;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return String(c.gateway && c.gateway.wechat && c.gateway.wechat.inboundToken || '');
  } catch { return ''; }
}
const TOKEN = adapterToken();
const SDK = process.env.QQBOT_SDK || 'C:/Users/astronaut/.dsh/profiles/web/node_modules/@tencent-connect/qqbot-nodejs/dist/index.js';

function log(...args) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + args.map(String).join(' ');
  console.log(line);
  try {
    fs.appendFileSync(path.join(DATA, 'qq-bridge.log'), line + '\n');
  } catch { /* ignore */ }
}

function creds() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { /* env fallback */ }
  const appId = String(c.appId || process.env.QQBOT_APPID || '');
  const appSecret = String(c.appSecret || process.env.QQBOT_SECRET || '');
  if (!appId || !appSecret) throw new Error('missing QQBOT_APPID/QQBOT_SECRET or ' + CRED_FILE);
  return { appId, appSecret };
}

function appConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; }
}

async function mediaText(msg) {
  const parts = [];
  const sender = String(msg.senderName || 'QQ用户');
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  for (const a of attachments.slice(0, 3)) {
    const type = String(a.content_type || '');
    if (type.startsWith('image/')) {
      try {
        const r = await fetch(a.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
        const desc = await describeImage(appConfig(), {
          imageBase64: b64, mime: type,
          prompt: '这是QQ聊天里的图片。只描述能确定的内容：人物、动作、物品、场景、文字；不要猜。不超过60字。',
        });
        parts.push('【图片（' + sender + '）】' + String(desc || '').trim());
      } catch (e) {
        parts.push('【图片（' + sender + '）】（没看清：' + String(e && e.message || e).slice(0, 80) + '）');
      }
    } else if (type === 'voice') {
      const asr = String(a.asr_refer_text || '').trim();
      parts.push('【语音（' + sender + '）】' + (asr || '（语音转写不可用）'));
    } else {
      parts.push('【文件（' + sender + '）】' + String(a.filename || '未命名') + (a.size ? '，' + Math.round(Number(a.size) / 1024) + 'KB' : ''));
    }
  }
  return parts.join('\n');
}

function state() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch { /* ignore */ }
}

const targets = new Map(Object.entries(state().targets || {}));

async function adapter(pathname, options = {}) {
  const r = await fetch(ADAPTER + pathname, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { 'x-bot-token': TOKEN } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!r.ok) throw new Error('adapter HTTP ' + r.status + ': ' + text.slice(0, 200));
  return data;
}

function remember(chatId, target) {
  targets.set(String(chatId), target);
  const s = state();
  s.targets = Object.fromEntries([...targets.entries()].slice(-100));
  saveState(s);
}

function targetFor(item) {
  const known = targets.get(String(item.chatId));
  if (known) return { ...known, msgId: item.meta && item.meta.replyTo || known.msgId };
  return {
    scope: item.chatType === 'group' ? 'group' : 'c2c',
    targetId: String(item.chatId || ''),
  };
}

async function main() {
  const { appId, appSecret } = creds();
  const { QQBot } = await import(pathToFileURL(SDK).href);
  const bot = new QQBot({ appId, appSecret, logger: { info: (...a) => log('[qq]', ...a), warn: (...a) => log('[qq:warn]', ...a), error: (...a) => log('[qq:error]', ...a), debug: () => {} } });
  let outboxBusy = false;

  bot.on('ready', () => log('[bridge] QQ ready appId=' + appId));

  bot.on('message', async (_ctx, msg) => {
    try {
      if (!msg || msg.senderIsBot) return;
      const group = msg.kind === 'group';
      const chatId = group ? String(msg.groupOpenid || '') : String(msg.senderId || '');
      if (!chatId) return;
      const target = group
        ? { scope: 'group', targetId: chatId, msgId: msg.messageId }
        : { scope: 'c2c', targetId: chatId, msgId: msg.messageId };
      remember(chatId, target);
      const media = await mediaText(msg);
      const text = [String(msg.content || '').trim(), media].filter(Boolean).join('\n');
      const payload = {
        platform: 'qq',
        chat_id: chatId,
        chat_type: group ? 'group' : 'private',
        msg_id: String(msg.messageId || ''),
        sender_id: String(msg.senderId || ''),
        sender_name: String(msg.senderName || 'QQ用户'),
        text,
        at_me: group && (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || msg.rawEventType === 'AT_MESSAGE_CREATE'),
        chat_title: group ? String(msg.groupOpenid || '') : String(msg.senderName || ''),
        ts: msg.timestamp || Date.now(),
      };
      log('[in]', group ? 'group' : 'c2c', chatId, (payload.text || '').slice(0, 40));
      await adapter('/webhook/qq', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      log('[in:error]', e && e.message || e);
    }
  });

  bot.on('error', (e) => log('[gateway:error]', e && e.message || e));

  setInterval(async () => {
    if (outboxBusy) return;
    outboxBusy = true;
    try {
      await adapter('/api/bridge/heartbeat', { method: 'POST', body: '{}' }).catch(() => {});
      const data = await adapter('/api/bridge/outbox?platform=qq');
      const items = Array.isArray(data && data.items) ? data.items : [];
      if (!items.length) return;
      const done = [];
      for (const item of items) {
        try {
          const target = targetFor(item);
          if (!target.targetId) throw new Error('missing target for ' + item.chatId);
          const file = String(item.file || '');
          if (item.kind === 'file' && file) {
            if (!fs.existsSync(file)) throw new Error('file missing: ' + file);
            await bot.sendFile(target, { localPath: file });
            done.push(item.id);
            log('[out]', target.scope, target.targetId, 'file=' + path.basename(file));
            continue;
          }
          const text = String(item.text || '');
          if (!text.trim()) { done.push(item.id); continue; }
          await bot.sendText(target, text);
          done.push(item.id);
          log('[out]', target.scope, target.targetId, text.slice(0, 40));
        } catch (e) {
          log('[out:error]', item.id, e && e.message || e);
        }
      }
      if (done.length) await adapter('/api/bridge/outbox/ack', { method: 'POST', body: JSON.stringify({ ids: done }) }).catch(() => {});
    } catch (e) {
      log('[outbox:error]', e && e.message || e);
    } finally {
      outboxBusy = false;
    }
  }, 1200);

  await bot.start();
}

main().catch((e) => {
  log('[fatal]', e && e.stack || e);
  process.exitCode = 1;
});
