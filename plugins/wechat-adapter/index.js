/**
 * 微信适配器：自己监听 HTTP（不依赖宿主的 webServer 服务）。
 * off/legacy 代理旧 bot；shadow 旁路记录；active 交给 DSH agent。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkToken, createSeen } from './lib/inbound.js';
import { dispatchInbound } from './lib/modes.js';
import { runTurn, createStore } from './lib/sessions.js';
import { splitBubbles } from './lib/bubbles.js';
import { runHeadlessTurn } from './lib/headless.js';
import { createGuiBroker, extractTokenFromLog } from './lib/gui-broker.js';
import { createGuiInputStore } from './lib/gui-input-store.js';
import { withLease } from './lib/session-lease.js';
import { readRuntime, repoRoot } from '../lib/runtime.js';
import { prefsBlock, selfnoteBlock } from '../lib/context-data.js';
import * as behavior from '../lib/behavior.js';
import * as links from '../lib/links.js';
import * as corpus from '../lib/corpus.js';
import * as tasksStore from '../lib/tasks.js';
import * as bilibili from '../lib/bilibili.js';
import * as proactive from '../lib/proactive.js';
import * as care from '../lib/care.js';
import * as vision from '../lib/vision.js';
import { registerMemoryTools } from './lib/memory-tools.js';
import { recentUserTexts } from './lib/recent-context.js';
import { setOutboxFile, enqueue, take, ack, resetSending } from './lib/outbox.js';
import { createGroupHistory } from './lib/group-history.js';
import { createGroupPolicy } from './lib/group-policy.js';

const localRequire = createRequire(import.meta.url);
let loadLegacyConfig = null;
let StickerService = null;
let DeepSeekClient = null;
let legacyPrefs = null;
let legacyUsb = null;
let legacyStickers = null;
try {
  loadLegacyConfig = localRequire('../../src/config.js').loadConfig;
  StickerService = localRequire('../../src/stickerService.js').StickerService;
  legacyStickers = localRequire('../../src/stickers.js');
  DeepSeekClient = localRequire('../../src/llm.js').DeepSeekClient;
  legacyPrefs = localRequire('../../src/prefs.js');
  legacyUsb = localRequire('../../src/usb.js');
} catch { /* optional legacy features */ }

export const name = 'wechat-adapter';
export const inject = ['agents', 'systemPrompt'];

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8788,
  legacyEnabled: false,
  legacyBase: '',
  coreSendUrl: '',
  outboxFile: path.join(repoRoot, 'data', 'outbox.json'),
  dataDir: path.join(repoRoot, 'data'),
  root: repoRoot,
  selfnoteStateFile: path.join(repoRoot, 'data', 'selfnote-state.json'),
  taskTimeoutMs: 600000,
  groupHistoryFile: path.join(repoRoot, 'data', 'group-history.jsonl'),
  groupStateFile: path.join(repoRoot, 'data', 'group-state.json'),
  groupEnabled: false,
  whaleConfigPath: path.join(repoRoot, 'config.json'),
  modeFile: path.join(repoRoot, 'data', 'core-mode.json'),
  sessionsFile: path.join(repoRoot, 'data', 'core-sessions.json'),
  logFile: path.join(repoRoot, 'data', 'adapter.log'),
  personaFile: path.join(repoRoot, 'personas', 'whale-agent.md'),
  botDbFile: path.join(repoRoot, 'data', 'bot.db'),
  workspace: path.resolve(repoRoot, '..', 'whale'),
  memoryUrl: 'http://127.0.0.1:8791',
  timeoutMs: 60000,
  headlessTimeoutMs: 180000,
  runner: 'resident',
  headlessProfile: 'whale-headless',
  taskProfile: 'whale-headless-task',
  guiBroker: {
    enabled: false,
    guiInput: false,
    url: 'http://127.0.0.1:3080',
    token: '',
    tokenFile: path.join(repoRoot, 'data', 'gui-3080.log'),
    routes: ['master', 'groups'],
    sessionId: '',
    timeoutMs: 120000,
  },
  maxBodyBytes: 1024 * 1024,
};

export function pingPayload() {
  return { ok: true, plugin: 'wechat-adapter' };
}

function readWhaleConfig(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return {}; }
}

export function readPersona(path) {
  try { return String(fs.readFileSync(path, 'utf8')).trim(); } catch { return ''; }
}

function readMode(path) {
  try {
    const m = String(JSON.parse(fs.readFileSync(path, 'utf8')).mode || 'off');
    return ['off', 'shadow', 'active'].includes(m) ? m : 'off';
  } catch { return 'off'; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function proxyRaw(req, res, base) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const url = String(base).replace(/\/+$/, '') + (req.url || '/');
      const headers = { ...req.headers };
      delete headers.host;
      const r = await fetch(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : Buffer.concat(chunks),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
      res.end(buf);
    } catch (e) {
      sendJson(res, 502, { ok: false, error: String(e && e.message) });
    }
  });
  req.on('error', () => sendJson(res, 400, { ok: false, error: 'bad request' }));
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  cfg.guiBroker = { ...DEFAULTS.guiBroker, ...((config && config.guiBroker) || {}) };
  const runtime = readRuntime({ runtimeFile: cfg.runtimeFile });
  // Runtime state is authoritative for the live GUI token file; a stale profile
  // tokenFile must not shadow the token written by the current `dsh web` process.
  if (runtime.guiTokenFile) cfg.guiBroker.tokenFile = String(runtime.guiTokenFile);
  const whale = readWhaleConfig(cfg.whaleConfigPath);
  let visionConfig = whale;
  try {
    if (loadLegacyConfig) visionConfig = loadLegacyConfig({ root: cfg.root });
  } catch { /* keep raw config */ }
  let stickerService = null;
  try {
    if (StickerService) stickerService = new StickerService(visionConfig);
  } catch { /* sticker library optional */ }
  let careLlm = null;
  try {
    if (DeepSeekClient) careLlm = new DeepSeekClient({ config: visionConfig, logger: { info() {}, warn() {}, debug() {} } });
  } catch { /* care falls back to templates */ }
  const groupHistory = createGroupHistory(cfg.groupHistoryFile);
  const groupJudge = careLlm && !careLlm.isMock
    ? async ({ history: hist, senderName, text }) => {
      const recent = (hist || []).slice(-8)
        .map((m) => (m.role === 'assistant' ? '鲸鲸' : (m.name || '群友')) + '：' + String(m.text || '').slice(0, 80))
        .join('\n');
      const system = '你是群聊语境判断器。根据最近几条消息，判断【最新一句】主要是在说给“鲸鲸”听，还是在说给群里其他人听。'
        + '只输出 JSON：{"toBot":true,"reason":"不超过15字"} 或 {"toBot":false,"reason":"..."}。不要输出别的字。';
      const out = await careLlm.complete({
        system,
        turns: [{ role: 'user', content: '【最近消息】\n' + recent + '\n\n【最新一句】\n' + (senderName || '群友') + '：' + String(text || '').slice(0, 120) }],
        maxTokens: 300,
        skipGovernor: true,
      });
      const m = String(out || '').match(/\{[\s\S]*\}/);
      if (!m) return { toBot: true, reason: '没读懂' };
      const o = JSON.parse(m[0]);
      return { toBot: o.toBot !== false, reason: String(o.reason || '').slice(0, 20) };
    }
    : null;
  const groupPolicy = createGroupPolicy({
    config: visionConfig,
    history: groupHistory,
    stateFile: cfg.groupStateFile,
    judge: groupJudge,
    behavior: behavior,
  });
  const masterWxid = String(((whale.persona || {}).master || {}).wxids?.[0] || '');
  const token = String(((whale.gateway || {}).wechat || {}).inboundToken || '');

  // Cheap first-stage gate: full recent group context, tiny output. The full
  // GUI agent is only invoked when this decides the message is worth answering.
  async function judgeGroupReply({ chatId, text, senderName, atMe, replyToBot }) {
    if (atMe || replyToBot) return { reply: true, reason: 'addressed' };
    // If the cheap judge is unavailable, default to SKIP for non-addressed
    // traffic: failing open would send every group message through the full agent.
    if (!careLlm || careLlm.isMock) return { reply: false, reason: 'judge_unavailable' };
    try {
      const hist = groupHistory.load(chatId, 200) || [];
      const transcript = hist
        .map((m) => (m.role === 'assistant' ? '鲸鲸' : (m.name || '群友')) + '：' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 300))
        .join('\n') || (senderName || '群友') + '：' + String(text || '').slice(0, 300);
      const system = '你是群聊里的鲸鲸的接话判断器。根据完整群聊上下文判断：鲸鲸现在该不该接这句话。'
        + '被点名、被引用、有人直接问她、向她求助或情绪明显需要回应 → REPLY。'
        + '普通群聊、别人互聊、刷屏、无意义重复、她插不上话 → SKIP。'
        + '只输出 REPLY 或 SKIP，不要解释，不要加标点。';
      const out = await careLlm.complete({
        system,
        turns: [{ role: 'user', content: '【群聊上下文】\n' + transcript + '\n\n【最新一句】\n' + (senderName || '群友') + '：' + String(text || '').slice(0, 1000) }],
        maxTokens: 8,
        skipGovernor: true,
      });
      const raw = String(out || '').trim().toUpperCase();
      const reply = raw.includes('REPLY');
      log({ kind: 'group-judge', chatId, reply, raw: raw.slice(0, 20) });
      return reply ? { reply: true, reason: 'judge_reply' } : { reply: false, reason: 'judge_skip' };
    } catch (e) {
      log({ kind: 'group-judge-fail', chatId, error: String(e && e.message).slice(0, 120) });
      return { reply: false, reason: 'judge_fail' };
    }
  }

  async function observeGroupSkip({ chatId, senderName, text }) {
    try {
      if (!cfg.memoryUrl) return;
      await fetch(String(cfg.memoryUrl).replace(/\/+$/, '') + '/observe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
        body: JSON.stringify({
          scope: 'wechat:g:' + chatId,
          user: (senderName || '群友') + '：' + String(text || ''),
          assistant: '',
          ts: Date.now(),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* memory must not block chat */ }
  }

  const writeWhaleConfig = (obj) => {
    try { fs.writeFileSync(cfg.whaleConfigPath, JSON.stringify(obj, null, 2), 'utf8'); return true; } catch { return false; }
  };
  const memoryFetch = async (pathName, body = null, method = 'POST') => {
    const r = await fetch(String(cfg.memoryUrl).replace(/\/+$/, '') + pathName, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
      body: method === 'GET' || body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || ('memory HTTP ' + r.status));
    return d;
  };
  corpus.setDataDir(cfg.dataDir)
  proactive.setDataDir(cfg.dataDir)
    if (behavior) { try { behavior.setDataDir(cfg.dataDir); } catch { /* ignore */ } }
  if (legacyPrefs) { try { legacyPrefs.setDataDir(cfg.dataDir); } catch { /* ignore */ } }
  if (legacyUsb) {
    try {
      legacyUsb.startAuto(() => visionConfig, {
        info: (m) => log({ kind: 'usb-backup', message: String(m) }),
        warn: (m) => log({ kind: 'usb-backup-warn', message: String(m) }),
      });
    } catch { /* ignore */ }
  }
  const seen = createSeen();
  const store = createStore(cfg.sessionsFile);

  const log = (entry) => {
    try { fs.appendFileSync(cfg.logFile, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); } catch { /* ignore */ }
  };

  const selfnoteState = (() => {
    try { return JSON.parse(fs.readFileSync(cfg.selfnoteStateFile, 'utf8')) || {}; } catch { return {}; }
  })();
  const selfnoteBlockFor = (scope) => {
    const now = Date.now();
    const last = Number(selfnoteState[scope] || 0);
    const first = !last;
    let block = '';
    if (first || now - last > 2 * 3600 * 1000) {
      block = selfnoteBlock({ n: 5, dataDir: cfg.dataDir });
    }
    selfnoteState[scope] = now;
    try { fs.writeFileSync(cfg.selfnoteStateFile, JSON.stringify(selfnoteState), 'utf8'); } catch { /* ignore */ }
    return block;
  };

  const persona = readPersona(cfg.personaFile);
  if (persona && ctx.systemPrompt) {
    ctx.systemPrompt.section({ name: 'whale-persona', order: 100, text: persona });
  }

  setOutboxFile(cfg.outboxFile);
  const sendBubbles = async ({ chatId, chatType, bubbles }) => {
    for (const text of bubbles || []) {
      enqueue({ chatId, chatType: chatType || 'private', kind: 'text', text: String(text || '') });
    }
  };

  if (tasksStore) {
    try {
      tasksStore.setDataDir(cfg.dataDir);
      const n = tasksStore.markInterrupted();
      if (n) log({ kind: 'task-interrupted', count: n });
    } catch { /* ignore */ }
  }

  const taskChatType = (payload) => {
    const t = String(payload.chat_type || payload.chatType || '').toLowerCase();
    return t === 'group' || t === '群' ? 'group' : 'private';
  };
  const taskReply = (chatId, chatType, text) => {
    enqueue({ chatId, chatType, kind: 'text', text: String(text || '') });
    return { ok: true, bubbles: [String(text || '')] };
  };

  const onlineFile = path.join(cfg.dataDir, 'bot-online.json');
  function readOnline() {
    try {
      const d = JSON.parse(fs.readFileSync(onlineFile, 'utf8'));
      return d.online !== false;
    } catch {
      return true;
    }
  }
  function writeOnline(online) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(onlineFile, JSON.stringify({ online: Boolean(online), at: Date.now() }), 'utf8');
  }
  async function handleOnlineControl(payload) {
    const text = String(payload.text || payload.content || '').trim();
    const m = text.match(/^\/(online|offline|上线|下线)(?:\s|$)/i);
    if (!m) return null;
    const sender = String(payload.sender_id || payload.senderId || '');
    if (sender !== masterWxid) return null;
    const online = /online|上线/i.test(m[1]);
    writeOnline(online);
    log({ kind: 'online-command', online });
    const chatId = String(payload.chat_id || payload.chatId || '');
    const chatType = taskChatType(payload);
    return taskReply(chatId, chatType, online
      ? '我上线了，继续回消息。'
      : '我先下线，不接消息、不主动发。发 /online 叫我。');
  }

  async function handleTaskCommand(payload) {
    if (!tasksStore) return null;
    const text = String(payload.text || payload.content || '').trim();
    if (!/^\/task(?:\s|$)/i.test(text)) return null;
    const chatId = String(payload.chat_id || payload.chatId || '');
    const chatType = taskChatType(payload);
    const sender = String(payload.sender_id || payload.senderId || '');
    if (sender !== masterWxid) return taskReply(chatId, chatType, '派活只有主人能做。');
    const arg = text.replace(/^\/task\s*/i, '').trim();
    if (!arg || arg === 'list' || arg === '列表') {
      const items = tasksStore.list(5);
      if (!items.length) return taskReply(chatId, chatType, '现在没有任务。');
      const body = items.map((t) => t.id.slice(-6) + ' [' + t.status + '] ' + String(t.instruction).slice(0, 30)).join('\n');
      return taskReply(chatId, chatType, '最近的任务：\n' + body);
    }
    if (arg === 'cancel' || arg === '取消') {
      const n = tasksStore.cancelAll();
      return taskReply(chatId, chatType, n ? '停了 ' + n + ' 个任务。' : '没有在跑的任务。');
    }
    const idMatch = arg.match(/^(cancel|取消)\s+(\w+)/i);
    if (idMatch) {
      const hit = tasksStore.list(20).find((t) => String(t.id).endsWith(idMatch[2]));
      if (!hit) return taskReply(chatId, chatType, '没找到这个任务。');
      tasksStore.cancel(hit.id);
      return taskReply(chatId, chatType, '停了：' + String(hit.instruction).slice(0, 30));
    }
    const t = tasksStore.enqueue({ chatId, chatType, ownerId: sender, instruction: arg });
    return taskReply(chatId, chatType, '行，我后台弄（' + t.id.slice(-6) + '），好了叫你。');
  }

  let groupProactiveArmed = Boolean(
    visionConfig && visionConfig.proactive && visionConfig.proactive.group
      && visionConfig.proactive.group.enabled !== false
  );
  let careDecision = { at: 0, due: false, reason: '' };
// 主人最近一次开口的时间：判断「冷场多久」要用它，不然模型不知道你是不是刚聊完。
let lastMasterInboundAt = 0;

  async function handleMiscCommand(payload) {
    const text = String(payload.text || payload.content || '').trim();
    const m = text.match(/^\/([a-zA-Z]+)\b\s*([\s\S]*)$/);
    if (!m) return null;
    const cmd = m[1].toLowerCase();
    if (cmd === 'task') return null;
    const chatId = String(payload.chat_id || payload.chatId || '');
    const chatType = taskChatType(payload);
    const sender = String(payload.sender_id || payload.senderId || '');
    const isMaster = sender === masterWxid;
    const arg = String(m[2] || '').trim();

    if (cmd === 'help') {
      const body = [
        '/help  看命令',
        '/status  运行状态（主人）',
        '/mute [分钟]  闭麦（主人）',
        '/unmute  解除闭麦（主人）',
        '/talk 少|正常|多  群说话频率（主人，群聊）',
        '/listen ...  监听白名单（主人）',
        '/corpus on|off  群语料收集（主人，群聊）',
        '/proactive on|off  群聊主动起话题（主人）',
        '/care on|off  个人主动关心（主人）',
        '/offline / /online  全局下线/上线（主人）',
        '/remind  提醒列表/取消（主人）',
            '/behavior [set key value|reset]  行为参数（主人）',
        '/pref add|list|del ...  全局规矩（主人）',
        '/persona [show|<人设>]  查看/替换人设（主人）',
        '/facts [搜|详情|删|恢复]  长期记忆',
        '/memory  记忆概览',
        '/backup [drives|status]  记忆快照（主人）',
        '/task list|cancel|<指令>  后台任务（主人）',
        '（set/backup 等仍在迁移）',
      ].join('\n');
      return taskReply(chatId, chatType, body);
    }

    if (cmd === 'status') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能看。');
      return taskReply(chatId, chatType, [
        '模式：' + readMode(cfg.modeFile),
        '运行：' + Math.round(process.uptime()) + 's',
        '工作区：' + cfg.workspace,
        '记忆：' + cfg.memoryUrl,
      ].join('\n'));
    }

    if (cmd === 'mute' || cmd === 'unmute') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      if (cmd === 'mute') {
        const minutes = Math.max(1, Math.min(1440, Number(arg) || Number((visionConfig.group || {}).muteDefaultMinutes) || 30));
        groupPolicy.mute(chatId, minutes);
        return taskReply(chatId, chatType, '好，闭嘴 ' + minutes + ' 分钟。想提前放我出来就发 /unmute');
      }
      groupPolicy.unmute(chatId);
      return taskReply(chatId, chatType, '行，我回来了');
    }

    if (cmd === 'talk') {
      if (!isMaster) return taskReply(chatId, chatType, '频率档位只有主人能改。');
      if (chatType !== 'group') return taskReply(chatId, chatType, '说话频率只在群里用。');
      const map = { 少: 'quiet', 少说: 'quiet', quiet: 'quiet', 正常: 'normal', normal: 'normal', 多: 'chatty', 多说: 'chatty', chatty: 'chatty' };
      if (!arg) return taskReply(chatId, chatType, '这个群的说话频率：' + groupPolicy.getTalk(chatId));
      const val = map[arg.toLowerCase()] || map[arg];
      if (!val) return taskReply(chatId, chatType, '只认：少 / 正常 / 多。');
      groupPolicy.setTalk(chatId, val);
      const label = val === 'quiet' ? '少说' : val === 'chatty' ? '多说' : '正常';
      return taskReply(chatId, chatType, '好，这个群改成「' + label + '」。');
    }

    if (cmd === 'listen') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      const readData = (name) => {
        try { return JSON.parse(fs.readFileSync(cfg.dataDir + '/' + name, 'utf8')) || {}; } catch { return {}; }
      };
      const blocked = Array.isArray(readData('listen-blocked.json').items) ? readData('listen-blocked.json').items : [];
      const chats = Array.isArray(readData('chats.json').items) ? readData('chats.json').items : [];
      const conf = readWhaleConfig(cfg.whaleConfigPath);
      conf.wechat = conf.wechat || {};
      const cur = conf.wechat.listen || { enabled: false, groups: [], privates: [] };
      const groups = new Set((cur.groups || []).map(String));
      const privates = new Set((cur.privates || []).map(String));
      const save = () => {
        const listen = { enabled: Boolean(cur.enabled), groups: [...groups], privates: [...privates] };
        conf.wechat.listen = listen;
        if (writeWhaleConfig(conf) && visionConfig.wechat) visionConfig.wechat.listen = listen;
        return listen;
      };
      const resolve = (raw) => {
        const t = String(raw || '').trim();
        if (!t) return null;
        if (/^\d+@chatroom$/.test(t)) return { kind: 'group', id: t };
        if (/^wxid_[A-Za-z0-9_\-]+$/.test(t)) return { kind: 'private', id: t };
        if (/^\d+$/.test(t)) {
          const i = Number(t) - 1;
          const b = blocked[i] || chats[i];
          if (b) return { kind: b.kind === 'group' ? 'group' : 'private', id: b.id };
        }
        for (const item of blocked.concat(chats)) {
          if (item.name && String(item.name).includes(t)) return { kind: item.kind === 'group' ? 'group' : 'private', id: item.id };
        }
        return null;
      };
      const render = () => [
        '听消息：[' + (cur.enabled ? '开' : '关') + ']',
        '群：' + ([...groups].join('、') || '（空）'),
        '私聊：' + ([...privates].join('、') || '（空，主人始终放行）'),
        '改：/listen add 群名或wxid、/listen del …、/listen on|off',
      ].join('\n');
      const sub = (arg.split(/\s+/)[0] || '').toLowerCase();
      const rest = arg.slice(sub.length).trim();
      if (sub === 'chats' || sub === '会话') {
        if (!chats.length) return taskReply(chatId, chatType, '还没拿到会话目录，等几秒再试。');
        return taskReply(chatId, chatType, chats.map((x, i) => (i + 1) + '. ' + (x.kind === 'group' ? '群' : '私聊') + ' ' + x.name + ' (' + x.id + ')').join('\n'));
      }
      if (sub === 'blocked' || sub === '被挡') {
        if (!blocked.length) return taskReply(chatId, chatType, '最近没有被挡住的会话。');
        return taskReply(chatId, chatType, blocked.map((x, i) => (i + 1) + '. ' + (x.kind === 'group' ? '群' : '私聊') + ' ' + (x.name || x.id) + ' (' + x.id + ')').join('\n'));
      }
      if (!sub || sub === 'list') return taskReply(chatId, chatType, render());
      if (sub === 'on') { cur.enabled = true; save(); return taskReply(chatId, chatType, '好，开始按名单听消息了。\n' + render()); }
      if (sub === 'off') { cur.enabled = false; save(); return taskReply(chatId, chatType, '关掉了，现在只按旧白名单走。\n' + render()); }
      if (sub === 'add' || sub === 'del') {
        const hit = resolve(rest);
        if (!hit) return taskReply(chatId, chatType, '找不到「' + rest + '」。可以直接发群 id（…@chatroom）或 wxid。');
        const set = hit.kind === 'group' ? groups : privates;
        if (sub === 'add') { set.add(hit.id); cur.enabled = true; } else set.delete(hit.id);
        save();
        return taskReply(chatId, chatType, (sub === 'add' ? '加上了：' : '去掉了：') + hit.id + '\n' + render());
      }
      return taskReply(chatId, chatType, render());
    }

    if (cmd === 'corpus') {
      if (!isMaster) return taskReply(chatId, chatType, '语料开关只有主人能改。');
      if (chatType !== 'group') return taskReply(chatId, chatType, '语料只按群收集。');
      const conf = readWhaleConfig(cfg.whaleConfigPath);
      conf.wechat = conf.wechat || {};
      conf.wechat.groupSettings = conf.wechat.groupSettings || {};
      const cur = { ...(conf.wechat.groupSettings[chatId] || {}) };
      const sub = String(arg || '').trim().toLowerCase();
      if (sub === 'on' || sub === '开') cur.collect = true;
      if (sub === 'off' || sub === '关') cur.collect = false;
      if (sub === 'on' || sub === '开' || sub === 'off' || sub === '关') {
        conf.wechat.groupSettings[chatId] = cur;
        writeWhaleConfig(conf);
        if (visionConfig.wechat) visionConfig.wechat.groupSettings = conf.wechat.groupSettings;
        return taskReply(chatId, chatType, sub === 'on' || sub === '开' ? '开了，这个群的语料我开始攒（不影响回话）。' : '关了，不攒这个群的语料了。');
      }
      const st = corpus.stats(chatId);
      return taskReply(chatId, chatType, '这个群的语料：' + (cur.collect !== false ? '收集中' : '已关闭') + '\n'
        + (st.exists ? '已存 ' + st.lines + ' 条 / ' + (st.bytes / 1024).toFixed(1) + ' KB' : '还没有数据')
        + '\n（/corpus on 或 off）');
    }

    if (cmd === 'proactive') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      const conf = readWhaleConfig(cfg.whaleConfigPath);
      conf.proactive = conf.proactive || {};
      conf.proactive.group = conf.proactive.group || {};
      const sub = String(arg || '').trim().toLowerCase();
      if (sub === 'on' || sub === '开') {
        conf.proactive.group.enabled = true;
        writeWhaleConfig(conf);
        if (visionConfig) visionConfig.proactive = conf.proactive;
        groupProactiveArmed = true;
        return taskReply(chatId, chatType, '开了，群冷场时她会自己起话头。');
      }
      if (sub === 'off' || sub === '关') {
        conf.proactive.group.enabled = false;
        writeWhaleConfig(conf);
        if (visionConfig) visionConfig.proactive = conf.proactive;
        groupProactiveArmed = false;
        return taskReply(chatId, chatType, '关了，群里她不再主动起话题。');
      }
      const cur = Boolean((conf.proactive.group || {}).enabled);
      return taskReply(chatId, chatType, '群聊主动起话题：' + (cur ? '开' : '关') + '\n（/proactive on 或 off）');
    }

    if (cmd === 'care') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      const conf = readWhaleConfig(cfg.whaleConfigPath);
      conf.care = conf.care || {};
      const sub = String(arg || '').trim().toLowerCase();
      if (sub === 'on' || sub === '开') {
        conf.care.enabled = true;
        writeWhaleConfig(conf);
        if (visionConfig) visionConfig.care = conf.care;
        return taskReply(chatId, chatType, '开了，她会在时间窗内主动来关心你。');
      }
      if (sub === 'off' || sub === '关') {
        conf.care.enabled = false;
        writeWhaleConfig(conf);
        if (visionConfig) visionConfig.care = conf.care;
        return taskReply(chatId, chatType, '关了，她不会主动来关心你。');
      }
      return taskReply(chatId, chatType, '主动关心：' + (Boolean((conf.care || {}).enabled) ? '开' : '关') + '\n（/care on 或 off）');
    }

    if (cmd === 'remind') {
      if (!isMaster) return taskReply(chatId, chatType, '提醒只有主人能用。');
      if (!proactive) return taskReply(chatId, chatType, '提醒服务不可用。');
      const sub = String(arg || '').trim().toLowerCase();
      if (sub === 'cancel' || sub === '取消') {
        const list = proactive.listReminders();
        for (const x of list) proactive.cancelReminder(x.id);
        return taskReply(chatId, chatType, list.length ? '清了 ' + list.length + ' 条提醒。' : '没有待提醒的事。');
      }
      const list = proactive.listReminders();
      if (!list.length) return taskReply(chatId, chatType, '没有待提醒的事。');
      return taskReply(chatId, chatType, '待提醒：\n' + list.slice(0, 8).map((x) => {
        const d = new Date(x.due);
        return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ' + x.what;
      }).join('\n'));
    }

    if (cmd === 'persona') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      const a = String(arg || '').trim();
      if (!a || /^(show|看看|看|当前)$/i.test(a)) {
        try {
          const cur = String(fs.readFileSync(cfg.personaFile, 'utf8')).trim();
          return taskReply(chatId, chatType, '现在的人设开头：\n' + cur.slice(0, 240) + (cur.length > 240 ? '…' : ''));
        } catch {
          return taskReply(chatId, chatType, '读不到人设文件。');
        }
      }
      if (a.length < 30) return taskReply(chatId, chatType, '太短了，人设至少给 30 字。');
      try {
        const old = String(fs.readFileSync(cfg.personaFile, 'utf8'));
        const marker = '## Agent 运行规则';
        const idx = old.indexOf(marker);
        const suffix = idx >= 0 ? '\n\n' + old.slice(idx) : '';
        fs.mkdirSync(cfg.dataDir + '/persona-backups', { recursive: true });
        fs.writeFileSync(cfg.dataDir + '/persona-backups/' + Date.now() + '.md', old, 'utf8');
        fs.writeFileSync(cfg.personaFile, a + suffix, 'utf8');
        const conf = readWhaleConfig(cfg.whaleConfigPath);
        conf.persona = conf.persona || {};
        conf.persona.customPrompt = a;
        writeWhaleConfig(conf);
        return taskReply(chatId, chatType, '人设换了（' + a.length + ' 字），下一条消息生效。');
      } catch (e) {
        return taskReply(chatId, chatType, '写人设失败：' + String(e && e.message));
      }
    }

    if (cmd === 'behavior') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      if (!behavior) return taskReply(chatId, chatType, '行为参数不可用。');
      const a = String(arg || '').trim();
      if (a === 'reset' || a === '重置') {
        const all = behavior.reset();
        return taskReply(chatId, chatType, '行为参数已恢复默认：' + Object.entries(all).map(([k, v]) => k + '=' + v).join('，'));
      }
      const sm = a.match(/^set\s+(\S+)\s+(-?\d+)$/i);
      if (sm) {
        const r = behavior.set(sm[1], sm[2]);
        return taskReply(chatId, chatType, r.ok ? '已设置 ' + r.key + ' = ' + r.value : '设置失败：' + r.msg);
      }
      return taskReply(chatId, chatType, '当前行为参数：' + Object.entries(behavior.all()).map(([k, v]) => k + '=' + v).join('，') + '（改：/behavior set key value；恢复：/behavior reset）');
    }

    if (cmd === 'pref') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      if (!legacyPrefs) return taskReply(chatId, chatType, '偏好不可用。');
      const sub = String(arg || '').trim().match(/^(add|list|del|rm)\s*([\s\S]*)$/i);
      const action = sub ? sub[1].toLowerCase() : (arg ? 'add' : 'list');
      const rest = sub ? sub[2].trim() : String(arg || '').trim();
      if (action === 'list') {
        const list = legacyPrefs.all();
        if (!list.length) return taskReply(chatId, chatType, '还没有规矩。用法：/pref add 说话不超过两句');
        return taskReply(chatId, chatType, '现在生效的规矩（全局）：\n' + list.map((x, i) => (i + 1) + '. ' + x.text).join('\n'));
      }
      if (action === 'add') {
        if (!rest) return taskReply(chatId, chatType, '用法：/pref add 说话不超过两句');
        try {
          await legacyPrefs.add(rest, { source: 'command' });
          if (visionConfig) visionConfig.__prefsDirty = true;
          return taskReply(chatId, chatType, '记住这条规矩了：' + rest);
        } catch (e) {
          return taskReply(chatId, chatType, '加规矩失败：' + String(e && e.message));
        }
      }
      const gone = legacyPrefs.removeByIndex(rest);
      return taskReply(chatId, chatType, gone ? '删了规矩：' + gone.text : '没找到这条规矩。');
    }

    if (cmd === 'facts' || cmd === 'memory') {
      const scope = 'wechat:' + (chatType === 'group' ? 'g' : 'u') + ':' + chatId;
      const a = String(arg || '').trim();
      const q = a.replace(/^(搜|搜索|找|查)[\s:：]*/i, '').trim();
      try {
        if (cmd === 'facts' && /^(删|删除|忘掉|forget)/i.test(a)) {
          if (!isMaster) return taskReply(chatId, chatType, '删记忆只有主人能做。');
          const ref = a.replace(/^(删|删除|忘掉|forget)[\s:：]*/i, '').trim();
          const d = await memoryFetch('/facts', { scope, op: 'remove', ref });
          return taskReply(chatId, chatType, d.item ? '删了（可恢复）：「' + String(d.item.text).slice(0, 40) + '」' : '没找到这条。');
        }
        if (cmd === 'facts' && /^(恢复|restore)/i.test(a)) {
          if (!isMaster) return taskReply(chatId, chatType, '恢复记忆只有主人能做。');
          const ref = a.replace(/^(恢复|restore)[\s:：]*/i, '').trim();
          const d = await memoryFetch('/facts', { scope, op: 'restore', ref });
          return taskReply(chatId, chatType, d.item ? '恢复了：「' + String(d.item.text).slice(0, 40) + '」' : '没找到这条。');
        }
        if (cmd === 'facts' && /^(详情|看看|detail)/i.test(a)) {
          const ref = a.replace(/^(详情|看看|detail)[\s:：]*/i, '').trim();
          const d = await memoryFetch('/facts', { scope, op: 'detail', ref });
          if (!d.item) return taskReply(chatId, chatType, '没找到这条。');
          const one = d.item;
          const p = one.provenance || {};
          return taskReply(chatId, chatType, [
            '「' + String(one.text).slice(0, 60) + '」',
            '状态：' + (one.state || 'active') + (one.reason ? '（' + one.reason + '）' : ''),
            '重要性：' + Math.round((Number(one.importance) || 0.5) * 10) + '/10 ｜ 被用过 ' + (one.useCount || 0) + ' 次',
            '来源：' + (p.kind || '未知') + (p.count ? ' ｜ ' + p.count + ' 条' : ''),
            '置信度：' + (p.confidence !== undefined ? p.confidence : '?'),
          ].join('\n'));
        }
        const d = await memoryFetch('/facts', { scope, op: 'list', q });
        if (!d.items || !d.items.length) return taskReply(chatId, chatType, q ? '没搜到和「' + q + '」有关的事。' : '记忆库还是空的。');
        return taskReply(chatId, chatType, '记着 ' + d.total + ' 条' + (q ? '（"' + q + '"）' : '') + '，最近：\n'
          + d.items.slice(-10).map((x) => x.index + '. ' + String(x.text).slice(0, 36)).join('\n'));
      } catch (e) {
        return taskReply(chatId, chatType, '查记忆失败：' + String(e && e.message));
      }
    }

    if (cmd === 'backup') {
      if (!isMaster) return taskReply(chatId, chatType, '备份只有主人能做。');
      const sub = String(arg || '').trim();
      try {
        if (sub === 'drives' || sub === '盘符') {
          if (!legacyUsb) return taskReply(chatId, chatType, '盘符读取不可用。');
          const list = legacyUsb.listDrives();
          return taskReply(chatId, chatType, list.length ? list.map((d) => d.letter + ' ' + d.type + (d.name ? '（' + d.name + '）' : '') + ' 剩 ' + d.freeGB + 'G').join('\n') : '没读到盘符。');
        }
        if (sub === 'status' || sub === '状态') {
          const d = await memoryFetch('/memory/backups', null, 'GET');
          return taskReply(chatId, chatType, '备份目录：' + d.dir + '\n已有 ' + (d.items || []).length + ' 份快照');
        }
        const rm = sub.match(/^(restore|恢复)\s+(\S+)$/i);
        if (rm) {
          const d = await memoryFetch('/memory/restore', { name: rm[2] });
          return taskReply(chatId, chatType, '恢复了：' + ((d.restored || []).join('、') || rm[2]));
        }
        if (sub === 'export' || sub === '导出') {
          const d = await memoryFetch('/memory/export', null, 'GET');
          const file = cfg.dataDir + '/backups/memory-export-' + Date.now() + '.json';
          fs.mkdirSync(cfg.dataDir + '/backups', { recursive: true });
          fs.writeFileSync(file, JSON.stringify(d.bundle || d, null, 2), 'utf8');
          return taskReply(chatId, chatType, '导出好了：' + file);
        }
        const r = await memoryFetch('/memory/backup', {});
        return taskReply(chatId, chatType, r.file ? '备份好了：' + r.file : '还没有记忆，不用备份');
      } catch (e) {
        return taskReply(chatId, chatType, '备份失败：' + String(e && e.message));
      }
    }

    if (cmd === 'set') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      const a = String(arg || '').trim();
      const table = {
        emoji: { path: 'persona.emojiLevel', label: '颜文字密度' },
        length: { path: 'chat.groupMaxChars', label: '群聊单条字数', min: 20, max: 300 },
        bubbles: { path: 'chat.maxBubbles', label: '最多连发几条', min: 1, max: 6 },
        mute: { path: 'group.muteDefaultMinutes', label: '默认闭麦分钟', min: 1, max: 1440 },
        requireAt: { path: 'group.requireAt', label: '群里必须 @', bool: true },
        freechat: { path: 'group.freeChat', label: '允许主动接话', bool: true },
        masterreply: { path: 'group.masterAlwaysReply', label: '主人不 @ 也回', bool: true },
        oname: { path: 'persona.ownerName', label: '她对你的称呼', text: true },
      };
      if (!a) {
        return taskReply(chatId, chatType, '主人专用开关（/set 名字 值）：\n' + Object.entries(table).map(([k, v]) => '/set ' + k + ' <值>  ' + v.label).join('\n'));
      }
      const mm = a.match(/^(\S+)\s+([\s\S]+)$/);
      if (!mm) return taskReply(chatId, chatType, '格式：/set 名字 值');
      const key = mm[1];
      const raw = mm[2].trim();
      const spec = table[key];
      if (!spec) return taskReply(chatId, chatType, '不支持的开关：' + key);
      let value = raw;
      if (spec.bool) value = !/^(off|false|0|关|不|否)$/i.test(raw);
      else if (spec.text) { if (!raw || raw.length > 12) return taskReply(chatId, chatType, '称呼要 1~12 个字。'); }
      else if (spec.min !== undefined) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < spec.min || n > spec.max) return taskReply(chatId, chatType, '数值不合法。');
        value = Math.trunc(n);
      }
      const conf = readWhaleConfig(cfg.whaleConfigPath);
      const parts = spec.path.split('.');
      let node = conf;
      for (let i = 0; i < parts.length - 1; i += 1) { node[parts[i]] = node[parts[i]] || {}; node = node[parts[i]]; }
      node[parts[parts.length - 1]] = value;
      if (key === 'mute') { conf.group = conf.group || {}; conf.group.silentMinutes = value; }
      writeWhaleConfig(conf);
      try {
        if (key === 'bubbles' && behavior) behavior.set('maxBubbles', value);
        if (visionConfig) {
          let vn = visionConfig;
          for (let i = 0; i < parts.length - 1; i += 1) { vn[parts[i]] = vn[parts[i]] || {}; vn = vn[parts[i]]; }
          vn[parts[parts.length - 1]] = value;
        }
      } catch { /* ignore */ }
      return taskReply(chatId, chatType, '已设置 ' + spec.label + ' = ' + String(value));
    }

    if (cmd === 'digest') {
      const scope = 'wechat:' + (chatType === 'group' ? 'g' : 'u') + ':' + chatId;
      try {
        const st = JSON.parse(fs.readFileSync(cfg.dataDir + '/memory-digest-state.json', 'utf8')) || {};
        const lines = (st[scope] && st[scope].digest) || [];
        return taskReply(chatId, chatType, lines.length ? '最近的摘要：\n' + lines.slice(-8).map((x) => '· ' + x).join('\n') : '这个会话还没有摘要。');
      } catch {
        return taskReply(chatId, chatType, '还没有摘要。');
      }
    }

    if (cmd === 'usage') {
      const f = cfg.dataDir + '/usage.json';
      let u = null;
      try { u = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ }
      return taskReply(chatId, chatType, u
        ? '本地用量：\n' + Object.entries(u).slice(0, 8).map(([k, v]) => k + '：' + (typeof v === 'object' ? JSON.stringify(v) : v)).join('\n')
        : 'adapter 没有 DSH token 计数；模型用量请在 GUI 的用量/模型面板查看。');
    }

    if (cmd === 'ls') {
      const rel = String(arg || '').trim() || '.';
      const base = path.resolve(cfg.workspace);
      const full = path.resolve(base, rel);
      const r = path.relative(base, full);
      if (r.startsWith('..') || path.isAbsolute(r)) return taskReply(chatId, chatType, '只能看 workspace 内。');
      try {
        const items = fs.readdirSync(full, { withFileTypes: true }).slice(0, 50);
        return taskReply(chatId, chatType, items.length ? items.map((x) => (x.isDirectory() ? '[dir] ' : '      ') + x.name).join('\n') : '（空目录）');
      } catch (e) {
        return taskReply(chatId, chatType, '读不了：' + String(e && e.message));
      }
    }

    if (cmd === 'sendfile') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能让我做。');
      const rel = String(arg || '').trim();
      if (!rel) return taskReply(chatId, chatType, '用法：/sendfile workspace/笔记.md');
      const base = path.resolve(cfg.workspace);
      const full = path.resolve(base, rel.replace(/^workspace[\\/]/i, ''));
      const r = path.relative(base, full);
      if (r.startsWith('..') || path.isAbsolute(r)) return taskReply(chatId, chatType, '只能发 workspace 内的文件。');
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return taskReply(chatId, chatType, '找不到文件。');
      enqueue({ chatId, chatType, kind: 'file', file: full });
      return taskReply(chatId, chatType, '发你了：' + rel);
    }

    if (cmd === 'dl') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能做。');
      const u = String(arg || '').trim();
      if (!/^https?:\/\//i.test(u)) return taskReply(chatId, chatType, '用法：/dl https://…');
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 20 * 1024 * 1024) throw new Error('文件超过 20MB');
        const dir = path.join(cfg.workspace, 'downloads');
        fs.mkdirSync(dir, { recursive: true });
        const name = path.basename(new URL(u).pathname).replace(/[^\w.\-]/g, '_') || ('download-' + Date.now());
        fs.writeFileSync(path.join(dir, name), buf);
        return taskReply(chatId, chatType, '下载好了：workspace/downloads/' + name);
      } catch (e) {
        return taskReply(chatId, chatType, '下载失败：' + String(e && e.message));
      }
    }

    if (cmd === 'run') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能跑。');
      const m = String(arg || '').trim().match(/^(--yes\s+)?(\S+)$/);
      if (!m) return taskReply(chatId, chatType, '用法：/run --yes <workspace 内脚本>');
      if (!m[1]) return taskReply(chatId, chatType, '危险操作：请加 --yes 再跑。');
      const rel = m[2];
      const base = path.resolve(cfg.workspace);
      const full = path.resolve(base, rel);
      const r = path.relative(base, full);
      if (r.startsWith('..') || path.isAbsolute(r)) return taskReply(chatId, chatType, '只能跑 workspace 内文件。');
      if (!fs.existsSync(full)) return taskReply(chatId, chatType, '找不到脚本。');
      const ext = path.extname(full).toLowerCase();
      const bin = ext === '.ps1' ? 'powershell.exe' : ext === '.bat' ? 'cmd.exe' : (ext === '.js' || ext === '.mjs') ? process.execPath : '';
      if (!bin) return taskReply(chatId, chatType, '只支持 .ps1/.bat/.js/.mjs。');
      const args = ext === '.ps1' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', full] : ext === '.bat' ? ['/c', full] : [full];
      try {
        const out = await new Promise((resolve, reject) => {
          const child = spawn(bin, args, { cwd: cfg.workspace, windowsHide: true });
          let text = '';
          child.stdout.on('data', (c) => { text += c; });
          child.stderr.on('data', (c) => { text += c; });
          const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error('timeout')); }, 15000);
          child.on('error', reject);
          child.on('close', (code) => { clearTimeout(timer); resolve('exit=' + code + '\n' + text.slice(-3000)); });
        });
        return taskReply(chatId, chatType, String(out).slice(0, 1800));
      } catch (e) {
        return taskReply(chatId, chatType, '跑失败：' + String(e && e.message));
      }
    }

    if (cmd === 'reset') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能改。');
      if (cfg.guiBroker.enabled && chatType === 'private' && sender === masterWxid) {
        return taskReply(chatId, chatType, 'broker 固定在 GUI 会话，旧 /reset 不会清 GUI；请用 GUI 新建会话。');
      }
      const scope = 'wechat:' + (chatType === 'group' ? 'g' : 'u') + ':' + chatId;
      try { store.del(scope); } catch { /* ignore */ }
      return taskReply(chatId, chatType, '清了本会话的 adapter 映射，下条消息开新会话。');
    }

    if (cmd === 'agent') {
      if (!isMaster) return taskReply(chatId, chatType, '这个只有主人能看。');
      return taskReply(chatId, chatType, 'DSH 原生 agent 已接管；旧后台 agent 未启用。复杂后台任务用 /task。');
    }

    return null;
  }

  async function handleReminderIntent(payload) {
    if (!proactive || !careLlm || careLlm.isMock) return null;
    const text = String(payload.text || payload.content || '').trim();
    if (!/(提醒我|记得提醒|到点叫|叫我起来|别忘提醒)/.test(text)) return null;
    const chatType = taskChatType(payload);
    const sender = String(payload.sender_id || payload.senderId || '');
    if (chatType !== 'private' || sender !== masterWxid) return null;
    try {
      const parsed = await proactive.parseReminder(careLlm, text);
      if (!parsed) return null;
      const item = proactive.addReminder({
        chatId: String(payload.chat_id || payload.chatId || ''),
        ownerId: sender,
        due: parsed.due,
        what: parsed.what,
      });
      const d = new Date(item.due);
      const when = d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      return taskReply(String(payload.chat_id || payload.chatId || ''), chatType, '好，' + when + ' 提醒你：' + item.what);
    } catch { return null; }
  }

  if (proactive) {
    const reminderTimer = setInterval(() => {
      if (!readOnline()) return;
      let due = [];
      try { due = proactive.dueReminders(); } catch { return; }
      for (const r of due) {
        try {
          enqueue({ chatId: r.chatId, chatType: 'private', kind: 'text', text: '主人，到点了——' + r.what });
        } catch { /* ignore */ }
      }
    }, 20000);
    if (reminderTimer.unref) reminderTimer.unref();
  }

  let groupTopicBusy = false;
  const groupTopicTimer = setInterval(async () => {
    if (groupTopicBusy || !groupProactiveArmed || !proactive || !careLlm || careLlm.isMock) return;
    if (!((((visionConfig || {}).proactive || {}).group || {}).enabled)) return;
    if (!readOnline()) return;
    groupTopicBusy = true;
    try {
      const groups = (((visionConfig.wechat || {}).listen || {}).groups || []).map(String);
      for (const chatId of groups) {
        const hist = groupHistory.load(chatId, 30) || [];
        const lastAt = Number((hist[hist.length - 1] || {}).ts) || 0;
        if (!proactive.groupTopicAllowed(visionConfig, 'wechat:g:' + chatId, lastAt)) continue;
        const recent = hist.filter((m) => m.role === 'user' && m.text).slice(-8).map((m) => (m.name || '群友') + '：' + String(m.text).slice(0, 80)).join('\n');
        const out = await careLlm.complete({
          system: '你是群聊里的鲸鲸。根据最近的群聊内容，只输出一句适合现在发到群里的话（不超过25字，像随口加入聊天，别打招呼，别说教，别用引号，不要解释）。',
          turns: [{ role: 'user', content: recent || '（群里很久没说话了）' }],
          maxTokens: 100,
          skipGovernor: true,
        });
        const line = String(out || '').split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(-1)[0] || '';
        const text = line.replace(/^["'「」]|["'「」]$/g, '').slice(0, 40);
        if (text.length < 4) continue;
        proactive.markGroupSent('wechat:g:' + chatId);
        enqueue({ chatId, chatType: 'group', kind: 'text', text });
        log({ kind: 'group-topic', chatId, text });
      }
    } catch (e) {
      log({ kind: 'group-topic-fail', error: String(e && e.message).slice(0, 120) });
    } finally {
      groupTopicBusy = false;
    }
  }, 15 * 60 * 1000);
  if (groupTopicTimer.unref) groupTopicTimer.unref();

  const guiBrokerCache = new Map();
  const guiInputCache = new Map();
  const guiInputInflight = new Set();
  const GUI_INPUT_TTL_MS = 10 * 60 * 1000;
  const GUI_INPUT_MAX = 200;
  const guiInputJobs = createGuiInputStore(String(cfg.guiInputJobsFile || path.join(cfg.dataDir, 'gui-input-jobs.json')), { max: GUI_INPUT_MAX });
  guiInputJobs.load();

  // 群 → 独立 session 的映射（第一次见到这个群就建一个，之后一直用它）
  const chatSessionsFile = String(cfg.chatSessionsFile || 'D:/dsh-workspace/chat/whale_gril/data/chat-sessions.json');
  async function ensureChatSession(token, g, chatId, fallback, title) {
    const key = String(chatId || '');
    if (!key) return { sid: fallback, created: false };
    let store = { byChat: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(chatSessionsFile, 'utf8')) || {};
      store = raw && raw.byChat && typeof raw.byChat === 'object' ? { byChat: raw.byChat } : { byChat: raw && typeof raw === 'object' ? raw : {} };
    } catch { store = { byChat: {} }; }
    const byChat = store.byChat || {};
    if (byChat[key]) return { sid: String(byChat[key]), created: false };
    try {
      const boot = getGuiBroker(token, { ...g, sessionId: fallback || String(g.sessionId || '') || 'bootstrap' });
      const out = await boot.call('session/create', { request: { cwd: cfg.workspace } });
      const sid = String((out && out.sessionId) || '');
      if (!sid) return { sid: fallback, created: false };
      const label = String(title || '').trim().slice(0, 60);
      if (label) {
        try { await boot.call('session/rename', { request: { sessionId: sid, title: label } }); } catch { /* title is best-effort */ }
      }
      byChat[key] = sid;
      try { fs.mkdirSync(String(chatSessionsFile).replace(/[\\/][^\\/]+$/, ''), { recursive: true }); } catch { /* ignore */ }
      try { fs.writeFileSync(chatSessionsFile, JSON.stringify({ byChat }, null, 1), 'utf8'); } catch { /* ignore */ }
      log({ kind: 'chat-session', chatId: key, sessionId: sid, title: label || undefined });
      return { sid, created: true };
    } catch (e) {
      log({ kind: 'chat-session-fail', chatId: key, error: String(e && e.message).slice(0, 120) });
      return { sid: fallback, created: false };
    }
  }

  function getGuiBroker(token, g) {
    const key = String(token || '') + '|' + String(g.url || '') + '|' + String(g.sessionId || '');
    let broker = guiBrokerCache.get(key);
    if (!broker) {
      broker = createGuiBroker({
        baseUrl: g.url,
        token,
        sessionId: g.sessionId,
        timeoutMs: Number(g.timeoutMs) || 120000,
        maxQueue: Number(g.maxQueue) || 8,
      });
      guiBrokerCache.set(key, broker);
    }
    return broker;
  }

  async function handleGuiBroker(payload, { deliver = true } = {}) {
    const g = cfg.guiBroker || {};
    if (g.enabled !== true) return null;
    const chatType = taskChatType(payload);
    const sender = String(payload.sender_id || payload.senderId || '');
    const routes = Array.isArray(g.routes) ? g.routes.map(String) : ['master'];
    const isMaster = sender === masterWxid;
    const text = String(payload.text || payload.content || '').trim();
    if (!text || text.startsWith('/')) return null;
    const rawImage = String(payload.image || payload.image_base64 || '').replace(/^data:[^,]*,/, '');
    const images = rawImage ? [{
      type: 'image',
      mediaType: String(payload.mime || 'image/png').split(';')[0],
      data: rawImage,
      name: 'wechat-image',
    }] : [];
    const chatId = String(payload.chat_id || payload.chatId || '');
    const runtimeTarget = g.sessionId ? '' : String(readRuntime({ runtimeFile: cfg.runtimeFile }).guiSessionId || '');
    const targetSessionId = String(payload.targetSessionId || payload.sessionId || g.sessionId || runtimeTarget || '');
    if (!targetSessionId || !g.url) throw new Error('gui broker config incomplete');
    let bg = null;
    let sessionWasCreated = false;

    if (chatType === 'group') {
      if (!routes.includes('groups') && !routes.includes('all')) return null;
      const msgLike = {
        chatId, chatType: 'group', text, senderId: sender,
        senderName: String(payload.sender_name || payload.senderName || '群友'),
        atMe: Boolean(payload.at_me ?? payload.atMe),
        replyToBot: Boolean(payload.reply_to_bot ?? payload.replyToBot),
        ts: Number(payload.timestamp || payload.ts) || Date.now(),
      };
      // Full autonomy: every whitelisted group message reaches the agent.
      // A cheap first-stage judge decides whether the expensive GUI agent is needed.
      try { groupPolicy.observe(msgLike); } catch { /* ignore */ }
      const gate = await judgeGroupReply({
        chatId,
        text,
        senderName: msgLike.senderName,
        atMe: msgLike.atMe,
        replyToBot: msgLike.replyToBot,
      });
      if (gate && !gate.reply) {
        await observeGroupSkip({ chatId, senderName: msgLike.senderName, text });
        log({ kind: 'group-skip', chatId, reason: gate.reason, text: String(text).slice(0, 80) });
        return { ok: true, ignored: true, reason: gate.reason };
      }
    } else if (chatType === 'private') {
      const allowed = isMaster
        ? (routes.includes('master') || routes.includes('all-private') || routes.includes('all') || routes.length === 0)
        : (routes.includes('all-private') || routes.includes('all'));
      if (!allowed) return null;
    } else {
      return null;
    }

    let token = String(g.token || '');
    if (!token) {
      // GUI can be restarted by different launchers: the scheduled task writes
      // %LOCALAPPDATA%\dsh\web.log, while older scripts wrote data/gui-3080.log.
      // Read every known log and use the newest one, not a single hard-coded path.
      const candidates = [
        g.tokenFile,
        path.join(repoRoot, 'data', 'gui-3080.log'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'dsh', 'web.log'),
      ].filter(Boolean);
      let bestAt = 0;
      for (const file of new Set(candidates)) {
        try {
          const st = fs.statSync(file);
          if (st.mtimeMs < bestAt) continue;
          const found = extractTokenFromLog(fs.readFileSync(file, 'utf8'));
          if (found) { token = found; bestAt = st.mtimeMs; }
        } catch { /* missing log is fine */ }
      }
    }
    if (!token) throw new Error('gui broker token missing');
    // 群聊按 chatId 分到独立 session；别人的私聊也各开一个，只有主人的私聊沿用当前会话。
    let effectiveSession = targetSessionId;
    if (chatType === 'group' || (chatType === 'private' && !isMaster)) {
      const titleBase = String(payload.chat_title || payload.chatTitle || payload.sender_name || payload.senderName || chatId || sender || '').trim();
      const title = titleBase && chatType === 'group' && !titleBase.endsWith('群') ? titleBase + ' 群' : titleBase;
      const ensured = await ensureChatSession(token, g, chatId || sender, targetSessionId, title);
      effectiveSession = ensured.sid;
      sessionWasCreated = ensured.created;
    }
    bg = { ...g, sessionId: effectiveSession };
    const broker = getGuiBroker(token, bg);
    // 每条都带来源 + 时间戳：群聊/私聊混在同一个会话里，靠这两个字段分得清谁先说。
    const _now = new Date();
    const _hms = [_now.getHours(), _now.getMinutes(), _now.getSeconds()]
      .map((n) => String(n).padStart(2, '0')).join(':');
    const _src = chatType === 'group'
      ? '[群聊 ' + chatId + ']'
      : '[私聊 ' + (sender || chatId) + ']';
    const _who = String(payload.sender_name || payload.senderName || (chatType === 'group' ? '群友' : sender) || '对方');
    let promptText = _src + ' ' + _hms + ' ' + _who + '：' + text;
    if (chatType === 'group' && sessionWasCreated) {
      try {
        const hist = groupHistory.load(chatId, 20) || [];
        const lines = hist.filter((m) => m.role === 'user' && m.text).slice(-10)
          .map((m) => String(m.name || '群友') + '：' + String(m.text).replace(/\s+/g, ' ').slice(0, 160));
        if (lines.length) promptText = '【最近群聊】\n' + lines.join('\n') + '\n\n' + promptText;
      } catch { /* history is best effort */ }
    }
    const out = await withLease('gui-broker:' + effectiveSession, () => broker.prompt(promptText, images), {
      dir: cfg.dataDir,
      owner: 'adapter-' + process.pid,
      ttlMs: Number(g.leaseTtlMs) || 120000,
      waitMs: Number(g.leaseWaitMs) || 30000,
    });
    const rawOut = String(out.text || '').trim();
    if (chatType === 'group' && (rawOut === '[SKIP]' || rawOut === 'SKIP')) {
      log({ kind: 'group-model-skip', sessionId: effectiveSession, chatId, traceId: out.traceId, turn: out.turn });
      return { ok: true, ignored: true, reason: 'model_skip' };
    }
    const bubbles = splitBubbles(out.text);
    if (deliver) await sendBubbles({ chatId, chatType, bubbles });
    if (chatType === 'group') {
      try { groupPolicy.recordReply({ chatId }); groupPolicy.observeReply({ chatId, senderId: 'bot', text: out.text }); } catch { /* ignore */ }
    }
    log({ kind: 'gui-broker', sessionId: effectiveSession, chatType, traceId: out.traceId, turn: out.turn, seq: out.seq, text: String(out.text).slice(0, 80), ms: 0 });
    return { ok: true, broker: true, bubbles, text: out.text, traceId: out.traceId, turn: out.turn, seq: out.seq };
  }

  let taskBusy = false;
  const taskTimer = tasksStore ? setInterval(async () => {
    if (taskBusy) return;
    if (!readOnline()) return;
    let item;
    try { item = tasksStore.next(); } catch { item = null; }
    if (!item) return;
    taskBusy = true;
    try {
      const scope = 'wechat:' + (item.chatType === 'group' ? 'g' : 'u') + ':' + item.chatId;
      const out = await runHeadlessTurn({
        sessionKey: 'task:v2:' + scope,
        message: '[后台任务] ' + item.instruction,
        store,
        profile: cfg.taskProfile || cfg.headlessProfile,
        timeoutMs: cfg.taskTimeoutMs,
        cwd: cfg.workspace,
        env: {
          ...process.env,
          WHALE_SESSION_SCOPE: scope,
          WHALE_RAW_USER: String(item.instruction || ''),
          WHALE_MEMORY_URL: cfg.memoryUrl,
          WHALE_MEMORY_TOKEN: token,
          WHALE_IS_MASTER: item.ownerId === masterWxid ? '1' : '0',
        },
      });
      const latest = tasksStore.get(item.id);
      if (latest && latest.cancelled) {
        tasksStore.update(item.id, { status: 'cancelled', endedAt: Date.now(), result: '' });
        enqueue({ chatId: item.chatId, chatType: item.chatType, kind: 'text', text: '任务已取消。' });
      } else {
        const text = String(out.text || '').trim();
        tasksStore.update(item.id, { status: 'done', endedAt: Date.now(), result: text.slice(0, 4000) });
        for (const b of splitBubbles('【任务完成】\n' + text)) {
          enqueue({ chatId: item.chatId, chatType: item.chatType, kind: 'text', text: b });
        }
      }
    } catch (e) {
      tasksStore.update(item.id, { status: 'failed', endedAt: Date.now(), error: String(e && e.message).slice(0, 500) });
      enqueue({ chatId: item.chatId, chatType: item.chatType, kind: 'text', text: '任务失败：' + String(e && e.message).slice(0, 200) });
    } finally {
      taskBusy = false;
    }
  }, 5000) : null;
  if (taskTimer && taskTimer.unref) taskTimer.unref();

  async function runGuiInput(text, targetSessionId) {
    const out = await handleGuiBroker({
      chat_id: 'gui',
      chat_type: 'private',
      sender_id: masterWxid,
      targetSessionId,
      text,
    }, { deliver: false });
    if (!out) throw new Error('broker route rejected');
    return {
      ok: true,
      text: out.text,
      targetSessionId,
      traceId: out.traceId,
      turn: out.turn,
      seq: out.seq,
    };
  }

  function rememberGuiInput(key, value) {
    if (!key) return;
    guiInputCache.set(key, { at: Date.now(), value });
    while (guiInputCache.size > GUI_INPUT_MAX) {
      const oldest = guiInputCache.keys().next().value;
      if (oldest === undefined) break;
      guiInputCache.delete(oldest);
    }
  }

  function startGuiInputJob(key, targetSessionId, text) {
    if (guiInputInflight.has(key)) return;
    guiInputInflight.add(key);
    const prev = guiInputJobs.get(key) || {};
    guiInputJobs.set(key, { ...prev, at: Date.now(), status: 'queued', requestId: key, targetSessionId, text, attempts: Number(prev.attempts || 0) });
    Promise.resolve()
      .then(async () => {
        guiInputJobs.set(key, { ...(guiInputJobs.get(key) || {}), at: Date.now(), status: 'running' });
        const value = await runGuiInput(text, targetSessionId);
        rememberGuiInput(key, value);
        guiInputJobs.set(key, { ...(guiInputJobs.get(key) || {}), at: Date.now(), status: 'done', value, error: undefined });
        log({ kind: 'gui-input-async', requestId: key, targetSessionId, traceId: value.traceId, turn: value.turn, seq: value.seq });
      })
      .catch((e) => {
        const cur = guiInputJobs.get(key) || {};
        const attempts = Number(cur.attempts || 0) + 1;
        const message = String(e && e.message);
        if (attempts < 3) {
          const delay = Math.min(15000, 1000 * (2 ** attempts));
          guiInputJobs.set(key, { ...cur, at: Date.now(), status: 'queued', attempts, lastError: message, nextAt: Date.now() + delay });
          log({ kind: 'gui-input-async-retry', requestId: key, targetSessionId, attempts, delay, error: message.slice(0, 200) });
          const retryTimer = setTimeout(() => startGuiInputJob(key, targetSessionId, text), delay);
          if (retryTimer.unref) retryTimer.unref();
          return;
        }
        guiInputJobs.set(key, { ...cur, at: Date.now(), status: 'error', attempts, error: message });
        log({ kind: 'gui-input-async-fail', requestId: key, targetSessionId, attempts, error: message.slice(0, 200) });
      })
      .finally(() => guiInputInflight.delete(key));
  }

  function resumeGuiInputJobs() {
    for (const [key, job] of guiInputJobs.entries()) {
      if (!job || (job.status !== 'queued' && job.status !== 'running')) continue;
      if (!job.text || !job.targetSessionId) {
        guiInputJobs.set(key, { ...job, at: Date.now(), status: 'error', error: 'persisted job missing text/target' });
        continue;
      }
      startGuiInputJob(key, job.targetSessionId, job.text);
    }
  }


  const groupCollect = (msg) => {
    if (!msg.text || String(msg.text).startsWith('/')) return;
    const gs = ((visionConfig.wechat || {}).groupSettings || {})[msg.chatId] || {};
    if (gs.collect === false) return;
    corpus.append(msg.chatId, { ts: msg.ts, name: msg.senderName, uid: msg.senderId, text: msg.text });
  };

  const collectSticker = async (payload) => {
    const st = (visionConfig && visionConfig.sticker) || {};
    if (!st.collect || (!payload.is_sticker && !payload.isSticker)) return;
    if (!careLlm || careLlm.isMock) return;
    const raw = String(payload.image || payload.image_base64 || '').replace(/^data:[^,]*,/, '');
    if (!raw) return;
    const hash = String(payload.sticker_md5 || payload.stickerMd5 || crypto.createHash('md5').update(raw).digest('hex'));
    const indexDir = cfg.dataDir + '/stickers';
    const indexPath = indexDir + '/index.json';
    let idx = { items: [] };
    try { idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { /* ignore */ }
    idx.items = Array.isArray(idx.items) ? idx.items : [];
    if (idx.items.some((x) => x.hash === hash)) return;
    try {
      const out = await careLlm.complete({
        system: '你在看群里的一个表情包。按你自己的口味判断喜不喜欢：喜欢就收进表情库，平时聊天可以发。只输出 JSON：{"keep":true,"emotion":"happy|cute|angry|meh","desc":"不超过12字"} 或 {"keep":false}。',
        turns: [{ role: 'user', content: [
          { type: 'text', text: '这个表情包你喜欢吗？' },
          { type: 'image_url', image_url: { url: 'data:' + String(payload.mime || 'image/png') + ';base64,' + raw } },
        ] }],
        maxTokens: 200,
        skipGovernor: true,
      });
      const m = String(out || '').match(/\{[\s\S]*\}/);
      if (!m) return;
      const o = JSON.parse(m[0]);
      if (o.keep !== true) return;
      const emo = ['happy', 'cute', 'angry', 'meh'].includes(o.emotion) ? o.emotion : 'meh';
      const dirMap = { angry: '炸毛', cute: '傲娇', happy: '傲娇', meh: '其他' };
      const dir = indexDir + '/' + dirMap[emo];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dir + '/' + hash + '.png', Buffer.from(raw, 'base64'));
      try { fs.writeFileSync(dir + '/' + hash + '.txt', String(o.desc || ''), 'utf8'); } catch { /* ignore */ }
      idx.items.push({ hash, emotion: emo, desc: String(o.desc || '').slice(0, 20), at: Date.now(), from: String(payload.chat_id || '') });
      if (idx.items.length > 300) idx.items = idx.items.slice(-300);
      fs.mkdirSync(indexDir, { recursive: true });
      fs.writeFileSync(indexPath, JSON.stringify(idx, null, 1), 'utf8');
      log({ kind: 'sticker-collect', hash: hash.slice(0, 8), emotion: emo });
    } catch (e) {
      log({ kind: 'sticker-collect-fail', error: String(e && e.message).slice(0, 120) });
    }
  };

  const shareForChat = async (chatId) => {
    
    const load = (groupHistory && typeof groupHistory.load === 'function') ? groupHistory.load(chatId, 30) : [];
    const texts = (load || []).filter((m) => m.role === 'user' && m.text).map((m) => String(m.text).slice(0, 120));
    let topic = '';
    if (texts.length >= 3 && careLlm && !careLlm.isMock) {
      try {
        const out = await careLlm.complete({
          system: '你只输出 1 个适合去视频网站搜的中文话题词，不超过 8 个字，不要解释、不要标点。',
          turns: [{ role: 'user', content: texts.slice(-20).join('\n').slice(0, 1500) }],
        });
        topic = String(out || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 12);
      } catch { topic = ''; }
    }
    const cfgShare = (visionConfig && visionConfig.share) || {};
    const sources = Array.isArray(cfgShare.sources)
      ? cfgShare.sources.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
      : ['bilibili'];
    if (!sources.includes('bilibili')) return { ok: true, video: null, topic, reason: 'no_source', sources };
    let video = topic ? await bilibili.pickByKeyword(visionConfig, topic) : null;
    if (!video) video = await bilibili.pickVideo(visionConfig);
    if (!video) return { ok: true, video: null, topic };
    const comments = await bilibili.fetchComments(video.bvid, 5);
    let comment = '';
    if (careLlm && !careLlm.isMock) {
      try {
        const sys = '你叫鲸鲸，爱刷视频的女生。看完这个视频，用第一人称说一句自己的感悟或吐槽（跟自己的生活、心情有关），10~20 字；不要复述标题、不要解释、不要提 AI/模型/token/提示词。';
        const user = '话题：' + (topic || '随便') + '\n标题：' + video.title + '\n评论：' + comments.slice(0, 3).join(' / ');
        comment = String(await careLlm.complete({ system: sys, turns: [{ role: 'user', content: user }] })).trim().slice(0, 60);
      } catch { comment = ''; }
    }
    return { ok: true, video, topic, comments: comments.slice(0, 3), comment };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const readJson = async () => {
      try { return JSON.parse((await readBody(req, cfg.maxBodyBytes)) || '{}'); } catch { return {}; }
    };

    if (req.method === 'POST' && url.pathname === '/api/core/send') {
      if (!checkToken({ headers: req.headers, url: req.url }, token)) {
        return sendJson(res, 401, { ok: false, error: 'bad token' });
      }
      const body = await readJson();
      const list = (Array.isArray(body.bubbles) ? body.bubbles : [body.text]).map(String).map((x) => x.trim()).filter(Boolean);
      if (!body.chatId || !list.length) return sendJson(res, 400, { ok: false, error: 'chatId/bubbles required' });
      for (const text of list) {
        enqueue({ chatId: String(body.chatId), chatType: body.chatType === 'group' ? 'group' : 'private', kind: 'text', text });
      }
      return sendJson(res, 200, { ok: true, count: list.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/bridge/outbox') {
      return sendJson(res, 200, { ok: true, items: take(10) });
    }

    if (req.method === 'POST' && url.pathname === '/api/bridge/outbox/ack') {
      const body = await readJson();
      return sendJson(res, 200, { ok: true, removed: ack(body.ids, body.ok !== false) });
    }

    // 桥接刚启动：上一个实例可能停在"取走了但没确认"的状态，丢掉它们，别重发。
    if (req.method === 'POST' && url.pathname === '/api/bridge/outbox/reset') {
      return sendJson(res, 200, { ok: true, ...resetSending() });
    }

    if (req.method === 'POST' && url.pathname === '/api/bridge/heartbeat') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/care/due') {
      
      if (!readOnline()) return sendJson(res, 200, { ok: true, due: false, reason: 'offline' });
      const last = Number(url.searchParams.get('last') || 0);
      const sentToday = Number(url.searchParams.get('sentToday') || 0);
      try {
        let out = care.careDue(visionConfig, {
          lastSentTs: Number.isFinite(last) && last > 0 ? last : 0,
          sentToday: Number.isFinite(sentToday) ? sentToday : 0,
        });
        const careCfg = visionConfig.care || {};
        if (out.due && careCfg.modelDecide === true && careLlm && !careLlm.isMock) {
          const cacheMs = Math.max(1, Number(careCfg.modelDecideCacheMinutes) || 3) * 60000;
          if (!careDecision.at || Date.now() - careDecision.at >= cacheMs) {
            let recent = '';
            try {
              const rec = await memoryFetch('/recall', {
                scope: 'wechat:u:' + masterWxid,
                query: '最近聊天 主人 情绪 作息 在忙什么',
                isMaster: true,
              });
              recent = (rec.items || []).slice(0, 6).map((x) => String(x.text || '')).join('\n');
            } catch { /* memory optional */ }
            const now = new Date();
            const sys = '你叫鲸鲸，是一个会主动找主人说话的女生。现在只需要判断：此刻你自己想不想先发一条私聊。'
              + '没有规矩、没有时间表，就看你自己：想找他说话、觉得他这会儿需要人陪、或者手里有件想跟他讲的事，就发；'
              + '不想说话、觉得他没空、或者只是无聊想刷存在感，就不发。'
              + '安静多久只是给你参考，不是判断条件——别因为"很久没说话"就硬发，也别因为"刚聊完"就不敢发。'
              + '人聊天本来就会聊着聊着又想起一句，接着发过去；这种也算你想找他说，不用等冷场。'
              + '只回一行 JSON：{"send":true/false,"reason":"很短的理由"}。';
            const _silenceMin = lastMasterInboundAt ? Math.round((Date.now() - lastMasterInboundAt) / 60000) : null;
            const user = '现在：' + now.toLocaleString('zh-CN', { hour12: false })
              + '\n主人上次说话：' + (_silenceMin === null ? '今天还没说过' : (_silenceMin <= 0 ? '就在刚刚' : _silenceMin + ' 分钟前'))
              + '\n上次你主动：' + (last ? new Date(last).toLocaleString('zh-CN', { hour12: false }) : '从没发过')
              + '\n今天已主动：' + sentToday + ' 次'
              + '\n你记得的最近情况：\n' + (recent || '（没有额外记忆）');
            let verdict = null;
            try {
              const raw = String(await careLlm.complete({ system: sys, turns: [{ role: 'user', content: user }] }) || '').trim();
              const jm = raw.match(/\{[\s\S]*\}/);
              if (jm) {
                const obj = JSON.parse(jm[0]);
                verdict = { send: obj.send === true, reason: String(obj.reason || '').slice(0, 80) };
              } else {
                verdict = { send: !/(不发|不用|别发|不合适|否)/.test(raw), reason: raw.slice(0, 80) };
              }
            } catch (e) {
              verdict = { send: false, reason: 'model_error:' + String(e && e.message).slice(0, 60) };
            }
            careDecision = { at: Date.now(), due: Boolean(verdict && verdict.send), reason: verdict ? verdict.reason : '' };
            log({ kind: 'care-decision', due: careDecision.due, reason: careDecision.reason });
          }
          if (!careDecision.due) {
            out = { ...out, due: false, reason: 'model_skip', modelReason: careDecision.reason };
          } else {
            out = { ...out, reason: 'model_ok', modelReason: careDecision.reason };
          }
        }
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, 200, { ok: false, due: false, error: String(e && e.message) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/care') {
      
      try {
        const personaCfg = visionConfig.persona || {};
        let text;
        if (!careLlm || careLlm.isMock) {
          text = care.pickTemplate();
        } else {
          const { system, user } = care.buildCarePrompt({
            persona: personaCfg, recent: [], name: String(personaCfg.ownerName || '主人'), hour: new Date().getHours(),
          });
          const raw = await careLlm.complete({ system, turns: [{ role: 'user', content: user }] });
          text = care.cleanCareText(raw) || care.pickTemplate();
        }
        careDecision = { at: 0, due: false, reason: '' };
        return sendJson(res, 200, { ok: true, text });
      } catch (e) {
        return sendJson(res, 200, { ok: true, text: care.pickTemplate(), fallback: true });
      }
    }
    if (url.pathname === '/api/stickers/status' && req.method === 'GET') {
      if (!stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      try { return sendJson(res, 200, stickerService.status()); }
      catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }); }
    }
    if (url.pathname === '/api/stickers/pending' && req.method === 'GET') {
      if (!stickerService) return sendJson(res, 200, { ok: true, items: [] });
      try { return sendJson(res, 200, { ok: true, items: stickerService.pending() }); }
      catch { return sendJson(res, 200, { ok: true, items: [] }); }
    }
    if (url.pathname === '/api/stickers/claim' && req.method === 'POST') {
      const body = await readJson();
      if (!stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      try { return sendJson(res, 200, { ok: true, item: stickerService.claim(body.id) }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }); }
    }
    if (url.pathname === '/api/stickers/ack' && req.method === 'POST') {
      const body = await readJson();
      if (!stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      try { return sendJson(res, 200, { ok: true, item: stickerService.ack(body.id, body.status, body.error) }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }); }
    }
    if (url.pathname === '/api/stickers/enqueue' && req.method === 'POST') {
      if (!checkToken({ headers: req.headers, url: req.url }, token)) {
        return sendJson(res, 401, { ok: false, error: 'bad token' });
      }
      const body = await readJson();
      if (!stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      try {
        const job = stickerService.enqueue(body.emotion, body.chatId);
        return sendJson(res, 200, { ok: true, job: { id: job.id, emotion: job.emotion } });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message) });
      }
    }
    if (url.pathname === '/api/stickers/image' && req.method === 'GET') {
      if (!legacyStickers || !stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      const emotion = legacyStickers.normalizeEmotion(url.searchParams.get('emotion'));
      const name = String(url.searchParams.get('name') || '');
      const dir = legacyStickers.stickerDir(visionConfig, cfg.root);
      const file = legacyStickers.resolveImage(dir, emotion, name);
      if (!file) return sendJson(res, 404, { ok: false, error: '找不到这张表情包' });
      const ext = String(file).slice(String(file).lastIndexOf('.')).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (url.pathname === '/api/stickers/delete' && req.method === 'POST') {
      if (!legacyStickers || !stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      const body = await readJson();
      try {
        stickerService.requireEnabled();
        const emotion = legacyStickers.normalizeEmotion(body.emotion);
        const name = String(body.name || '');
        const dir = legacyStickers.stickerDir(visionConfig, cfg.root);
        const file = legacyStickers.resolveImage(dir, emotion, name);
        if (!file) return sendJson(res, 404, { ok: false, error: '找不到这张表情包' });
        fs.unlinkSync(file);
        return sendJson(res, 200, { ok: true, emotions: stickerService.status().emotions });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message) });
      }
    }
    if (url.pathname === '/api/stickers/open-folder' && req.method === 'POST') {
      if (!legacyStickers) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      try {
        const dir = legacyStickers.stickerDir(visionConfig, cfg.root);
        legacyStickers.safeDirectory(dir);
        if (process.platform === 'win32') {
          spawn('explorer.exe', [dir], { shell: false, windowsHide: true, stdio: 'ignore' });
        }
        return sendJson(res, 200, { ok: true, dir });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message) });
      }
    }
    if (url.pathname === '/api/stickers/upload' && req.method === 'POST') {
      if (!legacyStickers || !stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      const body = await readJson();
      try {
        stickerService.requireEnabled();
        const uploaded = legacyStickers.upload(visionConfig, cfg.root, body.emotion, body.files);
        return sendJson(res, 200, { ok: true, uploaded });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message) });
      }
    }
    if (url.pathname === '/api/stickers/test' && req.method === 'POST') {
      if (!stickerService) return sendJson(res, 400, { ok: false, error: 'sticker service unavailable' });
      const body = await readJson();
      try {
        stickerService.requireEnabled();
        const queued = stickerService.enqueue(body.emotion || 'other', body.chat ?? (visionConfig.sticker && visionConfig.sticker.testChat) ?? '文件传输助手');
        return sendJson(res, 200, { ok: true, queued });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message) });
      }
    }
    if (url.pathname.startsWith('/api/stickers/')) {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/vision') {
      const body = await readJson();
      if (!body.image) return sendJson(res, 400, { ok: false, error: 'vision unavailable' });
      try {
        const text = await vision.describe(visionConfig, {
          imageBase64: String(body.image || ''),
          mime: String(body.mime || 'image/jpeg'),
          prompt: String(body.prompt || ''),
        });
        return sendJson(res, 200, { ok: true, text: String(text || '') });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e && e.message) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/share') {
      try {
        return sendJson(res, 200, await shareForChat(url.searchParams.get('chat') || ''));
      } catch (e) {
        return sendJson(res, 200, { ok: false, video: null, error: String(e && e.message) });
      }
    }

    if (url.pathname === '/api/gui/input') {
      const remote = String(req.socket.remoteAddress || '');
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
      if (!loopback) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      if (!checkToken({ headers: req.headers, url: req.url }, token)) {
        return sendJson(res, 401, { ok: false, error: 'bad token' });
      }
      if (cfg.guiBroker.guiInput !== true || cfg.guiBroker.enabled !== true) {
        return sendJson(res, 404, { ok: false, error: 'gui input disabled' });
      }
      const body = await readJson();
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: 'text required' });
      const runtimeTarget = String(readRuntime({ runtimeFile: cfg.runtimeFile }).guiSessionId || '');
      const configuredTarget = String(cfg.guiBroker.sessionId || runtimeTarget || '');
      const requestedTarget = String(body.sessionId || body.targetSessionId || '').trim();
      if (!configuredTarget) return sendJson(res, 503, { ok: false, error: 'gui target not configured' });
      if (requestedTarget && requestedTarget !== configuredTarget) {
        return sendJson(res, 409, { ok: false, error: 'target session mismatch' });
      }
      const targetSessionId = configuredTarget;
      const asyncRequested = body.async === true || body.mode === 'async' || body.wait === false;
      const idempotencyKey = String(body.idempotencyKey || body.requestId || '').trim().slice(0, 128);
      const requestKey = idempotencyKey || (asyncRequested
        ? 'gui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        : '');
      if (requestKey) {
        if (guiInputInflight.has(requestKey)) {
          return sendJson(res, 409, { ok: false, error: 'duplicate request in flight', idempotencyKey: requestKey });
        }
        const cached = guiInputCache.get(requestKey);
        if (cached && Date.now() - cached.at < GUI_INPUT_TTL_MS) {
          return sendJson(res, 200, { ...cached.value, duplicate: true });
        }
        if (!asyncRequested) guiInputInflight.add(requestKey);
      }

      if (asyncRequested) {
        guiInputJobs.set(requestKey, { at: Date.now(), status: 'queued', requestId: requestKey, targetSessionId, text });
        startGuiInputJob(requestKey, targetSessionId, text);
        return sendJson(res, 202, { ok: true, accepted: true, requestId: requestKey, targetSessionId });
      }

      try {
        const value = await runGuiInput(text, targetSessionId);
        value.idempotencyKey = requestKey || undefined;
        rememberGuiInput(requestKey, value);
        log({ kind: 'gui-input', targetSessionId, traceId: value.traceId, turn: value.turn, seq: value.seq, idempotencyKey: requestKey || undefined });
        return sendJson(res, 200, value);
      } catch (e) {
        return sendJson(res, 503, { ok: false, error: String(e && e.message), idempotencyKey: requestKey || undefined });
      } finally {
        if (requestKey) guiInputInflight.delete(requestKey);
      }
    }

    if (url.pathname === '/api/gui/input/status') {
      const remote = String(req.socket.remoteAddress || '');
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!loopback) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      if (!checkToken({ headers: req.headers, url: req.url }, token)) {
        return sendJson(res, 401, { ok: false, error: 'bad token' });
      }
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
      const key = String(url.searchParams.get('requestId') || url.searchParams.get('idempotencyKey') || '').trim();
      if (!key) return sendJson(res, 400, { ok: false, error: 'requestId required' });
      const job = guiInputJobs.get(key);
      const cached = guiInputCache.get(key);
      if (!job && cached && Date.now() - cached.at < GUI_INPUT_TTL_MS) {
        return sendJson(res, 200, { ok: true, requestId: key, status: 'done', value: cached.value });
      }
      if (!job) return sendJson(res, 404, { ok: false, error: 'request not found', requestId: key });
      return sendJson(res, 200, { ok: true, ...job });
    }

    if (req.method === 'GET' && url.pathname === '/api/online') {
      return sendJson(res, 200, { ok: true, online: readOnline() });
    }
    if (req.method === 'POST' && url.pathname === '/api/online') {
      if (!checkToken({ headers: req.headers, url: req.url }, token)) {
        return sendJson(res, 401, { ok: false, error: 'bad token' });
      }
      const body = await readJson();
      writeOnline(body.online !== false);
      log({ kind: 'online-command', online: body.online !== false, via: 'api' });
      return sendJson(res, 200, { ok: true, online: readOnline() });
    }

    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
      return sendJson(res, 200, { ok: true, service: 'wechat-adapter' });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      let stickers = { enabled: false };
      try { stickers = stickerService ? stickerService.status() : stickers; } catch { /* disabled */ }
      let tasks = [];
      try { tasks = tasksStore.list(5).map((t) => ({ id: t.id, status: t.status, instruction: String(t.instruction).slice(0, 40) })); } catch { /* ignore */ }
      return sendJson(res, 200, {
        ok: true,
        service: 'wechat-adapter',
        mode: readMode(cfg.modeFile),
        online: readOnline(),
        legacyEnabled: cfg.legacyEnabled !== false,
        uptimeSec: Math.round(process.uptime()),
        workspace: cfg.workspace,
        memoryUrl: cfg.memoryUrl,
        groupEnabled: Boolean(cfg.groupEnabled),
        stickers: { enabled: Boolean(stickers.enabled), dir: stickers.dir || '' },
        tasks,
      });
    }

    if (req.method === 'GET' && url.pathname === '/wechat/ping') {
      return sendJson(res, 200, pingPayload());
    }
    if (req.method === 'POST' && url.pathname === '/webhook/wechat') {
      if (!checkToken({ headers: req.headers, url: req.url }, token)) {
        return sendJson(res, 401, { ok: false, error: 'bad token' });
      }
      let payload;
      try { payload = JSON.parse(await readBody(req, cfg.maxBodyBytes)); }
      catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }

      const msgId = String(payload.msg_id || payload.msgId || '');
      if (msgId && seen.has(msgId)) return sendJson(res, 200, { ok: true, duplicate: true });
      if (msgId) seen.add(msgId);

      const onlineCmd = await handleOnlineControl(payload);
      if (onlineCmd) return sendJson(res, 200, onlineCmd);
      try {
        const _cid = String(payload.chat_id || payload.chatId || payload.from || '');
        if (_cid && masterWxid && _cid === String(masterWxid)) lastMasterInboundAt = Date.now();
      } catch { /* ignore */ }
      if (!readOnline()) return sendJson(res, 200, { ok: true, ignored: true, reason: 'offline' });

      collectSticker(payload).catch(() => {});

      const miscCmd = await handleMiscCommand(payload);
      if (miscCmd) {
        log({ kind: 'admin-command', text: String(payload.text || '').slice(0, 80), bubbles: miscCmd.bubbles });
        return sendJson(res, 200, miscCmd);
      }

      const taskCmd = await handleTaskCommand(payload);
      if (taskCmd) {
        log({ kind: 'task-command', text: String(payload.text || '').slice(0, 80), bubbles: taskCmd.bubbles });
        return sendJson(res, 200, taskCmd);
      }

      const reminderCmd = await handleReminderIntent(payload);
      if (reminderCmd) {
        log({ kind: 'reminder', text: String(payload.text || '').slice(0, 80), bubbles: reminderCmd.bubbles });
        return sendJson(res, 200, reminderCmd);
      }

      const cmdChatId = String(payload.chat_id || payload.chatId || '');
      if (cmdChatId && groupPolicy.isMuted(cmdChatId)) {
        return sendJson(res, 200, { ok: true, ignored: true, reason: 'muted' });
      }

      try {
        const brokerOut = await handleGuiBroker(payload);
        if (brokerOut) return sendJson(res, 200, brokerOut);
      } catch (e) {
        log({ kind: 'gui-broker-fail', error: String(e && e.message).slice(0, 200) });
        // A configured GUI broker must fail closed. Falling through to headless
        // would silently move master private chat into wechat:u:<master> and
        // split the GUI/WeChat memory scope.
        const brokerCfg = cfg.guiBroker || {};
        const sender = String(payload.sender_id || payload.senderId || '');
        const privateChat = String(payload.chat_type || payload.chatType || 'private') !== 'group';
        if (brokerCfg.enabled === true && privateChat && sender === masterWxid) {
          return sendJson(res, 503, { ok: false, error: 'gui broker unavailable; message not routed' });
        }
      }

      try {
        const beforeTurn = async ({ msg }) => {
          if (cfg.correctAuto === false) return;
          await fetch(String(cfg.memoryUrl).replace(/\/+$/, '') + '/correct-auto', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
            body: JSON.stringify({ scope: msg.sessionKey, text: msg.text, msgId: msg.msgId }),
            signal: AbortSignal.timeout(3000),
          });
        };
        const out = await dispatchInbound(payload, {
          mode: readMode(cfg.modeFile),
          masterWxid,
          legacyBase: cfg.legacyBase,
          legacyEnabled: cfg.legacyEnabled !== false,
          groupEnabled: cfg.groupEnabled === true,
          groupShouldWake: ({ msg }) => groupPolicy.shouldWake(msg),
          groupObserve: (msg) => groupPolicy.observe(msg),
          groupCollect: (msg) => groupCollect(msg),
          groupRecordReply: (msg) => groupPolicy.recordReply(msg),
          groupObserveReply: (msg, text) => groupPolicy.observeReply(msg, text),
          token,
          beforeTurn,
          runTurn: async ({ sessionKey, message, rawText }) => {
            if (cfg.runner === 'headless') {
              let linkBlock = '';
              try {
                const urls = links.extractUrls(String(rawText || ''));
                for (const u of urls.slice(0, 2)) {
                  const info = await links.describeLink(u, { timeoutMs: 6000 });
                  const piece = links.formatForPrompt(info);
                  if (piece) linkBlock += (linkBlock ? '\n\n' : '') + piece;
                }
              } catch { /* link failure must not block chat */ }
              const selfBlock = selfnoteBlockFor(sessionKey);
              const prefBlock = prefsBlock({ max: 12, dataDir: cfg.dataDir });
              return runHeadlessTurn({
                sessionKey, message: (linkBlock ? linkBlock + '\n\n' : '') + message,
                store, profile: cfg.headlessProfile, timeoutMs: cfg.headlessTimeoutMs,
                cwd: cfg.workspace,
                env: {
                  ...process.env,
                  WHALE_SESSION_SCOPE: sessionKey,
                  WHALE_RAW_USER: String(rawText || ''),
                  WHALE_MEMORY_URL: cfg.memoryUrl,
                  WHALE_MEMORY_TOKEN: token,
                  WHALE_IS_MASTER: sessionKey === 'wechat:u:' + masterWxid ? '1' : '0',
                  WHALE_SELFNOTE_BLOCK: selfBlock || '',
                  WHALE_PREFS_BLOCK: prefBlock || '',
                },
              });
            }
            return runTurn({
              ctx, sessionKey, message, store, timeoutMs: cfg.timeoutMs,
              agentOptions: cfg.agentOptions,
              setupAgent: (agentCtx, key) => registerMemoryTools(agentCtx, {
                memoryUrl: cfg.memoryUrl, token, scope: key,
                isMaster: key === 'wechat:u:' + masterWxid,
              }),
            });
          },
          splitBubbles: (text) => splitBubbles(text, {
            maxBubbles: behavior ? (behavior.get('maxBubbles') || 2) : undefined,
          }),
          sendBubbles,
          log,
        });
        return sendJson(res, out.status, out.data);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e && e.message) });
      }
    }
    if (cfg.legacyEnabled === false) {
      return sendJson(res, 404, { ok: false, error: 'not found (legacy disabled)' });
    }
    return proxyRaw(req, res, cfg.legacyBase);
  });

  server.listen(cfg.port, cfg.host);
  const resumeTimer = setTimeout(() => resumeGuiInputJobs(), 1500);
  if (resumeTimer.unref) resumeTimer.unref();
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => server.close());
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => server.close());
  }
  return server;
}

export default { name, inject, apply };
