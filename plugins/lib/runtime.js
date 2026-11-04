/** Shared runtime state reader: target session + memory token, outside profile YAML. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export function runtimeFile(config = {}) {
  if (config.runtimeFile) return path.resolve(String(config.runtimeFile));
  if (process.env.WHALE_RUNTIME_FILE) return path.resolve(process.env.WHALE_RUNTIME_FILE);
  return fileURLToPath(new URL('../../data/runtime.json', import.meta.url));
}

const warnedRuntime = new Set();

export function readRuntime(config = {}) {
  let file = '';
  try {
    file = runtimeFile(config);
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch (e) {
    if (e && e.code !== 'ENOENT' && file && !warnedRuntime.has(file)) {
      warnedRuntime.add(file);
      console.error('[runtime] cannot read ' + file + ': ' + (e.message || e));
    }
    return {};
  }
}

export function resolveTarget(config = {}) {
  const direct = String(config.targetSessionId || '');
  if (direct) return direct;
  const rt = readRuntime(config);
  return String(rt.guiSessionId || '');
}

export function resolveMemoryToken(config = {}) {
  const direct = String(config.token || '');
  if (direct) return direct;
  const rt = readRuntime(config);
  return String(rt.memoryToken || '');
}

/** 群/私聊 → 独立 session 的映射文件（适配器写，插件读）。 */
export function chatSessionsFile(config = {}) {
  if (config.chatSessionsFile) return path.resolve(String(config.chatSessionsFile));
  if (process.env.WHALE_CHAT_SESSIONS_FILE) return path.resolve(process.env.WHALE_CHAT_SESSIONS_FILE);
  return fileURLToPath(new URL('../../data/chat-sessions.json', import.meta.url));
}

/** chatId → 记忆 scope（与旧 bot 一致：群 wechat:g:<id>，人 wechat:u:<wxid>）。 */
export function scopeOfChatId(chatId) {
  const c = String(chatId || '').trim();
  if (!c) return '';
  if (c.endsWith('@chatroom')) return 'wechat:g:' + c;
  return 'wechat:u:' + c;
}

let chatSessionsCache = { at: 0, file: '', map: {} };

/**
 * 读映射并统一成「sessionId → chatId」。
 * 兼容两种格式：{byChat:{...}} 或扁平 {chatId: sessionId}。5 秒缓存。
 */
export function sessionToChat(config = {}) {
  const file = chatSessionsFile(config);
  const now = Date.now();
  if (chatSessionsCache.file === file && now - chatSessionsCache.at < 5000) return chatSessionsCache.map;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch { raw = {}; }
  const byChat = raw && raw.byChat && typeof raw.byChat === 'object' ? raw.byChat : raw;
  const out = {};
  for (const [chatId, sid] of Object.entries(byChat || {})) {
    if (!chatId || !sid || typeof sid !== 'string') continue;
    if (chatId === 'bySession') continue;
    out[String(sid)] = String(chatId);
  }
  chatSessionsCache = { at: now, file, map: out };
  return out;
}

/** 这个 session 属于哪个记忆 scope；不是群/人会话就返回空。 */
export function scopeForSession(sessionId, config = {}) {
  const sid = String(sessionId || '');
  if (!sid) return '';
  const chatId = sessionToChat(config)[sid];
  return chatId ? scopeOfChatId(chatId) : '';
}
