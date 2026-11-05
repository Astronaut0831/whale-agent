/**
 * 统一消息 envelope：所有端（微信/GUI/CLI）先转成这个形状，再进入 agent。
 * 纯函数，不依赖 Cordis。
 */

export const ENVELOPE_VERSION = 1;

function normalizeChatType(value) {
  const t = String(value || '').toLowerCase();
  if (t === 'group' || t === '群') return 'group';
  return 'private';
}

function normalizeTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

export function createEnvelope({
  platform = 'unknown',
  chatId = '',
  chatType = 'private',
  msgId = '',
  senderId = 'unknown',
  senderName = '对方',
  text = '',
  images = [],
  atMe = false,
  chatTitle = '',
  ts = Date.now(),
  threadId = '',
  raw,
} = {}) {
  if (!chatId) throw new Error('envelope: missing chatId');
  if (!msgId) throw new Error('envelope: missing msgId');
  const type = normalizeChatType(chatType);
  const chatScope = type === 'group' ? 'g' : 'u';
  return {
    v: ENVELOPE_VERSION,
    platform: String(platform),
    chatType: type,
    chatId: String(chatId),
    sessionKey: `${platform}:${chatScope}:${chatId}`,
    threadId: String(threadId || `${platform}:${type}:${chatId}`),
    chatTitle: String(chatTitle || ''),
    message: {
      id: String(msgId),
      text: String(text || ''),
      images: Array.isArray(images) ? images : [],
      atMe: Boolean(atMe),
      ts: normalizeTs(ts),
      sender: { id: String(senderId), name: String(senderName) },
    },
    raw,
  };
}

export function fromWechat(msg) {
  return createEnvelope({
    platform: msg.platform || 'wechat',
    chatId: msg.chatId,
    chatType: msg.chatType,
    msgId: msg.msgId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    text: msg.text,
    images: msg.images,
    atMe: msg.atMe,
    chatTitle: msg.chatTitle,
    ts: msg.ts,
    raw: msg.raw,
  });
}

export function formatForAgent(envelope) {
  const where = envelope.chatType === 'group' ? '群聊' : '私聊';
  const who = envelope.message.sender.name || '对方';
  const text = envelope.message.text || '（无文字）';
  return `[${envelope.platform}${where}] ${who}：${text}`;
}

export function createOutbound(envelope, { bubbles = [], kind = 'text', ts = Date.now() } = {}) {
  return {
    v: ENVELOPE_VERSION,
    platform: envelope.platform,
    chatId: envelope.chatId,
    chatType: envelope.chatType,
    threadId: envelope.threadId,
    replyTo: envelope.message.id,
    kind,
    bubbles: bubbles.map(String),
    ts: normalizeTs(ts),
  };
}
