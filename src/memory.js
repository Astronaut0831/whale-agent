'use strict';

/**
 * 聊天记忆存储（纯 JSON 文件，无需数据库）。
 *
 * 结构：
 *   sessions[chatKey] = {
 *     key, platform, chatId, chatType, title,
 *     createdAt, lastActiveAt,
 *     messages: [{ role: 'user'|'assistant', name, uid, text, ts, msgId, error? }],
 *     profiles: { [uid]: { uid, name, firstSeenAt, lastSeenAt, count, notes: [] } },
 *     state: { mutedUntil, lastReplyAt, consecutiveReplies, replyTimes: [] },
 *     seenIds: [最近去重用的消息 id]
 *   }
 */
const messageDb = require('./db');
const fs = require('node:fs');
const path = require('node:path');

const SAVE_DEBOUNCE_MS = 800;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function trimText(text, max = 2000) {
  const s = String(text ?? '').replace(/\u0000/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

class Store {
  constructor({ file, limits = {}, logger = null, archiveDir = null }) {
    this.file = file;
    this.logger = logger;
    // 消息走 SQLite（Node 内置 node:sqlite，零依赖）
    try { messageDb.setDataDir(require('node:path').dirname(file)); } catch { /* ignore */ }
    this._messages = messageDb;
    // 冷归档可以放到别的盘（比如 E 盘），默认跟着 data
    this.archiveDir = archiveDir || null;
    this.limits = {
      maxSessions: clampInt(limits.maxSessions, 1, 10000, 200),
      maxMessages: clampInt(limits.maxMessages, 4, 20000, 40),
      maxNotesPerUser: clampInt(limits.maxNotesPerUser, 1, 50, 6),
    };
    this.sessions = new Map();
    this.dirty = false;
    this.saveTimer = null;
    this.stats = { messages: 0, replies: 0 };
    this.digest = [];
    this.load();
  }

  /** 记忆文件被外部改过（比如恢复备份）之后，重新读一遍，不用重启服务 */
  reloadFromDisk() {
    this.sessions.clear();
    this.digest = [];
    this.stats = { messages: 0, replies: 0 };
    this.load();
    this.dirty = false;
    return this.sessions.size;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      for (const [key, sess] of Object.entries(raw.sessions || {})) {
        this.sessions.set(key, this.normalizeSession(key, sess));
      }
      if (raw.stats) this.stats = { ...this.stats, ...raw.stats };
      if (Array.isArray(raw.digest)) this.digest = raw.digest.slice(-800);
      // 一次性迁移：JSON 里的消息搬进 SQLite，然后清空 JSON
      const marker = require('node:path').join(require('node:path').dirname(this.file), '.messages-migrated');
      let migrated = 0;
      const alreadyMigrated = fs.existsSync(marker);
      for (const [key, sess] of this.sessions) {
        if (!alreadyMigrated && Array.isArray(sess.messages) && sess.messages.length) {
          migrated += this._messages.importMessages(key, sess.messages);
          sess.messages = [];
        }
        for (const id of sess.seenIds || []) this._messages.markSeen(key, id);
        sess.seenIds = [];
      }
      if (migrated) {
        try { fs.writeFileSync(marker, String(Date.now()), 'utf8'); } catch { /* ignore */ }
        this.dirty = true;
        this.logger && this.logger.info('[存储] 已把 ' + migrated + ' 条消息迁到 SQLite');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger && this.logger.warn('记忆文件读取失败，将使用空记忆：' + err.message);
    }
  }

  normalizeSession(key, sess) {
    return {
      key,
      platform: sess.platform || 'web',
      chatId: sess.chatId || key,
      chatType: sess.chatType || 'private',
      title: sess.title || '',
      createdAt: sess.createdAt || Date.now(),
      lastActiveAt: sess.lastActiveAt || Date.now(),
      // 长期记忆：定期把一段群聊压成几条要点，进 prompt 让她"隔天也记得"
      // 注意这里也要 24 条：只改 setDigest 的话，重启加载时又会截回 8
      digest: Array.isArray(sess.digest) ? sess.digest.slice(-12) : [],
      digestAt: Number(sess.digestAt) || 0,
      messages: Array.isArray(sess.messages) ? sess.messages.slice(-this.limits.maxMessages) : [],
      profiles: sess.profiles && typeof sess.profiles === 'object' ? sess.profiles : {},
      state: {
        mutedUntil: sess.state?.mutedUntil || 0,
        lastReplyAt: sess.state?.lastReplyAt || 0,
        consecutiveReplies: sess.state?.consecutiveReplies || 0,
        adminUntil: sess.state?.adminUntil || 0,
        discussUntil: sess.state?.discussUntil || 0,
        engagedUntil: sess.state?.engagedUntil || 0,
        engagedBy: sess.state?.engagedBy || '',
        silentUntil: sess.state?.silentUntil || 0,
        // 静默的原因：'mute'（主人下的令，主人也拦）或 'away'（偶尔离线，主人豁免）
        silentReason: sess.state?.silentReason || '',
        mood: sess.state?.mood || '',
        moodText: sess.state?.moodText || '',
        moodUntil: sess.state?.moodUntil || 0,
        replyTimes: Array.isArray(sess.state?.replyTimes) ? sess.state.replyTimes.slice(-200) : [],
      },
      seenIds: Array.isArray(sess.seenIds) ? sess.seenIds.slice(-200) : [],
    };
  }

  ensureSession(key, meta = {}) {
    const safeKey = String(key).slice(0, 200);
    let sess = this.sessions.get(safeKey);
    if (!sess) {
      sess = this.normalizeSession(safeKey, {
        platform: meta.platform || 'web',
        chatId: meta.chatId || safeKey,
        chatType: meta.chatType || 'private',
        title: meta.title || '',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      this.sessions.set(safeKey, sess);
      this.prune();
    } else if (meta.title && !sess.title) {
      sess.title = String(meta.title).slice(0, 60);
    }
    return sess;
  }

  prune() {
    if (this.sessions.size <= this.limits.maxSessions) return;
    const list = [...this.sessions.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    const overflow = this.sessions.size - Math.max(10, Math.floor(this.limits.maxSessions * 0.9));
    for (let i = 0; i < overflow && i < list.length; i++) {
      this.sessions.delete(list[i].key);
    }
    this.markDirty();
  }

  getState(key) {
    return this.ensureSession(key).state;
  }

  isDuplicate(key, msgId) {
    if (!msgId) return false;
    return this._messages.isSeen(key, String(msgId));
  }

  markSeen(key, msgId) {
    if (!msgId) return;
    this._messages.markSeen(key, String(msgId));
  }

  /** 把最后一条消息的正文替换掉（用于隐藏魔咒这类敏感内容） */
  redactLastMessage(key, replacement = '（已隐藏）') {
    this.ensureSession(key);
    return this._messages.redactLast(key, String(replacement).slice(0, 200));
  }

  /** 收集别人的消息，供主人汇总查看 */
  addDigest(entry) {
    this.digest.push(entry);
    if (this.digest.length > 800) this.digest.splice(0, this.digest.length - 800);
    this.markDirty();
  }

  listDigest(since = 0) {
    const list = this.digest || [];
    return list.filter((d) => (d.ts || 0) > since);
  }

  appendMessage(key, message) {
    const sess = this.ensureSession(key);
    const entry = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      name: trimText(message.name || (message.role === 'assistant' ? '鲸鲸' : '群友'), 60),
      uid: message.uid ? String(message.uid).slice(0, 100) : '',
      text: trimText(message.text),
      ts: Number(message.ts) || Date.now(),
    };
    if (message.addressedToBot) entry.addressedToBot = true;
    if (Array.isArray(message.mentionedNames)) entry.mentionedNames = message.mentionedNames.slice(0, 4).map((n) => trimText(n, 60));
    if (Array.isArray(message.inferredTargetNames)) entry.inferredTargetNames = message.inferredTargetNames.slice(0, 4).map((n) => trimText(n, 60));
    if (message.replyToName) entry.replyToName = trimText(message.replyToName, 60);
    if (message.replyToUserId) entry.replyToUserId = String(message.replyToUserId).slice(0, 100);
    if (message.msgId) entry.msgId = String(message.msgId).slice(0, 120);
    if (message.error) entry.error = true;
    this._messages.append(sess.key, entry);
    const total = this._messages.count(sess.key);
    if (total > this.limits.maxMessages) {
      const drop = this._messages.trim(sess.key, this.limits.maxMessages);
      // L0 原文库：被裁掉的消息按月份追加到 JSONL，永不丢，可检索
      try {
        const pathMod = require('node:path');
        const fsMod = require('node:fs');
        const dir = this.archiveDir || pathMod.join(require('node:path').dirname(this.file || pathMod.join(__dirname, '..', 'data', 'store.json')), 'archive');
        fsMod.mkdirSync(dir, { recursive: true });
        const byMonth = new Map();
        for (const m of drop) {
          const d = new Date(Number(m.ts) || Date.now());
          const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
          if (!byMonth.has(key)) byMonth.set(key, []);
          byMonth.get(key).push(JSON.stringify({ key: sess.key, ...m }));
        }
        for (const [month, lines] of byMonth) {
          fsMod.appendFileSync(pathMod.join(dir, month + '.jsonl'), lines.join('\n') + '\n', 'utf8');
        }
      } catch { /* 归档失败不影响主流程 */ }
    }
    sess.lastActiveAt = entry.ts;
    if (entry.role === 'user') {
      sess.state.consecutiveReplies = 0;
      this.stats.messages += 1;
    } else {
      sess.state.consecutiveReplies += 1;
      sess.state.lastReplyAt = entry.ts;
      sess.state.replyTimes.push(entry.ts);
      if (sess.state.replyTimes.length > 200) sess.state.replyTimes = sess.state.replyTimes.slice(-200);
      this.stats.replies += 1;
    }
    this.markDirty();
    return entry;
  }

  messages(key, limit = 24) {
    this.ensureSession(key);
    return this._messages.recent(key, limit);
  }

  /** 某会话消息总数（面板/接口用） */
  messageCount(key) {
    this.ensureSession(key);
    return this._messages.count(key);
  }

  profile(key, uid, name) {
    const sess = this.ensureSession(key);
    const id = String(uid || 'anonymous').slice(0, 100);
    let p = sess.profiles[id];
    const now = Date.now();
    if (!p) {
      p = { uid: id, name: trimText(name || '群友', 60), nickname: '', firstSeenAt: now, lastSeenAt: now, count: 0, notes: [] };
      sess.profiles[id] = p;
    }
    if (!p.nickname) p.nickname = '';
    if (name) p.name = trimText(name, 60);
    p.lastSeenAt = now;
    p.count += 1;
    this.markDirty();
    return p;
  }

  /** 用户指定的称呼（「叫我小海」），优先级高于群昵称 */
  setNickname(key, uid, nickname) {
    const p = this.profile(key, uid);
    const name = trimText(nickname, 60);
    p.nickname = name;
    // 名字还是默认占位时，用昵称顶上，否则 /memory 里会显示成「群友」
    if (name && (!p.name || p.name === '群友' || p.name === '微信好友')) p.name = name;
    this.markDirty();
    return p;
  }

  /** 展示用名字 */
  displayName(key, uid, fallback = '群友') {
    const p = this.ensureSession(key).profiles[String(uid || '')];
    if (!p) return fallback;
    return p.nickname || p.name || fallback;
  }

  /** 按名字在当前会话里找人（给「记住 某人：xxx」用） */
  findProfileByName(key, name) {
    const sess = this.sessions.get(String(key));
    const want = String(name || '').trim().toLowerCase();
    if (!sess || !want) return null;
    for (const p of Object.values(sess.profiles || {})) {
      const n = String(p.nickname || p.name || '').trim().toLowerCase();
      if (n && (n === want || n.includes(want) || want.includes(n))) return p;
    }
    return null;
  }

  /** 这个会话的长期记忆要点 */
  digestOf(key) {
    const sess = this.sessions.get(String(key));
    return sess && Array.isArray(sess.digest) ? sess.digest.slice() : [];
  }

  /** 覆盖写入长期记忆要点（最多留 8 条） */
  setDigest(key, items) {
    const sess = this.sessions.get(String(key));
    if (!sess) return [];
    // 24 条长期要点（原来 8 条太容易把旧记忆挤掉）；单条放宽到 160 字
    sess.digest = (Array.isArray(items) ? items : [])
      .map((x) => trimText(x, 160))
      .filter(Boolean)
      .slice(-12);
    sess.digestAt = Date.now();
    this.markDirty();
    return sess.digest;
  }

  /** 所有会话的 key（给后台摘要任务遍历） */
  sessionKeys() {
    return [...this.sessions.keys()];
  }

  addNote(key, uid, note) {
    const p = this.profile(key, uid);
    const text = trimText(note, 60);
    if (!text) return p.notes;
    const dup = p.notes.some((n) => n.includes(text) || text.includes(n));
    if (!dup) {
      p.notes.push(text);
      if (p.notes.length > this.limits.maxNotesPerUser) {
        p.notes.splice(0, p.notes.length - this.limits.maxNotesPerUser);
      }
    }
    this.markDirty();
    return p.notes;
  }

  // 笔记向量（跟笔记同存 profile 里，base64 压缩）
  setNoteVector(key, uid, text, packed) {
    const p = this.profile(key, uid);
    const t = trimText(text, 60);
    if (!t || !packed) return;
    if (!p.noteVec || typeof p.noteVec !== "object") p.noteVec = {};
    p.noteVec[t] = packed;
    this.markDirty();
  }

  getNoteVectors(key, uid) {
    const p = this.profile(key, uid);
    const map = p.noteVec && typeof p.noteVec === "object" ? p.noteVec : {};
    // 顺手清掉已经删掉的笔记留下的向量
    const alive = new Set((p.notes || []).map((n) => trimText(n, 60)));
    let dirty = false;
    for (const k of Object.keys(map)) {
      if (!alive.has(k)) { delete map[k]; dirty = true; }
    }
    if (dirty) { p.noteVec = map; this.markDirty(); }
    return map;
  }

  notesOf(key, uid) {
    const p = this.profile(key, uid);
    return (p.notes || []).slice();
  }

  removeNote(key, uid, needle) {
    const p = this.profile(key, uid);
    const raw = trimText(needle, 60);
    const before = p.notes.length;
    if (!raw) {
      p.notes = [];
    } else {
      p.notes = p.notes.filter((n) => !n.includes(raw) && !raw.includes(n));
    }
    this.markDirty();
    return { removed: before - p.notes.length, notes: p.notes };
  }

  listNotes(key) {
    const sess = this.ensureSession(key);
    return Object.values(sess.profiles)
      .filter((p) => p.notes.length > 0)
      .map((p) => ({ uid: p.uid, name: p.name, notes: p.notes.slice() }));
  }

  setMuted(key, ms) {
    const st = this.getState(key);
    st.mutedUntil = Date.now() + Math.max(0, ms);
    this.markDirty();
    return st.mutedUntil;
  }

  resetSession(key) {
    const sess = this.ensureSession(key);
    sess.messages = [];
    sess.seenIds = [];
    sess.state = { mutedUntil: 0, lastReplyAt: 0, consecutiveReplies: 0, replyTimes: [], adminUntil: 0, discussUntil: 0, engagedUntil: 0, engagedBy: '', silentUntil: 0, silentReason: '' };
    this.markDirty();
  }

  resetAll() {
    this.sessions.clear();
    this.stats = { messages: 0, replies: 0 };
    this.digest = [];
    this.markDirty();
  }

  summary() {
    let messages = 0;
    let notes = 0;
    for (const [key, sess] of this.sessions) {
      try { messages += this._messages.count(key); } catch { messages += (sess.messages || []).length; }
      for (const p of Object.values(sess.profiles)) notes += p.notes.length;
    }
    return { sessions: this.sessions.size, messages, notes, totalMessages: this.stats.messages, totalReplies: this.stats.replies };
  }

  markDirty() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  flush() {
    if (!this.dirty) return;
    const payload = { version: 1, savedAt: new Date().toISOString(), stats: this.stats, digest: this.digest, sessions: {} };
    for (const [key, sess] of this.sessions) payload.sessions[key] = sess;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.logger && this.logger.error('保存记忆失败：' + err.message);
    }
  }

  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flush();
  }
}

module.exports = { Store };
