/** 微信入站 payload 归一化。纯函数，不依赖 Cordis。 */

import { fromWechat } from './envelope.js';

const DEFAULT_PLATFORM = 'wechat';

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

export function normalizeInbound(payload = {}) {
  const platform = String(pick(payload, ['platform', 'source']) ?? DEFAULT_PLATFORM).toLowerCase() || DEFAULT_PLATFORM;
  const chatId = String(pick(payload, ['chat_id', 'chatId', 'room_id', 'roomId', 'conversation_id']) ?? '');
  if (!chatId) throw new Error(platform + ' inbound: missing chat_id');

  const chatType = (() => {
    const t = String(pick(payload, ['chat_type', 'chatType']) ?? '').toLowerCase();
    if (t === 'group' || t === '群') return 'group';
    if (t === 'private' || t === '私聊') return 'private';
    return payload.is_group || payload.isGroup ? 'group' : 'private';
  })();

  const msgId = String(pick(payload, ['msg_id', 'msgId', 'message_id', 'id']) ?? '');
  if (!msgId) throw new Error(platform + ' inbound: missing msg_id');

  const text = String(pick(payload, ['text', 'content', 'message']) ?? '');
  const images = [];
  const b64 = pick(payload, ['image', 'image_base64', 'imageBase64']);
  if (b64) images.push({ b64: String(b64), mime: String(pick(payload, ['mime', 'image_mime']) ?? 'image/jpeg') });

  const tsRaw = Number(pick(payload, ['ts', 'timestamp', 'create_time']) ?? Date.now());
  const ts = Number.isFinite(tsRaw) ? (tsRaw < 1e12 ? Math.round(tsRaw * 1000) : Math.round(tsRaw)) : Date.now();

  const msg = {
    platform,
    sessionKey: `${platform}:${chatType === 'group' ? 'g' : 'u'}:${chatId}`,
    chatId,
    chatType,
    msgId,
    senderId: String(pick(payload, ['sender_id', 'senderId', 'user_id', 'userId']) ?? 'unknown'),
    senderName: String(pick(payload, ['nickname', 'senderName', 'sender_name', 'name']) ?? '群友'),
    text,
    images,
    atMe: Boolean(payload.at_me ?? payload.atMe),
    replyToBot: Boolean(payload.reply_to_bot ?? payload.replyToBot),
    chatTitle: String(pick(payload, ['chat_title', 'chatTitle', 'group_name']) ?? ''),
    ts,
    raw: payload,
  };
  msg.envelope = fromWechat(msg);
  return msg;
}

/**
 * 路由判定：
 * - off：全部代理旧 bot；
 * - shadow/active：所有私聊进入 DSH（主人由 GUI broker 分支接管，非主人走 headless）；
 * - group：由 modes 的 group 分支单独处理；
 * - 其他：legacy。
 */
export function decideMode({ mode = 'off' } = {}, msg) {
  const m = String(mode || 'off');
  if (m === 'off') return 'off';
  if (m !== 'shadow' && m !== 'active') return 'legacy';
  if (!msg || msg.chatType !== 'private') return 'legacy';
  return m;
}
