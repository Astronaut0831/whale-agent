'use strict';

/**
 * 用 memory-episodes.jsonl 构造旧 digestCore 需要的 runtime。
 * 只负责读消息和存 digest 状态，不碰长期记忆。
 */

const fs = require('node:fs');
const path = require('node:path');

function readEpisodes(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.scope && e.user) out.push(e);
    } catch { /* skip */ }
  }
  return out;
}

function createEpisodeRuntime({ dataDir, llm, config, logger } = {}) {
  const dir = dataDir || path.join(__dirname, '..', 'data');
  const episodesFile = path.join(dir, 'memory-episodes.jsonl');
  const stateFile = path.join(dir, 'memory-digest-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { /* first */ }

  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  };

  const episodes = readEpisodes(episodesFile);
  const byKey = new Map();
  for (const e of episodes) {
    if (!byKey.has(e.scope)) byKey.set(e.scope, []);
    byKey.get(e.scope).push(e);
  }

  const keys = [...byKey.keys()];
  const sessions = new Map();
  for (const key of keys) {
    const st = state[key] || {};
    sessions.set(key, {
      title: key.includes(':g:') ? '群聊' : '私聊',
      digestUpTo: Number(st.digestUpTo) || 0,
      digestAt: Number(st.digestAt) || 0,
    });
  }

  const messages = (key) => {
    const list = byKey.get(key) || [];
    const out = [];
    for (const e of list) {
      const ts = Number(e.ts) || 0;
      out.push({ role: 'user', name: key.includes(':g:') ? '群友' : '主人', text: String(e.user || ''), ts, msgId: String(e.id || '') + 'u' });
      if (e.assistant) out.push({ role: 'assistant', name: '她', text: String(e.assistant || ''), ts: ts + 1, msgId: String(e.id || '') + 'a' });
    }
    return out;
  };

  const store = {
    sessions,
    sessionKeys: () => keys,
    messages,
    digestOf: (key) => (state[key] && Array.isArray(state[key].digest) ? state[key].digest : []),
    setDigest: (key, lines) => {
      const st = state[key] || (state[key] = {});
      st.digest = Array.isArray(lines) ? lines : [];
      st.digestAt = Date.now();
      const sess = sessions.get(key);
      if (sess) {
        sess.digestAt = st.digestAt;
        sess.digestUpTo = st.digestUpTo || sess.digestUpTo;
      }
      save();
    },
    markDirty: save,
  };

  // digestCore 会写 sess.digestUpTo；保存到 state，下次构造可续
  for (const [key, sess] of sessions) {
    const original = { ...sess };
    Object.defineProperty(sess, 'digestUpTo', {
      get: () => (state[key] && state[key].digestUpTo) || 0,
      set: (v) => {
        const st = state[key] || (state[key] = {});
        st.digestUpTo = Number(v) || 0;
        save();
      },
      configurable: true,
    });
    sess.digestAt = Number((state[key] || {}).digestAt) || original.digestAt || 0;
  }

  return {
    llm: llm || null,
    store,
    config: config || {},
    logger: logger || { info() {}, warn() {}, debug() {} },
    _digestBusy: false,
  };
}

module.exports = { createEpisodeRuntime, readEpisodes };
