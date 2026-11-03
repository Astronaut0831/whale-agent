'use strict';

/**
 * 后台 agent 桥：把复杂任务交给 `dsh headless` 跑，产物放 out/，完成后经 outbox 发回。
 *
 * 安全约束：
 * - 默认关闭（data/agent-enabled.json 不存在 = 关闭），只有主人能开；
 * - 非主人派活要先挂起，私聊主人批准（/agent ok <id>）才执行；
 * - 每个任务独立工作目录 data/agent-runs/<id>/，产物只收 out/ 下的文件；
 * - 并发上限 2，单任务 10 分钟超时。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const outbox = require('./outbox');

let DATA_DIR = path.join(__dirname, '..', 'data');
let RUNS_DIR = path.join(DATA_DIR, 'agent-runs');
let FLAG = path.join(DATA_DIR, 'agent-enabled.json');
let PENDING = path.join(DATA_DIR, 'agent-pending.json');

const MAX_CONCURRENT = 2;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const APPROVE_TTL_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

const queue = [];
let running = 0;

function setDataDir(dir) {
  if (!dir) return;
  DATA_DIR = String(dir);
  RUNS_DIR = path.join(DATA_DIR, 'agent-runs');
  FLAG = path.join(DATA_DIR, 'agent-enabled.json');
  PENDING = path.join(DATA_DIR, 'agent-pending.json');
}

function isEnabled() {
  try {
    return JSON.parse(fs.readFileSync(FLAG, 'utf8')).enabled === true;
  } catch {
    return false;
  }
}

function setEnabled(on) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FLAG, JSON.stringify({ enabled: Boolean(on), at: Date.now() }), 'utf8');
  return Boolean(on);
}

function status() {
  return { enabled: isEnabled(), running, queued: queue.length, pending: loadPending().length };
}

function loadPending() {
  try {
    const d = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
    return Array.isArray(d.items) ? d.items : [];
  } catch {
    return [];
  }
}

function savePending(items) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PENDING, JSON.stringify({ items }, null, 1), 'utf8');
  } catch { /* ignore */ }
}

function masterChatId() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    const wxids = (((c.persona || {}).master || {}).wxids) || [];
    return String(wxids[0] || '');
  } catch {
    return '';
  }
}

function logLine(msg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'agent-jobs.log'), `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不影响任务 */ }
}

function dshBin() {
  const appdata = process.env.APPDATA || 'C:\\Users\\astronaut\\AppData\\Roaming';
  const p = path.join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return fs.existsSync(p) ? p : '';
}

function apiKey() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return String((c.deepseek || {}).apiKey || '');
  } catch {
    return '';
  }
}

function walkFiles(dir, acc = []) {
  let rows = [];
  try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const r of rows) {
    const p = path.join(dir, r.name);
    if (r.isDirectory()) walkFiles(p, acc);
    else if (r.isFile()) acc.push(p);
  }
  return acc;
}

function start({ task, chatId, chatType = 'private', senderName = '' } = {}) {
  const text = String(task || '').trim();
  if (!text) return { ok: false, msg: '任务内容是空的。' };
  if (!chatId) return { ok: false, msg: '缺少会话。' };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  queue.push({ id, task: text, chatId, chatType, senderName, at: Date.now() });
  logLine(`排队 ${id} ← ${senderName || chatId}：${text.slice(0, 60)}`);
  pump();
  return { ok: true, id, queued: queue.length, running };
}

/**
 * 派活入口：主人直接跑；其他人挂起等主人批准。
 */
function request({ task, chatId, chatType = 'private', senderName = '', isMaster = false } = {}) {
  if (!isEnabled()) return { ok: false, msg: '后台 agent 现在是关闭的（只有主人能开）。' };
  const text = String(task || '').trim().slice(0, 2000);
  if (!text) return { ok: false, msg: '任务内容是空的。' };
  if (!chatId) return { ok: false, msg: '缺少会话。' };
  if (isMaster) return start({ task: text, chatId, chatType, senderName });

  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const items = loadPending().filter((x) => Date.now() - Number(x.at || 0) < APPROVE_TTL_MS);
  items.push({ id, task: text, chatId, chatType, senderName: String(senderName || '').slice(0, 40), at: Date.now() });
  savePending(items);
  logLine(`待批准 ${id} ← ${senderName || chatId}：${text.slice(0, 50)}`);

  const master = masterChatId();
  if (master) {
    outbox.enqueue({
      chatId: master,
      chatType: 'private',
      kind: 'text',
      text: `【待批准】${senderName || chatId} 想派任务：\n${text.slice(0, 300)}\n\n回复 /agent ok ${id} 执行，或 /agent no ${id} 拒绝（15 分钟内有效）`,
      meta: { agentPending: id },
    });
  } else {
    logLine('没有配置主人 wxid，审批消息发不出去');
  }
  return { ok: true, pending: true, id };
}

function approve(id, on) {
  const key = String(id || '').trim();
  const items = loadPending();
  const idx = items.findIndex((x) => x.id === key);
  if (idx < 0) return '没找到这个待批准任务（可能已过期）。';
  const item = items[idx];
  items.splice(idx, 1);
  savePending(items);
  if (!on) {
    logLine(`拒绝 ${item.id} ← ${item.senderName || item.chatId}`);
    return '已拒绝：' + item.task.slice(0, 40);
  }
  if (Date.now() - Number(item.at || 0) > APPROVE_TTL_MS) return '这个请求已经过期了，让对方重新派一次。';
  const r = start({ task: item.task, chatId: item.chatId, chatType: item.chatType, senderName: item.senderName });
  logLine(`批准 ${item.id} → ${r.ok ? '已排队 ' + r.id : '失败'}`);
  return r.ok ? '已批准，开始跑了（' + r.id + '）。' : '批准失败：' + r.msg;
}

function pendingText() {
  const items = loadPending().filter((x) => Date.now() - Number(x.at || 0) < APPROVE_TTL_MS);
  if (!items.length) return '没有待批准的任务。';
  return '待批准：\n' + items.map((x) => `${x.id} ← ${x.senderName || x.chatId}：${x.task.slice(0, 40)}`).join('\n');
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running += 1;
    run(job).catch((e) => logLine(`任务 ${job.id} 异常：${e && e.message}`)).finally(() => {
      running -= 1;
      pump();
    });
  }
}

function run(job) {
  return new Promise((resolve) => {
    const dir = path.join(RUNS_DIR, job.id);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    const bin = dshBin();
    if (!bin) {
      finish(job, '后台 agent 没找到（dsh 未安装）。', dir, outDir);
      return resolve();
    }

    const prompt = [
      '你是鲸鲸的后台执行代理，负责把任务做成可交付的产物。',
      `工作目录：${dir}`,
      `任务：${job.task}`,
      '要求：',
      '1. 所有交付物（文件、图片、PPT、图表等）保存到 ./out/ 目录下；',
      '2. 不要反问，直接做；信息不足就按合理默认处理，并在总结里说明假设；',
      '3. 不要停止/重启 whale_gril 的服务（server.js / 桥接 / embed），不要运行 start-all.ps1 或 stop-all.ps1，除非任务明确要求；',
      '4. 最后用两三句话总结：做了什么、产物文件名列表。',
    ].join('\n');

    const child = spawn(process.execPath, [bin, 'headless', prompt], {
      cwd: dir,
      env: { ...process.env, DEEPSEEK_API_KEY: apiKey() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      err += '\n（超时 10 分钟，已终止）';
    }, JOB_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const files = walkFiles(outDir).filter((f) => {
        try { return fs.statSync(f).size <= MAX_FILE_BYTES; } catch { return false; }
      });
      const summary = String(out || '').trim().slice(-1200) || '（没有文字输出）';
      finish(job, `【后台 agent 完成】\n${summary}`, dir, outDir, files, code);
      resolve();
    });
  });
}

function finish(job, text, dir, outDir, files = [], code = null) {
  try {
    outbox.enqueue({ chatId: job.chatId, chatType: job.chatType, kind: 'text', text: String(text).slice(0, 1800), meta: { agentJob: job.id, code } });
    for (const f of files.slice(0, 6)) {
      outbox.enqueue({ chatId: job.chatId, chatType: job.chatType, kind: 'file', file: f, text: path.basename(f), meta: { agentJob: job.id } });
    }
  } catch (e) {
    logLine(`任务 ${job.id} 回发失败：${e && e.message}`);
  }
  logLine(`完成 ${job.id}（exit=${code}，文件 ${files.length} 个）→ ${job.chatId}`);
}

module.exports = { setDataDir, isEnabled, setEnabled, status, start, request, approve, pendingText };
