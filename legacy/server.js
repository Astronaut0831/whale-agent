'use strict';

// Legacy v3 entrypoint. The supported runtime is plugins/wechat-adapter + DSH.
// Direct launches are disabled unless explicitly opted in, so 8787 cannot be
// started by accident after the migration.
if (require.main === module && process.env.WHALE_LEGACY !== '1') {
  console.error('[legacy] server.js is retired. Use: npm start');
  console.error('[legacy] explicit opt-in: set WHALE_LEGACY=1&& node server.js');
  process.exit(1);
}

/**
 * 鲸鲸 HTTP 服务：
 *   网页聊天界面（SSE 流式）
 *   /api/*  设置、状态、记忆
 *   /webhook/{wechat|douyin}  给微信/抖音中转服务回调
 *
 * 用法：node server.js            启动
 *       node server.js --doctor   环境自检
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec, spawn } = require('node:child_process');

const { loadConfig, ensureConfigFile, loadSettings, saveSettings, resolveRuntime, maskKey, projectRoot, PROVIDERS, isLocalUrl, normalizeBaseUrl } = require('./src/config');
const { createLogger } = require('./src/logger');
const { Store } = require('./src/memory');
const { DeepSeekClient, LlmError } = require('./src/llm');
const { splitFacts } = require('./src/factSplit');
const { bestSpan } = require('./src/quoteSpan');
const { Bot } = require('./src/bot');
const { createGateways } = require('./src/adapters/gateway');
const persona = require('./src/persona');
const care = require('./src/care');
const outbox = require('./src/outbox');
const { matchMaster, masterWarnings } = require('./src/master');
const personaStore = require('./src/personaStore');
const memoryBackup = require('./src/memoryBackup');
const mediaCache = require('./src/mediaCache');
const features = require('./src/features');
const stickers = require('./src/stickers');
const { StickerService } = require('./src/stickerService');
const presets = require('./src/presets');
const links = require('./src/links');
const bilibili = require('./src/bilibili');
const vision = require('./src/vision');

const VERSION = require('./package.json').version;
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('请求体太大'), { statusCode: 413 }));
        return; // Drain the request, but keep the socket alive so the caller receives 413.
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
}

function sseSend(res, obj) {
  if (res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  return true;
}

function sanitizeId(id) {
  return String(id || 'default').replace(/[^\w\-.:]/g, '').slice(0, 80) || 'default';
}

/* ------------------------------------------------------------------ */
/* 运行时组装                                                          */
/* ------------------------------------------------------------------ */

function createRuntime({ root = projectRoot(), env = process.env, loggerLevel } = {}) {
  ensureConfigFile(root);
  const config = loadConfig({ root, env });
  // 称呼只认一个真源：config.json 的 persona.ownerName。
  // 老版本把它存在 data/settings.json 的 userName 里，这里做一次迁移，之后网页设置和调试台改的是同一个值。
  migrateOwnerName(config);
  // 加载主人在微信里调过的语态 / 能力（data/persona.json）
  personaStore.apply(config, personaStore.load(config));
  // 测试/自检可以传 WHALE_LOG_FILE='' 关掉文件日志：Windows 上'日志流没关'会把 data 目录占住，删不掉
  const logFileFromEnv = Object.prototype.hasOwnProperty.call(env || {}, 'WHALE_LOG_FILE') ? String(env.WHALE_LOG_FILE) : null;
  const logFile = logFileFromEnv === null ? config.paths.logFile : (logFileFromEnv || null);
  const logger = createLogger({ level: loggerLevel || config.log.level, file: logFile });
  // 数据目录可能在 E 盘：先告诉偏好模块，再建 store
  try { require('./src/prefs').setDataDir(config.paths && config.paths.dataDir); } catch { /* ignore */ }
  const store = new Store({ file: config.paths.storeFile, limits: config.memory, logger, archiveDir: config.paths.archiveDir });
  // 每次启动留一份记忆快照：换目录/重装/误点重置都能捞回来
  try {
    const snap = features.isOn(config, 'memorySnapshot') ? memoryBackup.writeSnapshot(root, 'startup') : null;
    if (snap) logger.info('记忆快照：' + snap);
  } catch (err) {
    logger.warn('记忆快照失败（不影响使用）：' + err.message);
  }
  // 媒体缓存（图片/表情包/语音 wav）永不清理会越堆越大，启动时清一次
  try {
    if (features.isOn(config, 'mediaCleanup')) {
    const mediaDir = path.join(root, 'data', 'media-cache');
    const mc = mediaCache.cleanup(mediaDir, {
      maxAgeDays: Number((config.storage || {}).mediaKeepDays) || 7,
      maxTotalMB: Number((config.storage || {}).mediaMaxMB) || 500,
    });
    if (mc.removed) logger.info(`媒体缓存清理：删 ${mc.removed} 个文件，释放 ${mc.freedMB} MB`);
    }
  } catch (err) {
    logger.warn('媒体缓存清理失败（不影响使用）：' + err.message);
  }

  // 长时间挂着也要有断点：每 30 分钟留一份（启动那份可能已经是几十小时前了）
  try {
    const timer = setInterval(() => {
      try {
        if (!features.isOn(runtime.config, 'memorySnapshot')) return;
        const file = memoryBackup.writeSnapshot(root, 'cron');
        if (file) logger.info('记忆快照（定时）：' + file);
      } catch (err) {
        logger.warn('定时记忆快照失败：' + err.message);
      }
    }, 30 * 60 * 1000);
    if (timer.unref) timer.unref();
  } catch { /* 定时器起不来不影响主流程 */ }
  const llm = new DeepSeekClient({ config, logger });
  // 用量统计：每次调用完记一笔，给每日预算用
  try {
    const budget = require('./src/budget');
    budget.setDataDir(config.paths && config.paths.dataDir);
    try { outbox.setDataDir(config.paths && config.paths.dataDir); } catch {}
try { require('./src/agent-bridge').setDataDir(config.paths && config.paths.dataDir); } catch {}
try { require('./src/behavior').setDataDir(config.paths && config.paths.dataDir); } catch {}
try { require('./src/selfedit').setDataDir(config.paths && config.paths.dataDir); } catch {}
    llm.onUsage = (u) => budget.add(u && u.total_tokens, logger);
  } catch (e) { logger.warn && logger.warn('预算统计初始化失败：' + (e && e.message)); }
  // 链接封面 → 视觉模型：视频站只靠标题太瞎，看一眼封面能说出画面
  const coverDescriber = async (url) => {
    if (config.links && config.links.coverVision === false) return '';
    try {
      const img = await links.fetchImage(url, { timeoutMs: 8000 });
      const text = await vision.describe(config, {
        imageBase64: img.buffer.toString('base64'),
        mime: img.mime,
        prompt: '这是视频或网页的封面图。一句话说清画面内容（画的是什么、什么风格或情绪）。',
      });
      return String(text || '').trim();
    } catch (err) {
      logger.warn && logger.warn('封面识别失败：' + (err && err.message));
      return '';
    }
  };
  const bot = new Bot({ config, store, llm, logger, coverDescriber });
  const gateways = createGateways({ config, bot, logger });

  // agent 干活时先吱一声：让人知道她在动，不是死了
  bot.onProgress = async ({ chatId, chatType, text }) => {
    const gw = gateways.get('wechat');
    if (!gw || !chatId || !text) return;
    try {
      await gw.send({ chatId, chatType: chatType || 'group', text, bubbles: [text], local: true });
      logger.info('[播报] ' + String(text).slice(0, 20));
    } catch (e) { logger.warn('[播报] 失败：' + (e && e.message)); }
  };
  const stickerService = new StickerService(config);
  bot.stickerService = stickerService;
  const runtime = { config, logger, store, llm, bot, gateways, stickerService, startedAt: Date.now(), version: VERSION };
  startDigestLoop(runtime);
  try { require('./src/memoryConsolidate').start(runtime); } catch (e) { logger.warn && logger.warn('[记忆巩固] 启动失败：' + (e && e.message)); }
  startTaskWorker(runtime);
  startProactiveWorker(runtime);
  startFileCleanup(runtime);
  // U 盘备份：每分钟看一眼，到了间隔就把 store/preferences 复制过去
  try { require('./src/usb').startAuto(() => runtime.config, logger); } catch (e) { logger.warn && logger.warn('备份定时器启动失败：' + (e && e.message)); }
  watchConfigFile(runtime);
  return runtime;
}

/**
 * 把新读到的配置合并进**原来那个 config 对象**。
 *
 * bot / llm / gateways 都是拿着 config 的引用构造的，只有原地改才不会出现
 *「配置文件改了、某些模块还拿着旧值」的半新半旧状态。
 */
/**
 * 顺手收图：群友发来的图片在送去做识图时，存一份进表情包库。
 * 只有开了 features.stickers 且 sticker.collect !== false 才收；
 * 上限 sticker.collectMax 张、单张不超过 2MB，按内容哈希去重。
 */
function collectStickerImage(config, imageBase64, mime, desc) {
  if (!config || !config.features || !config.features.stickers) return;
  if (config.sticker && config.sticker.collect === false) return;
  const raw = String(imageBase64 || '');
  if (!raw) return;
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch (_) {
    return;
  }
  if (!buf || buf.length < 1024 || buf.length > 2 * 1024 * 1024) return;

  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const stickers = require('./src/stickers');

  // 按文件头判断真实格式，别信 mime
  let ext = '';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ext = '.gif';
  else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = '.png';
  else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
  else if (buf.toString('ascii', 8, 12) === 'WEBP') ext = '.webp';
  else return;

  const dir = path.join(stickers.stickerDir(config, config.root), '其他');
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => /\.(gif|png|jpe?g|webp)$/i.test(f));
  const cap = Math.max(1, Number(config.sticker && config.sticker.collectMax) || 60);
  if (existing.length >= cap) return;

  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const out = path.join(dir, hash + ext);
  if (fs.existsSync(out)) return;
  fs.writeFileSync(out, buf);
  // 把识图得到的画面描述存成同名 .txt：她发表情包时，靠这个知道自己发了什么
  try {
    const d = String(desc || '').trim().slice(0, 120);
    if (d) fs.writeFileSync(out + '.txt', d, 'utf8');
  } catch (_) { /* 描述存不下来也不影响收图 */ }
}

/**
 * 长期记忆：把一个会话最近的聊天压缩成 3~5 条要点，存进该会话的 digest。
 * 之后每次拼 prompt 都会带上，她隔天也记得「你们在准备什么、发生过什么」。
 */
async function runDigestPass(runtime, { force = false } = {}) {
  // 同一时间只跑一轮摘要：并发调用会让模型偶发空返回
  if (runtime._digestBusy) return [];
  runtime._digestBusy = true;
  try {
  const done = [];
  if (!runtime || !runtime.llm || runtime.llm.isMock) return done;
  for (const key of runtime.store.sessionKeys()) {
    const sess = runtime.store.sessions.get(key);
    if (!sess) continue;
    const allMsgs = runtime.store.messages(key, 6000);
    if (allMsgs.length < 6) continue;

    // 触发参数全部来自 config.digest（不写死，方便按实测调）
    const dg = (runtime.config && runtime.config.digest) || {};
    const idleMinutes = Number(dg.idleMinutes) || 30;
    const minGapMinutes = Number(dg.minGapMinutes) || 10;
    const pendingMin = Number(dg.pendingMin) || 10;
    const pendingTokensCfg = Number(dg.pendingTokens) || 4000;
    const batchMessages = Number(dg.batchMessages) || 60;
    const batchTokens = Number(dg.batchTokens) || 8000;

    // 只处理"上次摘要之后"的新消息（没有游标时先取最近 120 条兜底）
    const cursor = Number(sess.digestUpTo || 0);
    const pending = cursor
      ? allMsgs.filter((m) => Number(m.ts || 0) > cursor)
      : allMsgs.slice(-120);
    if (!pending.length) continue;

    const estTokens = (list) => list.reduce((n, m) => n + Math.min(String(m.text || '').length, 400) / 1.5, 0);
    const pendingTokens = Math.round(estTokens(pending));
    const lastTs = Number((allMsgs[allMsgs.length - 1] || {}).ts) || 0;
    const idleMs = Date.now() - lastTs;

    let trigger = 'force';
    if (!force) {
      if (Date.now() - Number(sess.digestAt || 0) < minGapMinutes * 60000) continue;
      const byTokens = pendingTokens >= pendingTokensCfg;
      const byIdle = idleMs >= idleMinutes * 60000 && pending.length >= pendingMin;
      if (!byTokens && !byIdle) continue;
      trigger = byTokens ? 'token' : 'idle';
    }

    // 分段：超过单批上限就切段，避免截断丢历史
    const chunks = [];
    let cur = [];
    for (const m of pending) {
      if (cur.length && (cur.length >= batchMessages || estTokens([...cur, m]) > batchTokens)) {
        chunks.push(cur);
        cur = [];
      }
      cur.push(m);
    }
    if (cur.length) chunks.push(cur);

    const fmt = (list) => list
      .map((m) => `${m.role === 'assistant' ? '她' : (m.name || '群友')}：${String(m.text || '').slice(0, 400)}`)
      .join('\n');

    const SUMMARY_SYSTEM =
      '把这段聊天压成 4~6 条**长期要点**：每条只讲一件事，不要一条塞多件事，并给每条打重要性（1~10）。'
      + '只写值得以后记住的东西：人物（名字、身份、习惯、脾气）、关系、固定梗和约定、关键事件、群里在忙什么。'
      + '每条标注：about（user=关于对方/主人，her=关于你自己，relation=你与对方的关系，other=其他人）；'
      + 'msg=这条主要来自本段第几条消息（从 1 开始数）。'
      + '重要性：9~10=承诺/禁忌/关系定性；6~8=稳定偏好/人物设定/固定梗；3~5=一般事件；1~2=闲聊。'
      + '输出 JSON 数组，不要解释，形如 [{"fact":"氧化钙芼叔禁提棍木","importance":9,"about":"other","msg":3}]。每条 fact 不超过 40 字，一条只讲一件事。';

    const inferAbout = (fact) => {
      const f = String(fact || '');
      if (/互|关系|爱意|互道|约定|称/.test(f)) return 'relation';
      if (/她|本鲸|鲸|名字|迁移|人设|傲娇/.test(f)) return 'her';
      if (/主人|Astronaut|复旦|省一|竞赛|焦虑|熬夜|期中|绩点/.test(f)) return 'user';
      return 'other';
    };

    const parseFacts = (raw) => {
      const out = [];
      const text = String(raw || '').trim();
      const m = text.match(/\[[\s\S]*\]/);
      if (m) {
        try {
          const arr = JSON.parse(m[0]);
          for (const it of Array.isArray(arr) ? arr : []) {
            const fact = String((it && it.fact) || '').trim();
            if (fact.length < 4) continue;
            const imp = Number(it && it.importance);
            let about = ['user', 'her', 'relation', 'other'].includes(String(it && it.about)) ? String(it.about) : 'other';
            if (about === 'other') about = inferAbout(fact);
            const msg = Number(it && it.msg);
            const importance = Number.isFinite(imp) ? Math.max(0.05, Math.min(1, imp / 10)) : 0.5;
            // 一条只讲一件事：分号拆开，避免复合事实
            const parts = fact.split(/[；;]/).map((s) => s.trim()).filter((s) => s.length >= 4);
            for (const f of (parts.length > 1 ? parts.slice(0, 4) : [fact])) {
              out.push({ fact: f, importance, about: inferAbout(f) === 'other' ? about : (about === 'other' ? inferAbout(f) : about), msg: Number.isInteger(msg) && msg > 0 ? msg : 0 });
            }
          }
        } catch { /* 落到文本解析 */ }
      }
      if (!out.length) {
        for (const line of text.split('\n')) {
          const fact = line.replace(/^[-*·\s\d.、]+/, '').trim();
          if (fact.length >= 4) out.push({ fact, importance: 0.5, about: 'other', msg: 0 });
        }
      }
      return out;
    };

    const collected = [];
    for (let ci = 0; ci < chunks.length; ci += 1) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        try {
          const reply = await runtime.llm.complete({
            system: SUMMARY_SYSTEM,
            turns: [{ role: 'user', content: fmt(chunks[ci]) }],
            maxTokens: attempt === 0 ? 4000 : 8000,
            skipGovernor: true,
          });
          const parsed = await splitFacts(runtime.llm, parseFacts(reply), {
            enabled: !(runtime.config.memory && runtime.config.memory.splitWithModel === false),
          });
          if (parsed.length) {
            const ids = chunks[ci].map((m) => String((m && m.msgId) || '')).filter(Boolean);
            const prov = {
              from: ids[0] || '',
              to: ids[ids.length - 1] || '',
              fromTs: Number((chunks[ci][0] || {}).ts) || 0,
              toTs: Number((chunks[ci][chunks[ci].length - 1] || {}).ts) || 0,
              count: chunks[ci].length,
              kind: 'digest',
              confidence: 0.7,
              speaker: '',
            };
            const quote = fmt(chunks[ci]).slice(0, 240);
            collected.push(...parsed.map((x) => ({ ...x, prov, quote, chunkRef: chunks[ci] })));
            ok = true;
          }
        } catch (err) {
          if (attempt === 1) {
            runtime.logger.warn('[记忆摘要] 第 ' + (ci + 1) + ' 段失败：' + (err && err.message) + '（code=' + ((err && err.code) || '-') + '）');
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }

    if (!collected.length) {
      runtime.logger.warn('[记忆摘要] ' + key + ' 没抽到要点，游标不动，下轮再试');
      continue;
    }

    let lines = collected.map((x) => x.fact);
    let importances = collected.map((x) => x.importance);

    // 多段时再合并一次（map-reduce 的 reduce）
    if (chunks.length > 1) {
      try {
        const listing = collected.map((x, i) => `${i + 1}. ${x.fact}`).join('\n');
        const mergedReply = await runtime.llm.complete({
          system: '把下面多条要点合并成 4~6 条：去重、合并同义、保留最重要的信息，并给每条打重要性（1~10）。输出 JSON 数组 [{"fact":"…","importance":9}]，不要解释。',
          turns: [{ role: 'user', content: listing }],
          maxTokens: 4000,
          skipGovernor: true,
        });
        const mergedParsed = parseFacts(mergedReply);
        if (mergedParsed.length) {
          lines = mergedParsed.map((x) => x.fact);
          importances = mergedParsed.map((x) => x.importance);
        }
      } catch (err) {
        runtime.logger.warn('[记忆摘要] 合并段失败，直接用分段结果：' + (err && err.message));
      }
    }

    // 墓碑过滤：命中“别记”要求的要点直接丢
    try {
      const tb = require('./src/tombstones');
      const keep = lines.map((t, i) => ({ t, i })).filter((x) => !tb.hit(x.t, key));
      if (keep.length !== lines.length) {
        lines = keep.map((x) => x.t);
        importances = keep.map((x) => importances[x.i]);
      }
    } catch { /* ignore */ }
    lines = lines.slice(0, 6);
    importances = importances.slice(0, 6);
    if (!lines.length) continue;

    // 推进游标，避免重复摘要同一批内容
    sess.digestUpTo = Number((pending[pending.length - 1] || {}).ts) || Date.now();
    try { runtime.store.markDirty && runtime.store.markDirty(); } catch { /* ignore */ }

    runtime.logger.info(
      `[记忆摘要] ${key} 触发=${trigger} 待摘要=${pending.length}条/~${pendingTokens}tok 分${chunks.length}段 → ${lines.length}条`
    );
    // 旧的留 16 条 + 新的 6 条，去重后压到 24：记忆是累积的，不是覆盖的
    const merged = [...new Set([...runtime.store.digestOf(key).slice(-8), ...lines])].slice(-12);
    runtime.store.setDigest(key, merged);
    try {
      const narrative = require('./src/narrative');
      narrative.setDataDir(runtime.config.paths && runtime.config.paths.dataDir);
      const sessNow = runtime.store.sessions.get(key) || {};
      const firstMsg = pending[0] || {};
      const lastMsg = pending[pending.length - 1] || {};
      narrative.append({
        session: key,
        title: String(sessNow.title || (key.includes(':g:') ? '群聊' : '私聊')),
        chatType: key.includes(':g:') ? 'group' : 'private',
        from: Number(firstMsg.ts) || 0,
        to: Number(lastMsg.ts) || 0,
        count: pending.length,
        lines: merged,
      });
    } catch (e) { runtime.logger.warn && runtime.logger.warn('[叙事] 写入失败：' + (e && e.message)); }
    // 同时写进检索式记忆库：digest 只留最近，长期事实靠这里按需取
    try {
      const embedUrl = String((runtime.config.group && runtime.config.group.embedUrl) || '');
      const memMod = require('./src/memories');

      // 模型仲裁（同模型 + 事实核查员角色 + 证据 + 置信度门槛）
      try {
        const olds = memMod.listFacts(key).slice(-40);
        const minConf = Number((runtime.config.digest || {}).arbiterMinConfidence);
        const threshold = Number.isFinite(minConf) ? minConf : 0.6;
        if (olds.length >= 5) {
          const allMsgs = runtime.store.messages(key, 6000);
          const evidenceOf = (fact) => {
            const pr = fact.provenance || {};
            const from = Number(pr.fromTs) || 0;
            const to = Number(pr.toTs) || 0;
            if (!from || !to) return '';
            const hits = allMsgs
              .filter((m) => Number(m.ts) >= from && Number(m.ts) <= to && m.text)
              .slice(0, 2)
              .map((m) => String(m.text).slice(0, 60));
            return hits.length ? '（原话：' + hits.join(' / ') + '）' : '';
          };
          const oldList = olds.map((x, i) => (i + 1) + '. ' + String(x.text).slice(0, 60) + evidenceOf(x)).join('\n');
          const newList = lines.map((x) => '- ' + String(x).slice(0, 60)).join('\n');

          const system = [
            '你是事实核查员，不改写内容。任务：判断每条【旧事实】是否被【新事实】明确推翻或已经过时。',
            '要保守：只有新事实与旧事实指向同一对象时，才可能构成推翻；不确定就判 keep。',
            '逐条输出 JSON 数组，形如 [{"id":3,"verdict":"superseded","confidence":0.8,"reason":"不超过20字"}]。',
            '没有可推翻的就输出 []。不要解释，不要输出别的字。',
          ].join('');

          let verdictRaw = '';
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              verdictRaw = await runtime.llm.complete({
                system,
                turns: [{ role: 'user', content: '【旧事实】\n' + oldList + '\n\n【新事实】\n' + newList }],
                maxTokens: 4000,
                skipGovernor: true,
              });
            } catch (e) {
              if (attempt === 2) throw e;
              await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
              continue;
            }
            if (String(verdictRaw || '').trim()) break;
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          }

          const m = String(verdictRaw || '').match(/\[[\s\S]*\]/);
          let applied = 0;
          let held = 0;
          let confSum = 0;
          let confN = 0;
          if (m) {
            const arr = JSON.parse(m[0]);
            for (const v of Array.isArray(arr) ? arr : []) {
              const idx = Number(v && v.id) - 1;
              const fact = olds[idx];
              if (!fact) continue;
              const conf = Number(v && v.confidence);
              confSum += Number.isFinite(conf) ? conf : 0;
              confN += 1;
              if ((v && v.verdict) !== 'superseded') continue;
              if (Number.isFinite(conf) && conf < threshold) {
                held += 1;
                runtime.logger.info('[记忆整理] 存疑（置信 ' + conf + ' < ' + threshold + '）：' + String(fact.text).slice(0, 30));
                continue;
              }
              const killed = memMod.markObsolete(key, [fact.text], '');
              applied += killed;
              if (killed) {
                try {
                  const reason = String((v && v.reason) || '').slice(0, 40);
                  require('node:fs').appendFileSync(
                    'data/memory-merge.log',
                    '[' + new Date().toISOString() + '] ' + key + ' 仲裁取代：' + String(fact.text).slice(0, 40) + ' ｜ ' + reason + '\n',
                    'utf8'
                  );
                } catch { /* ignore */ }
              }
            }
          }
          runtime.logger.info(
            '[记忆整理] 仲裁：候选 ' + olds.length + ' / 判过时 ' + applied + ' / 存疑 ' + held +
            ' / 平均置信度 ' + (confN ? (confSum / confN).toFixed(2) : '-') + ' / 门槛 ' + threshold
          );
        }
      } catch (e) {
        runtime.logger.warn && runtime.logger.warn('[记忆整理] 仲裁跳过：' + (e && e.message));
      }

      // 每条事实的来源区间（前面 collected 里带着 chunk 的 msgId/ts）
      const provenances = lines.map((_, i) => (collected[i] && collected[i].prov) || { kind: 'digest', confidence: 0.7 });
      const overlap = (a, b) => {
        const sa = String(a || '');
        const sb = String(b || '');
        let n = 0;
        for (let i = 0; i + 1 < sa.length; i += 1) if (sb.includes(sa.slice(i, i + 2))) n += 1;
        return n;
      };
      const evidences = lines.map((fact) => {
        let best = null;
        let bestScore = -1;
        for (const c of collected) {
          const s = overlap(fact, c.fact);
          if (s > bestScore) { bestScore = s; best = c; }
        }
        if (!best) return null;
        const p = best.prov || {};
        const idx = Number(best.msg) - 1;
        let src = best.chunkRef && idx >= 0 && idx < best.chunkRef.length ? best.chunkRef[idx] : null;
        if (!src && best.chunkRef) {
          let bm = null;
          let bs = -1;
          for (const m of best.chunkRef) {
            const s = overlap(fact, m && m.text);
            if (s > bs) { bs = s; bm = m; }
          }
          if (bm && bs > 0) src = bm;
        }
        const span = src ? bestSpan(fact, src.text) : null;
        return {
          quote: span ? span.text : String(best.quote || '').replace(/\n/g, ' ').slice(0, 240),
          quoteSpan: span ? { start: span.start, end: span.end } : null,
          msgIds: src ? [String(src.msgId || '')].filter(Boolean) : [p.from, p.to].filter(Boolean),
          confidence: Number(p.confidence),
          about: best.about || 'other',
        };
      });
      await memMod.addMany(key, lines, { embedUrl, source: '摘要', importances, provenances, evidences });
      // 记忆卫生：近似去重 + 过时条目限量保留
      const ded = memMod.dedupeSession(key);
      const pruned = memMod.pruneSuperseded(key, 50);
      if (ded.marked || pruned) runtime.logger.info('[记忆整理] 去重 ' + ded.marked + ' 条，清理过时 ' + pruned + ' 条');
    } catch (e) { runtime.logger.warn && runtime.logger.warn('[记忆库] 写入失败：' + (e && e.message)); }
    runtime.logger.info(`[记忆摘要] ${key} 更新 ${lines.length} 条`);
    // L4：让她对自己做一句观察（失败就算了，不重试不刷钱）
    try {
      const selfNote = require('./src/selfnote');
      const brief = msgs.slice(-30).map((m) => (m.role === "assistant" ? "她：" : (m.name || "群友") + "：") + String(m.text || "").slice(0, 80)).join("\n");
      const sno = await runtime.llm.complete({
        system: '你在回看自己刚才的聊天。用一句不超过 30 字的话，写下你对自己表现的一个观察（语气、习惯、和人的关系都行）。只输出这句话，不要解释。没有值得写的就输出「无」。',
        turns: [{ role: "user", content: brief }],
        maxTokens: 1500,
        skipGovernor: true,
      });
      const t = String(sno || "").trim();
      if (t && t !== "无" && t.length >= 4) {
        selfNote.add(t, { source: "摘要" });
        runtime.logger.info("[自我认知] 新增：" + t.slice(0, 40));
      }
    } catch { /* 忽略 */ }
    done.push({ key, added: lines.length, digest: merged });
  }
  return done;
  } finally {
    runtime._digestBusy = false;
  }
}

/** 后台每 5 分钟扫一次（真正写入受 8 分钟间隔限制） */
/** 后台任务 worker：一次只跑一个，关键节点播报，完成/失败都要回话 */
function startTaskWorker(runtime) {
  const tasks = require('./src/tasks');
  const outboxMod = require('./src/outbox');
  const wsMod = require('./src/workspace');
  try { tasks.setDataDir(runtime.config.paths && runtime.config.paths.dataDir); } catch { /* ignore */ }
  try { const n = tasks.markInterrupted(); if (n) runtime.logger.warn('[任务] 上次有 ' + n + ' 个任务被重启中断'); } catch { /* ignore */ }
  let busy = false;
  const push = async (t, text) => {
    try { await runtime.bot.onProgress({ chatId: t.chatId, chatType: t.chatType, text }); } catch { /* ignore */ }
  };
  setInterval(async () => {
    if (busy) return;
    let t = null;
    try { t = tasks.next(); } catch { return; }
    if (!t) return;
    busy = true;
    try {
      tasks.addStep(t.id, '开始');
      await push(t, '开始弄了');
      const r = await runtime.bot.runTask({
        instruction: t.instruction,
        isCancelled: () => { const cur = tasks.get(t.id); return !cur || cur.cancelled; },
        onStep: async (name) => {
          tasks.addStep(t.id, name);
          const label = { write_file: '在写文件', download_file: '在下载', run_script: '在跑脚本', search_web: '在查资料' }[name];
          if (label) await push(t, label);
        },
      });
      if (r.cancelled) {
        tasks.update(t.id, { status: 'cancelled', endedAt: Date.now() });
        await push(t, '停了。');
      } else {
        tasks.update(t.id, { status: 'done', endedAt: Date.now(), result: r.text || '' });
        const files = [...String(r.text || '').matchAll(/FILE:\s*(\S+)/g)].map((m) => m[1]).slice(0, 2);
        for (const f of files) {
          try { outboxMod.enqueue({ chatId: t.chatId, chatType: t.chatType, kind: 'file', file: wsMod.resolve(f.replace(/^workspace[\\/]/i, '')) }); } catch { /* ignore */ }
        }
        await push(t, String(r.text || '弄完了').slice(0, 1500));
      }
    } catch (e) {
      tasks.update(t.id, { status: 'failed', endedAt: Date.now(), error: String((e && e.message) || e).slice(0, 200) });
      await push(t, '没搞成：' + String((e && e.message) || e).slice(0, 120));
    } finally {
      busy = false;
    }
  }, 3000).unref();
}

/** 主动性 worker：定时提醒 / 主动关心 / 群聊起话题 */
/** 群友文件缓存：超过 14 天自动删（按系统钟） */
function startFileCleanup(runtime) {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const ROOT_DIR = 'E:\\whale-ai-files';
  const keepDays = Number((runtime.config.files && runtime.config.files.keepDays) || 14);
  const sweep = () => {
    try {
      if (!fs2.existsSync(ROOT_DIR)) return;
      const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
      let removed = 0;
      for (const name of fs2.readdirSync(ROOT_DIR)) {
        const full = path2.join(ROOT_DIR, name);
        try {
          const st = fs2.statSync(full);
          if (st.mtimeMs < cutoff) { fs2.rmSync(full, { recursive: true, force: true }); removed += 1; }
        } catch { /* ignore */ }
      }
      if (removed) runtime.logger.info('[文件] 清理过期缓存 ' + removed + ' 项（超过 ' + keepDays + ' 天）');
    } catch (e) { runtime.logger.warn && runtime.logger.warn('[文件] 清理失败：' + (e && e.message)); }
  };
  sweep();
  setInterval(sweep, 6 * 3600 * 1000).unref();
}

function startProactiveWorker(runtime) {
  const pro = require('./src/proactive');
  const outboxMod = require('./src/outbox');
  try { pro.setDataDir(runtime.config.paths && runtime.config.paths.dataDir); } catch { /* ignore */ }
  const masterWxid = ((runtime.config.persona || {}).master || {}).wxids || [];
  const owner = String(masterWxid[0] || '');
  const ownerKey = 'wechat:u:' + owner;

  // A. 提醒：每 20 秒扫一次
  setInterval(() => {
    let due = [];
    try { due = pro.dueReminders(); } catch { return; }
    for (const r of due) {
      try {
        outboxMod.enqueue({ chatId: r.chatId, chatType: 'private', kind: 'text', text: '主人，到点了——' + r.what });
        runtime.logger.info('[提醒] 已发：' + String(r.what).slice(0, 20));
      } catch (e) { runtime.logger.warn('[提醒] 发送失败：' + (e && e.message)); }
    }
  }, 20 * 1000).unref();

  // B. 主动关心：每 15 分钟评估一次
  setInterval(async () => {
    try {
      const cfg = runtime.config;
      if (!pro.careAllowed(cfg)) return;
      if (!owner) return;
      const last = runtime.store.messages(ownerKey, 1)[0];
      const lastAt = Number((last && last.ts) || 0);
      const minHours = Number((cfg.proactive && cfg.proactive.care && cfg.proactive.care.minHoursSinceLast) ?? 4);
      if (lastAt && Date.now() - lastAt < minHours * 3600 * 1000) return;
      const mem = require('./src/memories');
      let facts = [];
      try { facts = mem.listFacts(ownerKey); } catch { /* ignore */ }
      const digest = (runtime.store.digestOf(ownerKey) || []);
      const v = await pro.decideCare(runtime.bot.llm, { facts, digest, lastTalkAt: lastAt });
      if (!v.send) return;
      pro.markCareSent();
      outboxMod.enqueue({ chatId: owner, chatType: 'private', kind: 'text', text: String(v.text).slice(0, 80) });
      runtime.logger.info('[主动] 发了一句：' + String(v.text).slice(0, 30));
    } catch (e) { runtime.logger.warn('[主动] 关心判断失败：' + (e && e.message)); }
  }, 15 * 60 * 1000).unref();

  // C. 群聊起话题：每 15 分钟看一次
  setInterval(async () => {
    try {
      const cfg = runtime.config;
      const groups = ((cfg.wechat && cfg.wechat.listen && cfg.wechat.listen.groups) || []).map(String);
      if (!groups.length) return;
      for (const [key, sess] of runtime.store.sessions) {
        if (sess.chatType !== 'group') continue;
        const chatId = String(sess.chatId || '');
        if (!groups.includes(chatId)) continue;
        const msgs = runtime.store.messages(key, 1);
        const lastAt = Number((msgs[0] && msgs[0].ts) || 0);
        if (!pro.groupTopicAllowed(cfg, key, lastAt)) continue;
        const digest = (runtime.store.digestOf(key) || []).slice(-8).join('；');
        const r = await runtime.bot.runTask({
          instruction: '你在群「' + (sess.title || chatId) + '」里想起个话头。最近的群聊摘要：' + (digest || '（没有）') +
            '。可以用 search_web 看看最近有什么新鲜事，然后只输出一句适合现在发到群里的话（不超过25字，别打招呼，别说教，别用引号）。',
        });
        const line = String((r && r.text) || '').split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(-1)[0] || '';
        const text = line.replace(/^["'「」]|["'「」]$/g, '').slice(0, 40);
        if (text.length < 4) continue;
        pro.markGroupSent(key);
        outboxMod.enqueue({ chatId, chatType: 'group', kind: 'text', text });
        runtime.logger.info('[主动] 群里起话题：' + text);
      }
    } catch (e) { runtime.logger.warn('[主动] 群话题失败：' + (e && e.message)); }
  }, 15 * 60 * 1000).unref();
}

function startDigestLoop(runtime) {
  // 启动后补跑一次：重启期间攒下的消息不用等满 5 分钟
  setTimeout(() => {
    runDigestPass(runtime).catch((e) => runtime.logger.warn('[记忆摘要] 异常：' + (e && e.message)));
  }, 15 * 1000);
  const timer = setInterval(() => {
    runDigestPass(runtime).catch((e) => runtime.logger.warn('[记忆摘要] 异常：' + (e && e.message)));
  }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function mergeConfigInPlace(target, src) {
  for (const [key, value] of Object.entries(src || {})) {
    if (key === 'paths' || key === 'env' || key === 'root' || key === 'configExists') continue;
    const cur = target[key];
    const both = isPlainObject(value) && isPlainObject(cur);
    if (both) mergeConfigInPlace(cur, value);
    else target[key] = value;
  }
  return target;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 监听 config.json：手动改完存盘就生效，不用再重启服务。 */
function watchConfigFile(runtime) {
  // 测试/沙箱里 fs.watch 可能不可用，允许关掉（config.watchConfig=false）
  if (runtime.config.watchConfig === false) return;
  const file = runtime.config.paths.configFile;
  let timer = null;
  try {
    const watcher = fs.watch(file, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
          JSON.parse(raw); // 先确认是合法 JSON，写坏了就别覆盖内存里的好配置
          mergeConfigInPlace(runtime.config, loadConfig({ root: runtime.config.root, env: runtime.config.env }));
          runtime.stickerService?.reconcile();
          if (runtime.llm && typeof runtime.llm.reload === 'function') runtime.llm.reload();
          runtime.logger.info('config.json 已重新加载（改动已生效，不用重启）');
        } catch (err) {
          runtime.logger.warn(`config.json 改了但没读成功，先按老配置跑：${err && err.message}`);
        }
      }, 250);
    });
    watcher.unref?.();
    runtime.configWatcher = watcher;
  } catch (err) {
    runtime.logger.warn(`监听 config.json 失败（手动改完记得重启服务）：${err && err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 调试台：直接读写 config.json（改完立刻生效，不用重启）              */
/* ------------------------------------------------------------------ */

// 这些路径网页「⚙️ 设置」会写进 data/settings.json，而它的优先级高于 config.json
const SETTINGS_SHADOW = {
  provider: ['provider'],
  'deepseek.provider': ['provider'],
  'deepseek.apiKey': ['apiKey'],
  'deepseek.baseUrl': ['baseUrl'],
  'deepseek.model': ['model'],
  'deepseek.temperature': ['temperature'],
  'deepseek.mock': ['mock'],
  'persona.ownerName': ['userName'],
};

// 密钥类：网页只显示「已设置 / 没配」，留空提交表示「不改」
const SECRET_PATHS = new Set([
  'deepseek.apiKey',
  'vision.apiKey',
  'voice.apiKey',
  'gateway.wechat.inboundToken',
  'gateway.douyin.inboundToken',
]);

function getByPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(obj, dotted, value) {
  const parts = String(dotted).split('.').filter(Boolean);
  if (!parts.length) throw new Error('空的字段名');
  for (const p of parts) {
    if (p.startsWith('_') || p === '__proto__' || p === 'constructor' || p === 'prototype') {
      throw new Error('不允许改这个字段：' + dotted);
    }
  }
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 按现有配置的类型把网页送来的值转成正确类型（数字/开关/数组/JSON） */
function coerceValue(config, dotted, value) {
  const cur = getByPath(config, dotted);
  if (typeof cur === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
    if (!Number.isFinite(n)) throw new Error('「' + dotted + '」要填数字');
    return n;
  }
  if (typeof cur === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
  if (Array.isArray(cur)) {
    if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
    return String(value == null ? '' : value).split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  }
  if (isPlainObject(cur)) {
    if (isPlainObject(value)) return value;
    try {
      return JSON.parse(String(value));
    } catch {
      throw new Error('「' + dotted + '」要填合法的 JSON');
    }
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 给网页看的配置：去掉内部字段，密钥留空但告诉它「配没配」 */
function publicConfig(config) {
  const internal = new Set(['env', 'paths', 'root', 'configExists']);
  const out = JSON.parse(JSON.stringify(config, (k, v) => (internal.has(k) ? undefined : v)));
  const secrets = {};
  for (const path of SECRET_PATHS) {
    const v = getByPath(config, path);
    secrets[path] = Boolean(v && String(v).trim());
    try { setByPath(out, path, ''); } catch { /* 没有这段就算了 */ }
  }
  return { config: out, secrets };
}

/** 把 settings.json 里会「盖住」刚改的字段清掉，否则网页上改了 config.json 却不生效 */
function clearSettingsShadow(runtime, paths) {
  const file = runtime.config.paths.settingsFile;
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return [];
  }
  const cleared = [];
  for (const path of paths) {
    for (const key of SETTINGS_SHADOW[path] || []) {
      if (Object.prototype.hasOwnProperty.call(cur, key)) {
        delete cur[key];
        cleared.push('settings.' + key);
      }
    }
    if (path.startsWith('group.')) {
      const gk = path.slice('group.'.length);
      if (isPlainObject(cur.group) && Object.prototype.hasOwnProperty.call(cur.group, gk)) {
        delete cur.group[gk];
        cleared.push('settings.group.' + gk);
        if (!Object.keys(cur.group).length) delete cur.group;
      }
    }
  }
  if (cleared.length) {
    try { fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8'); } catch { /* 写不了就算了 */ }
  }
  return cleared;
}

function isLoopbackRequest(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '' || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 远程写操作：必须显式打开 allowRemote，并且带一个非默认的 x-bot-token */
function remoteAuthorized(req, runtime) {
  const allow = Boolean(runtime.config.server && runtime.config.server.allowRemote);
  if (!allow) return false;
  const token = String(
    (runtime.config.gateway && runtime.config.gateway.wechat && runtime.config.gateway.wechat.inboundToken) || ''
  ).trim();
  if (!token || token === 'change-me-wechat') return false;
  return String(req.headers['x-bot-token'] || '').trim() === token;
}

/** 把网页提交的 { "persona.name": "新名字" } 写进 config.json 并立刻生效 */
function applyConfigPatch(runtime, patch) {
  if (!isPlainObject(patch)) throw new Error('patch 要是 { 字段名: 新值 } 这样的对象');
  const file = runtime.config.paths.configFile;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    raw = {};
  }
  const changed = [];
  for (const [dotted, value] of Object.entries(patch)) {
    const path = String(dotted || '').trim();
    if (!path) continue;
    // 密钥留空 = 不改（网页上看不到已存的 Key，不能一保存就把它清了）
    if (SECRET_PATHS.has(path) && (value === '' || value === null || value === undefined)) continue;
    setByPath(raw, path, coerceValue(runtime.config, path, value));
    changed.push(path);
  }
  if (!changed.length) return { changed, cleared: [] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  const cleared = clearSettingsShadow(runtime, changed);
  mergeConfigInPlace(runtime.config, loadConfig({ root: runtime.config.root, env: runtime.config.env }));
          runtime.stickerService?.reconcile();
  if (runtime.llm && typeof runtime.llm.reload === 'function') runtime.llm.reload();
  runtime.logger.info(`调试台保存了设置：${changed.join('、')}${cleared.length ? `（同时清了 ${cleared.join('、')}，让改动真的生效）` : ''}`);
  return { changed, cleared };
}

/* ---------------- 微信多账号：给网页列账号 / 选账号 ---------------- */

/** 某个账号目录里 .db 的最新修改时间（只 stat，不解密，毫秒级） */
function newestDbMtime(storageDir) {
  let newest = 0;
  const stack = [storageDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.db') || /-(wal|shm)$/.test(entry.name)) continue;
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* 读不到就算了 */
      }
    }
  }
  return newest;
}

/** 扫 dbDir 下所有账号目录（判定标准：子目录里有 db_storage） */
function scanWechatAccounts(dbDir) {
  const out = [];
  if (!dbDir) return out;
  let names = [];
  try {
    names = fs.readdirSync(dbDir);
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = path.join(dbDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const storage = path.join(dir, 'db_storage');
    if (!fs.existsSync(storage)) continue;
    out.push({
      account: name,
      // 目录名末尾 4 位是微信加的哈希，去掉就是 wxid（和 wechatauto 的规则一致）
      wxid: name.replace(/_\w{4}$/, ''),
      lastActive: newestDbMtime(storage),
    });
  }
  out.sort((a, b) => b.lastActive - a.lastActive);
  return out;
}

function readAccountsCache(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.paths.dataDir, 'accounts.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (raw && Array.isArray(raw.accounts)) return raw;
  } catch {
    /* 没有缓存是正常情况（桥接还没跑过 --list-accounts） */
  }
  return null;
}

/** 把配置里写的账号（目录名 / wxid / 昵称）对上实际目录 */
function matchAccountDir(accounts, wanted) {
  const w = String(wanted || '').trim();
  if (!w) return '';
  const exact = accounts.find((a) => a.account === w);
  if (exact) return exact.account;
  const byWxid = accounts.find((a) => a.wxid === w);
  if (byWxid) return byWxid.account;
  const loose = accounts.filter(
    (a) => a.account.toLowerCase().startsWith(w.toLowerCase()) || (a.nick && a.nick === w)
  );
  return loose.length === 1 ? loose[0].account : '';
}

function wechatAccountsPayload(runtime) {
  const { config, gateways } = runtime;
  const cache = readAccountsCache(config);
  const dbDir = String((config.wechat && config.wechat.dbDir) || (cache && cache.dbDir) || '').trim();
  const nickMap = new Map(((cache && cache.accounts) || []).map((a) => [a.account, a.nick || '']));
  const accounts = scanWechatAccounts(dbDir).map((a) => ({
    ...a,
    nick: nickMap.get(a.account) || '',
    active: false,
  }));
  const wanted = String((config.wechat && config.wechat.account) || '').trim();
  const current = matchAccountDir(accounts, wanted) || (wanted ? '' : '');
  for (const a of accounts) a.active = a.account === current;
  const gw = gateways.get('wechat');
  const bridge = gw ? gw.status().bridge : null;
  return {
    ok: true,
    dbDir,
    wanted,
    current,
    accounts,
    live: bridge
      ? {
        online: bridge.online,
        account: bridge.account,
        nick: bridge.accountNick,
        ok: bridge.accountOk,
        why: bridge.accountWhy,
        guard: bridge.accountGuard,
      }
      : null,
  };
}

/** 让桥接脚本扫一遍账号（会开库读昵称，慢；只在用户点「刷新」时调） */
function refreshWechatAccounts(runtime, timeoutMs = 30000) {
  const { config, logger } = runtime;
  const bundled = path.join(config.root, 'runtime', 'python', 'python.exe');
  const exe = fs.existsSync(bundled) ? bundled : 'python';
  const script = path.join(config.root, 'examples', 'wechatauto_bridge.py');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: '找不到 examples/wechatauto_bridge.py' });
  return new Promise((resolve) => {
    let settled = false;
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    // 和启动脚本一样：清掉残留代理，否则取数据库密钥那一步会连不上（不影响本机读库，但省得踩坑）
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
    let child;
    try {
      child = spawn(exe, ['-u', script, '--list-accounts'], { cwd: config.root, windowsHide: true, env });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let tail = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tail) logger.info('[accounts] ' + tail.replace(/\s+/g, ' ').slice(-300));
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: '扫描账号超时（微信没登录，或读不到数据库密钥）' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { tail = (tail + String(d)).slice(-1200); });
    child.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-1200); });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', () => {
      const cache = readAccountsCache(config);
      finish(cache ? { ok: true, cache } : { ok: false, error: '扫描没拿到账号（看 data/wechat-bridge-4x.log）' });
    });
  });
}

function statusPayload(runtime) {
  const { config, llm, bot, gateways } = runtime;
  const rt = resolveRuntime(config);
  return {
    ok: true,
    name: config.persona.name,
    version: runtime.version,
    node: process.version,
    uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
    mock: llm.isMock,
    provider: llm.provider,
    providerLabel: llm.providerLabel,
    needsKey: llm.needsKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    keyMasked: maskKey(rt.apiKey),
    hasKey: Boolean(rt.apiKey),
    temperature: llm.temperature,
    memory: storeSummary(runtime),
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
      maxRepliesPerHour: config.group.maxRepliesPerHour,
    },
    gateways: [...gateways.values()].map((g) => g.status()),
    webhookPaths: [...gateways.keys()].map((p) => `/webhook/${p}`),
  };
}

function storeSummary(runtime) {
  const s = runtime.store.summary();
  return { sessions: s.sessions, messages: s.messages, notes: s.notes, totalMessages: s.totalMessages, totalReplies: s.totalReplies };
}

/* ---------------- 主动分享：从群聊热点找视频 ---------------- */

async function shareForChat(runtime, chatId) {
  const key = chatId ? `wechat:g:${chatId}` : '';
  let texts = [];
  if (key) {
    try {
      texts = runtime.store
        .messages(key, 30)
        .filter((m) => m.role === 'user' && m.text)
        .map((m) => String(m.text).slice(0, 120));
    } catch {
      texts = [];
    }
  }
  let topic = '';
  if (texts.length >= 3) {
    try {
      const out = await runtime.llm.complete({
        system: '你只输出 1 个适合去视频网站搜的中文话题词，不超过 8 个字，不要解释、不要标点。',
        turns: [{ role: 'user', content: texts.slice(-20).join('\n').slice(0, 1500) }],
      });
      topic = String(out).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 12);
    } catch {
      topic = '';
    }
  }
  // 来源：以前这个配置项没人读，写什么都是硬抓 B 站。现在至少让它真的能关。
  const sources = Array.isArray(runtime.config.share && runtime.config.share.sources)
    ? runtime.config.share.sources.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
    : ['bilibili'];
  if (!sources.includes('bilibili')) {
    return { ok: true, video: null, topic, reason: 'no_source', sources };
  }
  let video = topic ? await bilibili.pickByKeyword(runtime.config, topic) : null;
  if (!video) video = await bilibili.pickVideo(runtime.config);
  if (!video) return { ok: true, video: null, topic };
  const comments = await bilibili.fetchComments(video.bvid, 5);
  let comment = '';
  try {
    const sys = '你叫鲸鲸，爱刷视频的女生。看完这个视频，用第一人称说一句自己的感悟或吐槽（跟自己的生活、心情有关），10~20 字；不要复述标题、不要解释、不要提 AI/模型/token/提示词。';
    const user = `话题：${topic || '随便'}\n标题：${video.title}\n评论：${comments.slice(0, 3).join(' / ')}`;
    comment = String(await runtime.llm.complete({ system: sys, turns: [{ role: 'user', content: user }] }))
      .trim()
      .slice(0, 60);
  } catch {
    comment = '';
  }
  return { ok: true, video, topic, comments: comments.slice(0, 3), comment };
}

/**
 * 主动搭话的内容：问她一句「在干啥 / 累不累」。
 * 演示模式（没 Key）直接用内置台词，省得等模型；有 Key 就带着最近聊天生成，避免每次同一句。
 */
async function careForChat(runtime, chatId) {
  const personaCfg = runtime.config.persona || {};
  const name = String(personaCfg.ownerName || '主人');
  const hour = new Date().getHours();
  let recent = [];
  if (chatId) {
    // 会话 key 可能是私聊（wechat:u:<id>）也可能是群（wechat:g:<id>），两边都试
    for (const key of [`wechat:u:${chatId}`, `wechat:g:${chatId}`, chatId]) {
      try {
        const msgs = runtime.store.messages(key, 12) || [];
        if (msgs.length) {
          recent = msgs
            .filter((m) => m && m.text)
            .map((m) => `${m.role === 'user' ? '对方' : (personaCfg.name || '我')}：${String(m.text).slice(0, 60)}`);
          break;
        }
      } catch {
        recent = [];
      }
    }
  }
  if (runtime.llm.isMock) {
    return { ok: true, text: care.pickTemplate(), mock: true, hour };
  }
  try {
    const { system, user } = care.buildCarePrompt({ persona: personaCfg, recent, name, hour });
    const raw = await runtime.llm.complete({ system, turns: [{ role: 'user', content: user }] });
    const text = care.cleanCareText(raw) || care.pickTemplate();
    return { ok: true, text, mock: false, hour };
  } catch (err) {
    runtime.logger.warn('搭话模型失败，用内置台词：' + (err && err.message));
    return { ok: true, text: care.pickTemplate(), mock: true, fallback: true, hour };
  }
}

/* ---------------- 消息汇总 ---------------- */


/* ---------------- 人设调教（浏览器表单用） ---------------- */

function applyPersonaPatch(runtime, body) {
  if (body && body.reset) {
    personaStore.clear(runtime.config);
    runtime.logger.info('人设调教：恢复默认');
    return { ok: true, persona: personaStore.summary(runtime.config) };
  }
  const patch = {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (body.name !== undefined) patch.name = str(body.name, 40) || '鲸鲸';
  if (body.job !== undefined) patch.job = str(body.job, 80) || '自由职业';
  if (body.appearance !== undefined) patch.appearance = str(body.appearance, 400);
  if (body.personality !== undefined) patch.personality = str(body.personality, 500);
  if (body.background !== undefined) patch.background = str(body.background, 500);
  if (body.customPrompt !== undefined) patch.customPrompt = str(body.customPrompt, 6000);
  if (body.age !== undefined) patch.age = Math.max(1, Math.min(120, Number(body.age) || 23));
  if (body.preset !== undefined) patch.preset = str(body.preset, 20);
  if (body.text !== undefined) patch.text = str(body.text, 300);
  if (body.emoji !== undefined) patch.emoji = ['关', '少', '正常', '多'].includes(body.emoji) ? body.emoji : '正常';
  if (body.historyTurns !== undefined) patch.historyTurns = Math.max(4, Math.min(400, Number(body.historyTurns) || 200));
  if (body.groupHistoryTurns !== undefined) patch.groupHistoryTurns = Math.max(2, Math.min(300, Number(body.groupHistoryTurns) || 150));
  if (body.privateMaxChars !== undefined) patch.privateMaxChars = Math.max(40, Math.min(800, Number(body.privateMaxChars) || 140));
  if (body.groupMaxChars !== undefined) patch.groupMaxChars = Math.max(20, Math.min(300, Number(body.groupMaxChars) || 70));
  for (const k of ['emotions', 'proactive', 'opinions', 'links', 'freeChat']) {
    if (body[k] !== undefined) patch[k] = Boolean(body[k]);
  }
  if (Array.isArray(body.mutedGroups)) patch.mutedGroups = body.mutedGroups.map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
  // 记住「这一版是从哪个预设载入的」，页面上能直接显示当前生效的是哪一版
  if (body.sourcePreset !== undefined) patch.sourcePreset = str(body.sourcePreset, 80);
  personaStore.save(runtime.config, patch);
  if (body.model) {
    try {
      saveSettings(runtime.config, { model: String(body.model).slice(0, 80), mock: false });
      runtime.llm.reload();
    } catch (err) {
      runtime.logger.warn('人设调教：切模型失败 ' + (err && err.message));
    }
  }
  runtime.logger.info('人设调教：已保存 ' + Object.keys(patch).join(','));
  return { ok: true, persona: personaStore.summary(runtime.config), llm: { provider: runtime.llm.provider, providerLabel: runtime.llm.providerLabel, model: runtime.llm.model, mock: runtime.llm.isMock } };
}

/** 调试台（本机自查用）：主人判定与告警见 src/master.js */

/** 最近的发言者：昵称 + 真实 senderId（主人名单照着这个填） */
function recentSenders(store, limit = 8) {
  const seen = new Map();
  if (!store || !store.sessions) return [];
  for (const [skey, sess] of store.sessions.entries()) {
    for (const m of store.messages(skey, 200) || []) {
      if (m.role !== 'user' || !m.uid) continue;
      const uid = String(m.uid);
      const ts = Number(m.ts || 0);
      const cur = seen.get(uid);
      if (cur && cur.ts >= ts) continue;
      seen.set(uid, {
        uid,
        name: String(m.name || ''),
        platform: sess.platform || '',
        chatType: sess.chatType || 'private',
        ts,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function debugState(runtime) {
  const { config, llm, gateways, store } = runtime;
  const rt = resolveRuntime(config);
  const now = new Date();
  const mood = persona.moodFor(now);
  const master = (config.persona && config.persona.master) || {};
  return {
    ok: true,
    nowLabel: `${persona.timeLabel(now)} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}`,
    mood: { name: mood.name, hint: mood.hint },
    activity: persona.activityFor(now),
    persona: {
      name: config.persona.name,
      aliases: config.persona.aliases || [],
      ownerName: config.persona.ownerName || '',
      master: {
        names: master.names || [],
        wxids: master.wxids || [],
        // 填错了（比如把微信号当 wxid）的时候，调试台直接说出来，别让人瞎猜
        warnings: masterWarnings(config),
      },
    },
    // 最近在微信里说过话的人 + 各自的真实 senderId：主人名单该填哪一串，照着抄就行
    senders: recentSenders(store),
    llm: {
      mock: llm.isMock,
      mockSetting: typeof rt.settings.mock === 'boolean' ? rt.settings.mock : null,
      provider: llm.provider,
      providerLabel: llm.providerLabel,
      model: llm.model,
      baseUrl: llm.baseUrl,
      apiKeyMasked: maskKey(rt.apiKey),
      needsKey: llm.needsKey,
      temperature: llm.temperature,
      frequencyPenalty: llm.frequencyPenalty,
      presencePenalty: llm.presencePenalty,
    },
    chat: {
      privateMaxChars: config.chat.privateMaxChars,
      groupMaxChars: config.chat.groupMaxChars,
      historyTurns: config.chat.historyTurns,
      groupHistoryTurns: config.chat.groupHistoryTurns,
      maxBubbles: config.chat.maxBubbles,
      // 「颜文字用量」档位换算出来的真实概率（面板上看起来「没生效」时看这个）
      emojiChance: persona.emojiChanceFor(config),
      emojiLevel: (config.persona && config.persona.emojiLevel) || '正常',
    },
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
      maxRepliesPerHour: config.group.maxRepliesPerHour,
    },
    links: {
      enabled: !config.links || config.links.enabled !== false,
      timeoutMs: (config.links && config.links.timeoutMs) || 6000,
    },
    personaStyle: personaStore.summary(config),
    admin: {
      configured: Boolean(config.admin && config.admin.spell),
      minutes: (config.admin && config.admin.minutes) || 30,
      spellMasked: (() => {
        const s = String((config.admin && config.admin.spell) || '');
        return s ? s.slice(0, 2) + '****' + s.slice(-2) : '';
      })(),
    },
    gateways: [...gateways.values()].map((g) => g.status()),
    memory: store.summary(),
    paths: {
      storeFile: config.paths.storeFile,
      configFile: config.paths.configFile,
      settingsFile: config.paths.settingsFile,
    },
  };
}

function debugSessions(runtime) {
  const list = [];
  for (const [key, sess] of runtime.store.sessions) {
    list.push({
      key,
      platform: sess.platform,
      chatType: sess.chatType,
      title: sess.title,
      lastActiveAt: sess.lastActiveAt,
      messageCount: runtime.store.messageCount(key),
      adminUntil: sess.state.adminUntil || 0,
      profiles: Object.values(sess.profiles).map((p) => ({ uid: p.uid, name: p.name, nickname: p.nickname, notes: p.notes || [] })),
      messages: runtime.store.messages(key, 8).map((m) => ({ role: m.role, name: m.name, text: m.text, ts: m.ts })),
    });
  }
  list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return list.slice(0, 50);
}

async function debugPrompt(runtime, body) {
  const config = runtime.config;
  const senderName = String(body.senderName || '').trim() || '朋友';
  const senderId = String(body.senderId || '').trim();
  const chatType = body.chatType === 'group' ? 'group' : 'private';
  const chatTitle = String(body.chatTitle || '').trim();
  const text = String(body.text || '');
  // 和微信里真正跑消息时用同一个判定（src/master.js），否则调试台会「说认了、实际没认」
  const masterHit = matchMaster(config, { platform: 'wechat', senderId, senderName });
  const isMaster = masterHit.isMaster;

  let linkText = '';
  if (body.readLink && text) {
    const urls = links.extractUrls(text);
    if (urls.length) {
      try {
        linkText = links.formatForPrompt(await links.describeLink(urls[0]));
      } catch {
        linkText = `对方发了一个链接（${urls[0]}），但读取失败。`;
      }
    }
  }

  const system = persona.buildSystem({
    config,
    msg: { chatType, senderName, chatTitle, isMaster, linkText },
    profile: { count: 1, notes: [] },
    notes: [],
    now: new Date(),
  });
  return {
    ok: true,
    isMaster,
    master: { isMaster, reason: masterHit.reason, warnings: masterWarnings(config) },
    system,
    linkText: Boolean(linkText),
    length: system.length,
  };
}

/**
 * 称呼迁移：老版本存在 settings.userName，新版本只认 config.json 的 persona.ownerName。
 * 启动时把旧值搬过去，避免「网页改了、调试台又看到旧值」。
 */
function migrateOwnerName(config) {
  if (!config.persona) config.persona = {};
  let fromSettings = '';
  try {
    fromSettings = String((loadSettings(config) || {}).userName || '').trim();
  } catch { /* 没设置文件就是空的 */ }
  const fromConfig = String(config.persona.ownerName || '').trim();
  if (fromSettings && (!fromConfig || fromConfig === '主人')) {
    config.persona.ownerName = fromSettings;
    try {
      const file = config.paths.configFile;
      let raw = {};
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
      } catch { raw = {}; }
      if (!raw.persona) raw.persona = {};
      raw.persona.ownerName = fromSettings;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      // 只迁移一次：搬完就把老字段清掉，否则以后把称呼改回「主人」重启又会被它盖回去
      try { saveSettings(config, { userName: '' }); } catch { /* 清不掉也没关系 */ }
    } catch { /* 写不了就只改内存，不至于启动失败 */ }
  }
  config.persona.ownerName = String(config.persona.ownerName || '').trim() || '主人';
  return config.persona.ownerName;
}

/* ------------------------------------------------------------------ */
/* 接口处理                                                            */
/* ------------------------------------------------------------------ */

async function handleChat(runtime, req, res) {
  const { bot, config, logger } = runtime;
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, err.statusCode || 400, { ok: false, error: err.message });
  }
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { ok: false, error: '说点什么呀~' });

  const mode = body.mode === 'group' ? 'group' : 'private';
  const sessionId = sanitizeId(body.sessionId || 'default');
  const chatId = `${sessionId}:${mode}`;
  const senderName =
    mode === 'group' ? String(body.senderName || '阿螈').slice(0, 20) : String(body.senderName || '你').slice(0, 20);

  const msg = {
    platform: 'web',
    chatId,
    chatType: mode,
    senderId: mode === 'group' ? `web-g-${senderName}` : `web-u-${sessionId}`,
    senderName,
    text,
    atMe: Boolean(body.atMe),
    msgId: body.msgId ? String(body.msgId).slice(0, 100) : '',
    chatTitle: mode === 'group' ? config.persona.name + '的深海鱼塘' : '',
  };

  const abort = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    abort.abort();
  });

  let decision;
  try {
    decision = await bot.decide(msg);
  } catch (err) {
    logger.error('decide 失败：' + (err && err.stack ? err.stack : err));
    return json(res, 500, { ok: false, error: '鲸鲸打了个结，稍后再试' });
  }

  // 被忽略（群聊里没被叫到）
  if (decision.action === 'ignore') {
    return json(res, 200, { ok: true, action: 'ignore', reason: decision.reason });
  }

  sseInit(res);
  sseSend(res, {
    type: 'meta',
    action: decision.action,
    mock: Boolean(decision.mock),
    reason: decision.reason,
    mode,
    senderName,
    commandType: decision.commandType || '',
  });

  // 命令 / 只被 @ 一下：直接回复固定台词
  if (decision.action === 'command' || decision.canned) {
    const full = decision.text || decision.canned || '';
    for (let i = 0; i < full.length; i += 3) {
      if (closed) return res.end();
      sseSend(res, { type: 'delta', text: full.slice(i, i + 3) });
    }
    const bubbles = bot.finalize(decision, full);
    sseSend(res, { type: 'done', text: full, bubbles, reason: decision.reason, commandType: decision.commandType || '' });
    return res.end();
  }

  let full = '';
  let failed = null;
  try {
    for await (const piece of bot.generate(decision, { signal: abort.signal })) {
      if (closed) break;
      full += piece;
      sseSend(res, { type: 'delta', text: piece });
    }
  } catch (err) {
    failed = err;
  }
  if (closed) return res.end();

  if (failed) {
    const friendly = failed instanceof LlmError ? failed.userMessage : '呜…深海线路打结了，等会儿再来找人家嘛 (｡•́︿•̀｡)';
    logger.error('生成失败：' + (failed.message || failed));
    bot.finalize(decision, friendly, { error: true });
    sseSend(res, { type: 'delta', text: full ? '\n' + friendly : friendly });
    sseSend(res, { type: 'done', text: (full + (full ? '\n' : '') + friendly).trim(), bubbles: [friendly], error: true, reason: 'llm_error' });
    return res.end();
  }

  const clean = String(full || '').trim();
  const bubbles = bot.finalize(decision, clean);
  sseSend(res, { type: 'done', text: clean, bubbles, reason: decision.reason, mock: Boolean(decision.mock) });
  res.end();
}

function handleSettingsGet(runtime, res) {
  const { config, llm } = runtime;
  const rt = resolveRuntime(config);
  const saved = loadSettings(config);
  const providers = {};
  for (const [key, p] of Object.entries(PROVIDERS)) {
    providers[key] = {
      label: p.label,
      baseUrl: p.baseUrl,
      model: p.model,
      needsKey: p.needsKey,
      hint: p.hint,
      models: p.models || [],
    };
  }
  return json(res, 200, {
    ok: true,
    mock: llm.isMock,
    provider: llm.provider,
    providerLabel: llm.providerLabel,
    needsKey: llm.needsKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    temperature: llm.temperature,
    keyMasked: maskKey(rt.apiKey),
    hasKey: Boolean(rt.apiKey),
    userName: String(saved.userName || config.persona.ownerName || ''),
    // 看图（视觉）状态：网页设置里要能看出「填没填、填的是哪把」
    vision: vision.status(config),
    providers,
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
    },
    configFile: config.paths.configFile,
    dataDir: config.paths.dataDir,
  });
}

async function applySettings(runtime, body) {
  const { config, llm } = runtime;
  const patch = {};
  const current = resolveRuntime(config);

  // 切换模型服务：没显式给地址/模型时，用该服务的预设值
  if (typeof body.provider === 'string' && body.provider.trim()) {
    const provider = body.provider.trim();
    if (!PROVIDERS[provider]) throw new Error('不认识的模型服务：' + provider);
    if (provider !== current.provider) {
      patch.provider = provider;
      const preset = PROVIDERS[provider];
      if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) patch.baseUrl = preset.baseUrl;
      if (typeof body.model !== 'string' || !body.model.trim()) patch.model = preset.model;
    }
  }

  if (typeof body.baseUrl === 'string') {
    // 少写协议（`127.0.0.1:11434/v1`）很常见：本机 / 内网地址自动补 http://，
    // 省得「明明填对了却报接口地址不合法」。
    const baseUrl = normalizeBaseUrl(body.baseUrl).slice(0, 300);
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      throw new Error('接口地址要以 http:// 或 https:// 开头（本机/内网地址可以直接写 127.0.0.1:11434/v1，会自动补 http://）');
    }
    patch.baseUrl = baseUrl;
  }
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim();
    if (key && (/\s/.test(key) || key.length < 8 || key.length > 300)) {
      throw new Error('API Key 看起来不太对：不能有空格，长度 8~300');
    }
    patch.apiKey = key;
    if (key) patch.mock = false;
  }
  if (typeof body.model === 'string' && body.model.trim()) {
    const model = body.model.trim().slice(0, 80);
    if (!/^[a-zA-Z0-9._\-\/:]{1,80}$/.test(model)) throw new Error('模型名只能包含字母、数字和 . _ - / :');
    patch.model = model;
  }
  // 看图（视觉模型）的 Key：单独一把，存在 data/settings.json 的 visionApiKey，
  // 留空表示「不改」；以前网页没有这个字段，填了也没地方存，于是永远提示未配置
  if (typeof body.visionApiKey === 'string') {
    const vk = body.visionApiKey.trim();
    if (vk && (/\s/.test(vk) || vk.length < 8 || vk.length > 300)) {
      throw new Error('看图 API Key 看起来不太对：不能有空格，长度 8~300');
    }
    if (vk) patch.visionApiKey = vk;
  }
  if (typeof body.mock === 'boolean') patch.mock = body.mock;
  // 「怎么称呼你」：以前只存在浏览器 localStorage 里，换设备就丢；现在写进 data/settings.json
  if (typeof body.userName === 'string') patch.userName = body.userName.trim().slice(0, 24);
  // 只要这次填了 Key，就默认关闭演示模式（防止「有 Key 还在说内置台词」）
  if (patch.apiKey) patch.mock = false;
  // 目标服务本来就不需要 Key（本地 Ollama / 本机 / 内网自建）时，演示模式一律关掉。
  // 网页每次都会把开关状态一起提交，而新装用户默认就是勾着的 —— 以前这里被 body.mock
  // 覆盖回 true，于是「选好本地模型、保存、测试连接」全程一次请求都没发到本地服务，
  // 还一直提示「还没拿到 API Key」（用户反馈的「本地 API 接不进去」就是这个）。
  {
    const nextProvider = patch.provider || current.provider;
    const nextBaseUrl = typeof patch.baseUrl === 'string' ? patch.baseUrl : current.baseUrl;
    const nextPreset = PROVIDERS[nextProvider] || PROVIDERS.custom;
    const keyFree = nextProvider === 'ollama' || !nextPreset.needsKey || isLocalUrl(nextBaseUrl);
    if (keyFree && /^https?:\/\//i.test(nextBaseUrl)) {
      if (patch.mock !== false) runtime.logger.info('目标服务不需要 Key（本地/内网），已自动关掉演示模式');
      patch.mock = false;
    }
  }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    patch.temperature = Math.max(0, Math.min(2, body.temperature));
  }
  if (body.group && typeof body.group === 'object') {
    if (typeof body.group.requireAt === 'boolean') config.group.requireAt = body.group.requireAt;
    if (typeof body.group.freeChat === 'boolean') config.group.freeChat = body.group.freeChat;
    if (Number.isFinite(body.group.freeChatChance)) {
      config.group.freeChatChance = Math.max(0, Math.min(1, Number(body.group.freeChatChance)));
    }
  }
  saveSettings(config, patch);
  // 称呼：网页设置和调试台改的是同一份数据，写进 config.json，重启也不会被旧值盖回来
  if (typeof body.userName === 'string') {
    // 清空 = 恢复默认称呼，不是「不改」（以前清空后依然叫旧称呼）
    const name = String(patch.userName || '').trim() || '主人';
    config.persona.ownerName = name;
    try {
      applyConfigPatch(runtime, { 'persona.ownerName': name });
      runtime.logger.info(`称呼已改为「${name}」`);
    } catch (err) {
      runtime.logger.warn('称呼写入 config.json 失败，仅本次生效：' + err.message);
    }
  }
  llm.reload();
  const mode = llm.isMock ? '演示' : `${llm.providerLabel} · ${llm.model}`;
  runtime.logger.info(`设置已更新：${mode}`);
  return {
    ok: true,
    status: statusPayload(runtime),
    settings: {
      mock: llm.isMock,
      provider: llm.provider,
      providerLabel: llm.providerLabel,
      needsKey: llm.needsKey,
      model: llm.model,
      baseUrl: llm.baseUrl,
      keyMasked: maskKey(resolveRuntime(config).apiKey),
      userName: String(loadSettings(config).userName || ''),
      // 保存后前端立刻能把「看图 Key 已存」显示出来
      vision: vision.status(config),
    },
  };
}



/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(runtime, req, res, urlPath) {
  const { config, logger } = runtime;
  const webDir = config.paths.webDir;
  const rel = urlPath === '/' ? 'index.html' : urlPath === '/debug' ? 'debug.html' : urlPath === '/persona' ? 'persona.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(webDir, rel);
  if (!filePath.startsWith(webDir)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (urlPath === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 主处理函数                                                          */
/* ------------------------------------------------------------------ */

function createHandler(runtime) {
  const { config, logger, gateways } = runtime;

  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return json(res, 400, { ok: false, error: 'bad url' });
    }
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';

    try {
      // CSRF 闸：浏览器发起的跨站写请求一律拒绝。
      // 以前没这道：任何网页都能 POST 到 127.0.0.1:8787 改设置（实测 text/plain 也能过，不需要预检）。
      const reqOrigin = String(req.headers.origin || '');
      if (reqOrigin) {
        const sameOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(reqOrigin);
        const isWrite = method !== 'GET' && method !== 'HEAD';
        if (!sameOrigin && isWrite) {
          logger.warn(`拒绝跨站请求：${method} ${pathname} Origin=${reqOrigin}`);
          return json(res, 403, { ok: false, error: '拒绝跨站请求：只允许在本机页面里操作' });
        }
        // 同源写操作也必须是 JSON：挡住「html 表单提交」这类不需要预检的请求
        if (isWrite && pathname.startsWith('/api/')) {
          const ctype = String(req.headers['content-type'] || '').toLowerCase();
          if (!ctype.includes('application/json')) {
            return json(res, 415, { ok: false, error: '写操作必须是 application/json' });
          }
        }
      }

      // 安全闸：这些接口能改配置、注入聊天、上传图片。默认只许本机；
      // 真要放到局域网（server.allowRemote=true）也必须带对的 x-bot-token，否则一律 403。
      if (pathname.startsWith('/api/') && method !== 'GET' && !isLoopbackRequest(req) && !remoteAuthorized(req, runtime)) {
        logger.warn(`拒绝远程写操作：${method} ${pathname} from ${req.socket && req.socket.remoteAddress}`);
        return json(res, 403, {
          ok: false,
          error: '远程调用被拒绝：请在运行本程序的电脑上操作，或设 server.allowRemote=true 并在请求头带 x-bot-token',
        });
      }
      if (pathname === '/healthz') return json(res, 200, { ok: true, up: true });

      // ---- 功能开关（控制台可开关；关掉就回到旧行为）----
      /* ---- 表情包（实验性）---- */
      if (pathname === '/api/stickers' || pathname.startsWith('/api/stickers/')) {
        const service = runtime.stickerService;
        service.requireEnabled(); // No file I/O, queue replay or enabled UI while off.
        const generation = service.generation;
        if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '表情包管理仅允许本机访问' });
        const bridgeOnly = ['/api/stickers/pending', '/api/stickers/claim', '/api/stickers/ack'].includes(pathname);
        if (bridgeOnly && !gateways.get('wechat')?.verifyToken(req, null)) {
          return json(res, 403, { ok: false, error: '桥接 token 不正确' });
        }
        if (pathname === '/api/stickers/status' && method === 'GET') return json(res, 200, service.status());
        if (pathname === '/api/stickers/image' && method === 'GET') {
          // 控制台缩略图：只回传表情包目录里的真图，不能读任意文件
          const q = new URL(req.url, 'http://localhost');
          const emotion = stickers.normalizeEmotion(q.searchParams.get('emotion'));
          const name = String(q.searchParams.get('name') || '');
          const dir = stickers.stickerDir(config, config.root);
          const file = stickers.resolveImage(dir, emotion, name);
          if (!file) {
            return json(res, 404, { ok: false, error: '找不到这张表情包' });
          }
          const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
          return fs.createReadStream(file).pipe(res);
        }
        if (pathname === '/api/stickers/delete' && method === 'POST') {
          // 删掉某一张表情包（只在表情包目录内，且必须是真文件）
          const body = await readBody(req);
          service.requireEnabled();
          if (generation !== service.generation) return json(res, 409, { ok: false, error: '开关已变化，请重新删除' });
          const emotion = stickers.normalizeEmotion(body && body.emotion);
          const name = String((body && body.name) || '');
          const dir = stickers.stickerDir(config, config.root);
          const file = stickers.resolveImage(dir, emotion, name);
          if (!file) {
            return json(res, 404, { ok: false, error: '找不到这张表情包（可能已经删掉了）' });
          }
          try {
            fs.unlinkSync(file);
          } catch (err) {
            return json(res, 500, { ok: false, error: '删除失败：' + (err && err.message ? err.message : err) });
          }
          logger.info(`表情包已删除：${stickers.EMOTIONS[emotion]}/${name}`);
          return json(res, 200, { ok: true, emotions: service.status().emotions });
        }
        if (pathname === '/api/stickers/open-folder' && method === 'POST') {
          // 在本机资源管理器里打开表情包目录（只打开这一个固定目录）
          const dir = stickers.stickerDir(config, config.root);
          stickers.safeDirectory(dir);
          if (process.platform === 'win32' && config.env?.WHALE_TEST_NO_SHELL !== '1') {
            // No shell expansion of a user-configured directory (%, &, etc.).
            await new Promise((resolve, reject) => {
              const child = spawn('explorer.exe', [dir], { shell: false, windowsHide: true, stdio: 'ignore' });
              child.once('spawn', resolve); child.once('error', reject);
            });
          }
          return json(res, 200, { ok: true, dir });
        }
        if (pathname === '/api/stickers/upload' && method === 'POST') {
          const body = await readBody(req, 29 * 1024 * 1024);
          service.requireEnabled(); // Toggle may have changed while a large upload was in flight.
          if (generation !== service.generation) return json(res, 409, { ok: false, error: '开关已变化，请重新上传' });
          const uploaded = stickers.upload(config, config.root, body.emotion, body.files);
          return json(res, 200, { ok: true, uploaded });
        }
        if (pathname === '/api/stickers/test' && method === 'POST') {
          const body = await readBody(req);
          service.requireEnabled();
          if (generation !== service.generation) return json(res, 409, { ok: false, error: '开关已变化，请重新排队' });
          const queued = service.enqueue(body.emotion || 'other', body.chat ?? config.sticker?.testChat ?? '文件传输助手');
          return json(res, 200, { ok: true, queued });
        }
        if (pathname === '/api/stickers/pending' && method === 'GET') return json(res, 200, { ok: true, items: service.pending() });
        if (pathname === '/api/stickers/claim' && method === 'POST') {
          const body = await readBody(req);
          return json(res, 200, { ok: true, item: service.claim(body.id) });
        }
        if (pathname === '/api/stickers/ack' && method === 'POST') {
          const body = await readBody(req);
          return json(res, 200, { ok: true, item: service.ack(body.id, body.status, body.error) });
        }
        return json(res, 404, { ok: false, error: 'not found' });
      }

      if (pathname === '/api/features' && method === 'GET') {
        return json(res, 200, { ok: true, features: features.list(runtime.config) });
      }
      if (pathname === '/api/features' && method === 'POST') {
        const body = await readBody(req);
        const key = String((body && body.key) || '').trim();
        const entry = features.REGISTRY.find((f) => f.key === key);
        if (!entry) return json(res, 400, { ok: false, error: '没有这个开关：' + key });
        const on = features.toBool(body.value, false);
        try {
          applyConfigPatch(runtime, { [entry.path]: on });
          logger.info(`功能开关 ${entry.label} → ${on ? '开' : '关'}`);
          return json(res, 200, { ok: true, key, value: on, features: features.list(runtime.config) });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }

      // ---- 记忆备份 / 恢复 ----
      if (pathname === '/api/memory/info' && method === 'GET') {
        const bundle = memoryBackup.collect(runtime.config.root);
        const backups = memoryBackup.listBackups(runtime.config.root);
        return json(res, 200, {
          ok: true,
          current: memoryBackup.summarize(bundle),
          backups: backups.map((b) => ({ name: b.name, mtime: b.mtime, ...{ sessions: b.sessions, messages: b.messages, notes: b.notes } })),
          dir: memoryBackup.backupDir(runtime.config.root),
        });
      }

      if (pathname === '/api/memory/export' && method === 'GET') {
        // 先把内存里的记忆落盘，再打包下载
        try { runtime.store.flush(); } catch { /* ignore */ }
        // 默认脱敏：导出文件经常被发人 / 传 U 盘，不能把 Key 一起带出去
        const includeSecrets = /(?:^|[?&])secrets=1(?:&|$)/.test(String(req.url || ''));
        const bundle = memoryBackup.collect(runtime.config.root, { withSecrets: includeSecrets });
        const name = 'whale-memory-' + new Date().toISOString().slice(0, 10) + '.json';
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(bundle, null, 2));
        return true;
      }

      if (pathname === '/api/memory/backup' && method === 'POST') {
        try { runtime.store.flush(); } catch { /* ignore */ }
        const file = memoryBackup.writeSnapshot(runtime.config.root, 'manual');
        if (!file) return json(res, 200, { ok: true, file: '', message: '还没有记忆，不用备份' });
        logger.info('手动记忆快照：' + file);
        return json(res, 200, { ok: true, file });
      }

      if (pathname === '/api/memory/restore' && method === 'POST') {
        const body = await readBody(req);
        try {
          let info;
          if (body && body.bundle) {
            info = memoryBackup.restoreFrom(runtime.config.root, body.bundle);
          } else if (body && body.name) {
            const safeName = path.basename(String(body.name)); // 防 ../ 穿越：只认备份目录里的文件名
            const target = path.join(memoryBackup.backupDir(runtime.config.root), safeName);
            if (!fs.existsSync(target)) {
              return json(res, 400, { ok: false, error: '找不到这个快照：' + safeName });
            }
            info = memoryBackup.restoreFromFile(runtime.config.root, target);
          } else {
            return json(res, 400, { ok: false, error: '要带 name（快照文件名）或 bundle（导出的内容）' });
          }
          // 让内存里的记忆立刻跟上文件，不然下一次写盘会把恢复的内容盖回去
          let reloaded = 0;
          try { reloaded = runtime.store.reloadFromDisk(); } catch (err) { logger.warn('恢复后重载记忆失败：' + err.message); }
          logger.info('记忆已恢复：' + info.restored.join('、') + `（重载 ${reloaded} 个会话）`);
          return json(res, 200, { ok: true, restored: info.restored, current: { sessions: info.sessions, messages: info.messages, notes: info.notes }, needRestart: false });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }

      if (pathname === '/api/status' && method === 'GET') {
        return json(res, 200, statusPayload(runtime));
      }

      if (pathname === '/api/settings') {
        if (method === 'GET') return handleSettingsGet(runtime, res);
        if (method === 'POST') {
          const body = await readBody(req);
          try {
            const data = await applySettings(runtime, body);
            return json(res, 200, data);
          } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
          }
        }
        return json(res, 405, { ok: false, error: 'method not allowed' });
      }

      if (pathname === '/api/settings/test' && method === 'POST') {
        const body = await readBody(req);
        if (body && Object.keys(body).length) {
          try {
            await applySettings(runtime, body);
          } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
          }
        }
        const probe = await runtime.llm.probe();
        return json(res, 200, { ok: probe.ok, probe });
      }

      // 「测试看图」：拿内置的 64x64 PNG 试一下 Key 通不通。
      // body.apiKey 可选 —— 网页里可以先测再保存。
      if (pathname === '/api/memory/consolidate/status' && method === 'GET') {
        const j = runtime._consolidateJob || { running: false };
        return json(res, 200, { ok: true, job: j });
      }
      if (pathname === '/api/memory/consolidate' && method === 'POST') {
        const j = runtime._consolidateJob || (runtime._consolidateJob = { running: false });
        if (j.running) return json(res, 200, { ok: true, running: true, startedAt: j.startedAt });
        j.running = true;
        j.startedAt = Date.now();
        j.finishedAt = 0;
        j.result = null;
        j.error = null;
        require('./src/memoryConsolidate').runOnce(runtime)
          .then((r) => {
            j.result = r;
            j.running = false;
            j.finishedAt = Date.now();
            runtime.logger.info('[记忆巩固] 后台完成：机械 ' + r.merged + ' / 模型 ' + r.modelMerged + ' / 清理 ' + r.pruned);
          })
          .catch((e) => {
            j.error = String((e && e.message) || e);
            j.running = false;
            j.finishedAt = Date.now();
            runtime.logger.warn('[记忆巩固] 后台失败：' + j.error);
          });
        return json(res, 202, { ok: true, started: true, startedAt: j.startedAt });
      }
      if (pathname === '/api/digest/run' && method === 'POST') {
        try {
          const items = await runDigestPass(runtime, { force: true });
          return json(res, 200, { ok: true, items });
        } catch (err) {
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/vision/test' && method === 'POST') {
        let vbody = {};
        try { vbody = await readBody(req); } catch { vbody = {}; }
        const override = vbody && typeof vbody.apiKey === 'string' ? vbody.apiKey.trim() : '';
        const cfg = override
          ? { ...runtime.config, vision: { ...(runtime.config.vision || {}), apiKey: override } }
          : runtime.config;
        try {
          const text = await vision.describe(cfg, {
            imageBase64: vision.TEST_IMAGE,
            mime: 'image/png',
            prompt: '这张图是什么颜色？只回答颜色。',
          });
          return json(res, 200, { ok: true, sample: String(text || '').slice(0, 60), vision: vision.status(runtime.config) });
        } catch (err) {
          return json(res, 500, { ok: false, error: String((err && err.message) || err), vision: vision.status(runtime.config) });
        }
      }

      if (pathname === '/api/vision' && method === 'POST') {
        try {
          const body = await readBody(req);
          const text = await vision.describe(runtime.config, {
            imageBase64: body && body.image,
            mime: (body && body.mime) || 'image/jpeg',
            prompt: (body && body.prompt) || '',
            // 参照图：桥接问"这是不是你"时，会把她自己的图一起发上来做对比
            extraImages: Array.isArray(body && body.extra) ? body.extra.slice(0, 3) : [],
          });
          // 顺手收图当表情包素材（开关 features.stickers / sticker.collect）
          try {
            collectStickerImage(runtime.config, body && body.image, body && body.mime, text);
          } catch (_) { /* 收图失败不影响识图 */ }
          return json(res, 200, { ok: true, text });
        } catch (err) {
          runtime.logger.warn('图片识别失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/share' && method === 'GET') {
        try {
          const share = await shareForChat(runtime, url.searchParams.get('chat') || '');
          return json(res, 200, share);
        } catch (err) {
          runtime.logger.warn('挑视频失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }


      if (pathname === '/api/persona' && method === 'GET') {
        return json(res, 200, { ok: true, persona: personaStore.summary(runtime.config), llm: { provider: runtime.llm.provider, providerLabel: runtime.llm.providerLabel, model: runtime.llm.model, mock: runtime.llm.isMock } });
      }
      if (pathname === '/api/persona' && method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, applyPersonaPatch(runtime, body));
      }
      // 人设预设：personas/ 下每个版本一个文件
      if (pathname === '/api/persona/presets' && method === 'GET') {
        return json(res, 200, { ok: true, presets: presets.list(runtime.config) });
      }
      if (pathname === '/api/persona/preset' && method === 'GET') {
        // 预览：只回内容，不写入 —— 页面选到哪版就先把那版填进下面的输入框，
        // 用户看一眼再点保存，不用先点「导入」。
        const q = new URL(req.url, 'http://localhost');
        const preset = presets.load(runtime.config, q.searchParams.get('id'));
        if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
        const patch = presets.toPatch(preset);
        if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
        return json(res, 200, {
          ok: true,
          preset: { id: preset.id, version: preset.version || '', name: preset.name || '', description: preset.description || '' },
          patch,
        });
      }
      if (pathname === '/api/persona/preset' && method === 'POST') {
        const body = await readBody(req);
        const preset = presets.load(runtime.config, body && body.id);
        if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
        const patch = presets.toPatch(preset);
        if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
        // 记下来源，页面上能直接看到「现在用的是哪一版」
        patch.sourcePreset = preset.id;
        personaStore.save(runtime.config, patch);
        runtime.logger.info(`人设预设：已导入 ${preset.id}（${preset.version || '无版本号'}）`);
        return json(res, 200, {
          ok: true,
          applied: { id: preset.id, version: preset.version || '', name: preset.name || '' },
          persona: personaStore.summary(runtime.config),
        });
      }

      // ---- 微信多账号：列账号 / 刷新昵称 / 选账号 ----
      // 网页「设置 → 微信账号」用这三条。选账号 = 把 config.json 的 wechat.account
      // 改成目标账号目录；桥接发现这个值变了会自己 exit 7 让 bridge_loop 拉起来。
      if (pathname === '/api/wechat/accounts' && method === 'GET') {
        return json(res, 200, wechatAccountsPayload(runtime));
      }
      if (pathname === '/api/wechat/accounts/refresh' && method === 'POST') {
        const out = await refreshWechatAccounts(runtime);
        const payload = wechatAccountsPayload(runtime);
        if (!out.ok) return json(res, 200, { ...payload, refreshed: false, error: out.error || '扫描失败' });
        return json(res, 200, { ...payload, refreshed: true });
      }
      if (pathname === '/api/wechat/account' && method === 'POST') {
        const body = await readBody(req);
        const wanted = String((body && body.account) || '').trim();
        const snapshot = wechatAccountsPayload(runtime);
        if (wanted && !matchAccountDir(snapshot.accounts, wanted)) {
          const list = snapshot.accounts.map((a) => a.account).join('、') || '（一个都没扫到）';
          return json(res, 400, { ok: false, error: `本机没有账号 ${wanted}。现有：${list}` });
        }
        const out = applyConfigPatch(runtime, { 'wechat.account': wanted });
        runtime.logger.info(`微信账号已设为 ${wanted || '自动（按最近活跃选）'}（桥接会在几秒内自动重启）`);
        return json(res, 200, {
          ...wechatAccountsPayload(runtime),
          changed: out.changed,
          needBridgeRestart: true,
        });
      }

      if (pathname === '/api/config') {
        if (method === 'GET') {
          const pub = publicConfig(runtime.config);
          return json(res, 200, {
            ok: true,
            config: pub.config,
            secrets: pub.secrets,
            configFile: runtime.config.paths.configFile,
            settingsFile: runtime.config.paths.settingsFile,
          });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          try {
            const out = applyConfigPatch(runtime, body && body.patch);
            const pub = publicConfig(runtime.config);
            return json(res, 200, {
              ok: true,
              changed: out.changed,
              clearedSettings: out.cleared,
              config: pub.config,
              secrets: pub.secrets,
              status: statusPayload(runtime),
            });
          } catch (err) {
            return json(res, 400, { ok: false, error: String((err && err.message) || err) });
          }
        }
        return json(res, 405, { ok: false, error: 'method not allowed' });
      }

      if (pathname === '/api/debug/state' && method === 'GET') {
        return json(res, 200, debugState(runtime));
      }
      if (pathname === '/api/debug/sessions' && method === 'GET') {
        return json(res, 200, { ok: true, sessions: debugSessions(runtime) });
      }
      if (pathname === '/api/debug/prompt' && method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, await debugPrompt(runtime, body));
      }
      if (pathname === '/api/debug/reset' && method === 'POST') {
        const body = await readBody(req);
        if (!body.key) return json(res, 400, { ok: false, error: '缺少 key' });
        runtime.store.resetSession(String(body.key));
        runtime.logger.info('调试台清空了会话记忆：' + String(body.key));
        return json(res, 200, { ok: true });
      }

      // DSH agent 的回复入口：入现有 outbox，由桥接发出
      if (pathname === '/api/core/send' && method === 'POST') {
        const body = await readBody(req);
        const expect = String(((runtime.config.gateway || {}).wechat || {}).inboundToken || '');
        const got = String(req.headers['x-bot-token'] || '');
        if (expect && got !== expect) return json(res, 401, { ok: false, error: 'bad token' });
        const bubbles = Array.isArray(body.bubbles) ? body.bubbles.map(String) : [String(body.text || '')];
        const list = bubbles.map((t) => t.trim()).filter(Boolean);
        if (!body.chatId || !list.length) return json(res, 400, { ok: false, error: 'chatId/bubbles required' });
        for (const text of list) {
          outbox.enqueue({ chatId: String(body.chatId), chatType: body.chatType === 'group' ? 'group' : 'private', kind: 'text', text });
        }
        return json(res, 200, { ok: true, count: list.length });
      }
      // 下行队列：桥接轮询取件（主动播报 / 任务完成通知 / 文件）
      if (pathname === '/api/bridge/outbox' && method === 'GET') {
        return json(res, 200, { ok: true, items: outbox.take(10) });
      }
      if (pathname === '/api/bridge/outbox/ack' && method === 'POST') {
        const body = await readBody(req);
        const removed = outbox.ack(body.ids, body.ok !== false);
        return json(res, 200, { ok: true, removed });
      }

      // 主动搭话：桥接定时来问「现在该不该发」（时间窗 / 频率 / 每日上限都在 src/care.js 里算）
      if (pathname === '/api/care/due' && method === 'GET') {
        const cq = new URL(req.url, 'http://localhost');
        const last = Number(cq.searchParams.get('last') || 0);
        const sentToday = Number(cq.searchParams.get('sentToday') || 0);
        const out = care.careDue(runtime.config, {
          lastSentTs: Number.isFinite(last) && last > 0 ? last : 0,
          sentToday: Number.isFinite(sentToday) ? sentToday : 0,
        });
        // 主动搭话的收件人规则（默认只找主人）：
        //   群里一律不发（除非 care.allowGroups）；非主人的私聊也不发（除非 care.allowOthers）
        const careCfg = runtime.config.care || {};
        const allowGroups = features.toBool(careCfg.allowGroups, false);
        const allowOthers = features.toBool(careCfg.allowOthers, false);
        const onlyMaster = features.toBool(careCfg.onlyMaster, true);
        const chatHint = String(cq.searchParams.get('chat') || '');
        // 只有调用方明确传了 chat（声明要发给谁）才在这里拦；
        // 现役桥接不传 chat，收件人规则由桥接自己挑目标时保证（默认只挑主人）。
        if (out.due && chatHint && !allowGroups && /@chatroom$/i.test(chatHint)) {
          return json(res, 200, { ok: true, due: false, reason: 'group_not_allowed' });
        }
        if (out.due && chatHint && onlyMaster && !allowOthers) {
          const masters = ((runtime.config.persona || {}).master || {}).wxids || [];
          const isMasterChat = masters.some((m) => m && String(m).trim() && String(m).trim() === chatHint);
          if (!isMasterChat) {
            return json(res, 200, { ok: true, due: false, reason: 'only_master' });
          }
        }
        return json(res, 200, { ok: true, ...out });
      }

      // 主动搭话：生成那句关心的话（带最近聊天上下文，避免每次同一句）
      if (pathname === '/api/care' && method === 'GET') {
        try {
          const cq = new URL(req.url, 'http://localhost');
          const out = await careForChat(runtime, cq.searchParams.get('chat') || '');
          return json(res, 200, out);
        } catch (err) {
          runtime.logger.warn('生成搭话失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/chat' && method === 'POST') {
        return await handleChat(runtime, req, res);
      }

      if (pathname === '/api/reset' && method === 'POST') {
        const body = await readBody(req);
        const sessionId = sanitizeId(body.sessionId || 'default');
        if (body.all) {
          runtime.store.resetAll();
        } else {
          const mode = body.mode === 'group' ? 'group' : 'private';
          runtime.store.resetSession(`web:${mode === 'group' ? 'g' : 'u'}:${sessionId}:${mode}`);
        }
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/memory' && method === 'GET') {
        const sessionId = sanitizeId(url.searchParams.get('sessionId') || 'default');
        const mode = url.searchParams.get('mode') === 'group' ? 'group' : 'private';
        const key = `web:${mode === 'group' ? 'g' : 'u'}:${sessionId}:${mode}`;
        const sessions = {
          private: runtime.store.listNotes(`web:u:${sessionId}:private`),
          group: runtime.store.listNotes(`web:g:${sessionId}:group`),
        };
        return json(res, 200, { ok: true, key, notes: sessions[mode], all: sessions, summary: storeSummary(runtime) });
      }

      if (pathname === '/api/vision' && method === 'POST') {
        try {
          const body = await readBody(req);
          const text = await vision.describe(runtime.config, {
            imageBase64: body && body.image,
            mime: (body && body.mime) || 'image/jpeg',
            prompt: (body && body.prompt) || '',
          });
          // 顺手收图当表情包素材（开关 features.stickers / sticker.collect）
          try {
            collectStickerImage(runtime.config, body && body.image, body && body.mime, text);
          } catch (_) { /* 收图失败不影响识图 */ }
          return json(res, 200, { ok: true, text });
        } catch (err) {
          runtime.logger.warn('图片识别失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/share' && method === 'GET') {
        try {
          const share = await shareForChat(runtime, url.searchParams.get('chat') || '');
          return json(res, 200, share);
        } catch (err) {
          runtime.logger.warn('挑视频失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }


      if (pathname === '/api/persona' && method === 'GET') {
        return json(res, 200, {
          ok: true,
          name: config.persona.name,
          aliases: config.persona.aliases,
          moods: persona.MOODS.map((m) => m.name),
          greeting: '在，咋啦？今天想聊点啥',
        });
      }

      // 桥接心跳：让网页知道「桥接在不在、UIA 通不通」。没这个，服务端只能看到
      // 「我收到了消息」，根本不知道回复有没有可能发出去。
      if (pathname === '/api/bridge/heartbeat' && method === 'POST') {
        const hb = await readBody(req);
        const platform = String((hb && hb.platform) || 'wechat').toLowerCase();
        const gw = gateways.get(platform);
        if (!gw) return json(res, 404, { ok: false, error: `未知平台 ${platform}` });
        if (!gw.verifyToken(req, hb)) return json(res, 403, { ok: false, error: 'token 不对' });
        return json(res, 200, gw.heartbeat(hb));
      }

      const webhookMatch = pathname.match(/^\/webhook\/([a-zA-Z]+)$/);
      if (webhookMatch) {
        const platform = webhookMatch[1].toLowerCase();
        const gateway = gateways.get(platform);
        if (!gateway) return json(res, 404, { ok: false, error: `未知平台 ${platform}` });
        if (method === 'GET') {
          if (!gateway.verifyToken(req, null)) return json(res, 403, { ok: false, error: 'token 不对' });
          const challenge = url.searchParams.get('challenge') || url.searchParams.get('echostr');
          if (challenge) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(challenge);
          }
          return json(res, 200, gateway.status());
        }
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
        const body = await readBody(req);
        if (!gateway.verifyToken(req, body)) {
          logger.warn(`[${platform}] webhook token 校验失败`);
          return json(res, 403, { ok: false, error: 'token 不对' });
        }
        if (!gateway.options.enabled) {
          return json(res, 200, { ok: true, skipped: 'adapter_disabled' });
        }
        // 本地桥接会带 x-whale-bridge: 1（或 body.local=true）。它靠 HTTP 响应拿回复，
        // 所以「没配 outboundUrl」对它是正常的，不该按「发不出去」报警。
        const isLocalBridge = String(req.headers['x-whale-bridge'] || '') === '1' || Boolean(body && body.local);
        const result = await gateway.handleInbound(body, { local: isLocalBridge });
        return json(res, 200, result);
      }

      if (method === 'GET' || method === 'HEAD') return serveStatic(runtime, req, res, pathname);
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      const status = err.statusCode || 500;
      // A disabled experimental route / rejected test is expected, not a crashing service.
      if (!(pathname.startsWith('/api/stickers') && status < 500)) {
        logger.error(`${method} ${pathname} 出错：` + (err && err.stack ? err.stack : err));
      }
      if (status === 500) return json(res, 500, { ok: false, error: '服务器打了个结，请看控制台日志' });
      return json(res, status, { ok: false, error: err.message });
    }
  };
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

function openBrowser(url, logger) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err && logger) logger.warn('没能自动打开浏览器，请手动访问：' + url);
  });
}

async function startServer({ root = projectRoot(), env = process.env, port, host, openBrowser: shouldOpen } = {}) {
  const runtime = createRuntime({ root, env });
  const { config, logger } = runtime;
  const handler = createHandler(runtime);
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      logger.error('未捕获错误：' + (err && err.stack ? err.stack : err));
      try { json(res, 500, { ok: false, error: 'internal error' }); } catch { /* ignore */ }
    });
  });
  server.keepAliveTimeout = 5000;

  // 注意：port = 0 是「让系统分配随机端口」，不能被 || 吞掉
  const requestedPort = port !== undefined && port !== null ? Number(port) : Number(config.server.port);
  const listenPort = Number.isFinite(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 8787;
  let listenHost = host || config.server.host || '127.0.0.1';
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopback.has(String(listenHost).toLowerCase()) && !(config.server && config.server.allowRemote)) {
    logger.warn(
      `server.host=${listenHost} 会把控制台暴露给局域网/公网，已强制改回 127.0.0.1。` +
        '确实要远程访问：在 config.json 设 server.allowRemote=true，并把 gateway.wechat.inboundToken 改成随机串。'
    );
    listenHost = '127.0.0.1';
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolve);
  });
  const actualPort = server.address().port;
  // 把实际端口写盘：桥接优先读这个文件，避免「手动 --port=8788 后桥接还连 8787」满屏积极拒绝
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'server-port.txt'), String(actualPort), 'utf8');
  } catch (err) {
    logger.warn('写 server-port.txt 失败（不影响服务）：' + err.message);
  }

  const url = `http://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${actualPort}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // SSE / keep-alive 连接会让 server.close() 一直等，先强制断开空闲连接
    try { if (server.closeIdleConnections) server.closeIdleConnections(); } catch { /* ignore */ }
    setTimeout(() => {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch { /* ignore */ }
    }, 300).unref?.();
    await new Promise((resolve) => server.close(resolve));
    runtime.store.close();
    logger.close();
  };
  server.on('close', () => {
    runtime.store.close();
  });

  const open = shouldOpen === undefined ? Boolean(config.server.openBrowser) : shouldOpen;
  if (open) setTimeout(() => openBrowser(url, logger), 400);

  return { server, runtime, port: actualPort, host: listenHost, url, close };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function replyChannelLabel(config) {
  const g = (config.gateway && config.gateway.wechat) || {};
  if (g.outboundUrl) return `中转网关 ${g.outboundUrl}`;
  return '本地桥接（要另开一个「启动微信桥接.bat」窗口，回复才发得出去）';
}

function printBanner(runtime, url) {
  const { llm, config } = runtime;
  const lines = [
    '',
    '  🐋  鲸鲸 · 深海聊天机器人  ',
    `  版本：       v${runtime.version}`,
    '  ────────────────────────────────────────────',
    `  网页聊天：   ${url}`,
    `  运行模式：   ${llm.isMock ? '演示模式（还没配置模型，用内置台词）' : `${llm.providerLabel} · ${llm.model}`}`,
    `  模型服务：   ${llm.providerLabel}${llm.needsKey ? (llm.apiKey ? '（Key 已配置）' : '（未填 Key）') : '（本地/免 Key）'}`,
    `  记忆文件：   ${config.paths.storeFile}`,
    `  回复发送：   ${replyChannelLabel(config)}`,
    `  接入微信：   POST ${url}/webhook/wechat   （见 docs/接入微信.md）`,
    `  接入抖音：   POST ${url}/webhook/douyin   （见 docs/接入抖音.md）`,
    '  ────────────────────────────────────────────',
    '  按 Ctrl+C 停止',
    '',
  ];
  console.log(lines.join('\n'));
}

function runDoctor() {
  const root = projectRoot();
  ensureConfigFile(root);
  const config = loadConfig({ root });
  const rt = resolveRuntime(config);
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push('Node 版本', parseInt(process.version.slice(1), 10) >= 18, process.version);
  push('web 目录', fs.existsSync(path.join(root, 'web', 'index.html')), path.join(root, 'web', 'index.html'));
  push('config.json', fs.existsSync(config.paths.configFile), config.paths.configFile);
  push(
    '模型服务',
    !rt.mock || !rt.needsKey,
    `${rt.providerLabel} · ${rt.model}${rt.needsKey ? (rt.apiKey ? '（Key 已配置）' : '（未填 Key → 演示模式，可在设置里换免费模型）') : '（本地/免 Key，不需要 Key）'}`
  );
  push('API Key', Boolean(rt.apiKey) || !rt.needsKey, rt.apiKey ? maskKey(rt.apiKey) + '（来自设置/配置/环境变量）' : rt.needsKey ? '未配置' : '不需要');
  try {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    const probe = path.join(config.paths.dataDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    push('数据目录可写', true, config.paths.dataDir);
  } catch (err) {
    push('数据目录可写', false, err.message);
  }
  push('端口可用', true, `${config.server.host}:${config.server.port}（启动时会再确认）`);
  for (const [platform, gw] of Object.entries(config.gateway || {})) {
    push(
      `${platform} 网关`,
      Boolean(gw && gw.enabled),
      gw && gw.enabled ? (gw.outboundUrl ? `outbound: ${gw.outboundUrl}` : '已启用，但未配置 outboundUrl（只打印不发送）') : '未启用（可在 config.json 里开启）'
    );
  }
  console.log('\n🐋 鲸鲸 · 环境自检\n');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '⚠️ '} ${c.name.padEnd(12, ' ')} ${c.detail}`);
  console.log('\n提示：没有 Key 也能启动——网页里可以选免费的智谱 GLM-4-Flash，或本地 Ollama，全程不花钱。\n');
  return checks.every((c) => c.ok);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--doctor') || args.includes('doctor')) {
    runDoctor();
    process.exit(0);
  }
  if (args.includes('--debug-info')) {
    const rt = createRuntime({});
    console.log(JSON.stringify({ state: debugState(rt), sessions: debugSessions(rt) }, null, 2));
    rt.store.close();
    process.exit(0);
  }
  const portArg = args.find((a) => /^--port=\d+$/.test(a));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;
  const noBrowser = args.includes('--no-browser');

  let instance;
  try {
    instance = await startServer({ port, openBrowser: noBrowser ? false : undefined });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口被占用了（${err.port || '默认端口'}）。换个端口：node server.js --port=8788\n`);
    } else {
      console.error('\n❌ 启动失败：', err && err.stack ? err.stack : err, '\n');
    }
    process.exit(1);
  }
  printBanner(instance.runtime, instance.url);
  instance.runtime.logger.info(`服务已启动 ${instance.url}，模式=${instance.runtime.llm.isMock ? '演示' : '真实 API'}`);

  const shutdown = async () => {
    console.log('\n🌊 鲸鲸要潜回深海了…');
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { startServer, createRuntime, createHandler, statusPayload, applySettings, VERSION };
