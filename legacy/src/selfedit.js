'use strict';

/**
 * 代码自改提案：让 dsh headless 在仓库副本里改代码，只生成提案；
 * 主人 /approve edit <id> 才应用到真实仓库（应用前备份、语法检查，失败回滚）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const outbox = require('./outbox');

const REPO = path.join(__dirname, '..');
let DATA_DIR = path.join(REPO, 'data');
let WORK_ROOT = path.join(DATA_DIR, 'self-edit');
let PROPOSAL_DIR = path.join(WORK_ROOT, 'proposals');
let FLAG = path.join(DATA_DIR, 'self-edit-enabled.json');

const SKIP_DIRS = new Set(['data', 'node_modules', 'runtime', 'backups', '.git', '.dsh']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 6;

function setDataDir(dir) {
  if (!dir) return;
  DATA_DIR = String(dir);
  WORK_ROOT = path.join(DATA_DIR, 'self-edit');
  PROPOSAL_DIR = path.join(WORK_ROOT, 'proposals');
  FLAG = path.join(DATA_DIR, 'self-edit-enabled.json');
}

function isEnabled() {
  try { return JSON.parse(fs.readFileSync(FLAG, 'utf8')).enabled === true; } catch { return false; }
}

function setEnabled(on) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FLAG, JSON.stringify({ enabled: Boolean(on), at: Date.now() }), 'utf8');
  return Boolean(on);
}

function logLine(msg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'self-edit.log'), `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`, 'utf8');
  } catch { /* ignore */ }
}

function masterChatId() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
    return String(((((c.persona || {}).master || {}).wxids) || [])[0] || '');
  } catch { return ''; }
}

function apiKey() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
    return String((c.deepseek || {}).apiKey || '');
  } catch { return ''; }
}

function dshBin() {
  const appdata = process.env.APPDATA || 'C:\\Users\\astronaut\\AppData\\Roaming';
  const p = path.join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return fs.existsSync(p) ? p : '';
}

function copyTree(src, dst, rel = '') {
  fs.mkdirSync(dst, { recursive: true });
  let rows = [];
  try { rows = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const r of rows) {
    if (SKIP_DIRS.has(r.name)) continue;
    if (r.name.endsWith('.log') || r.name.endsWith('.bak')) continue;
    const from = path.join(src, r.name);
    const to = path.join(dst, r.name);
    const relp = rel ? rel + '/' + r.name : r.name;
    if (r.isDirectory()) copyTree(from, to, relp);
    else if (r.isFile()) {
      try {
        const st = fs.statSync(from);
        if (st.size > MAX_FILE_BYTES) continue;
        fs.copyFileSync(from, to);
      } catch { /* skip */ }
    }
  }
}

function listFiles(root, rel = '', acc = []) {
  let rows = [];
  try { rows = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const r of rows) {
    const p = path.join(root, r.name);
    const relp = rel ? rel + '/' + r.name : r.name;
    if (r.isDirectory()) listFiles(p, relp, acc);
    else if (r.isFile()) acc.push(relp);
  }
  return acc;
}

function allowedPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p.includes('..')) return false;
  const top = p.split('/')[0];
  if (SKIP_DIRS.has(top)) return false;
  if (top === 'tools') return false;
  if (/\.(bat|ps1|vbs)$/i.test(p)) return false;
  return true;
}

function create({ request } = {}) {
  if (!isEnabled()) return { ok: false, msg: '代码自改现在是关闭的（/selfedit on 开启）。' };
  const req = String(request || '').trim().slice(0, 2000);
  if (!req) return { ok: false, msg: '需求是空的。' };
  const bin = dshBin();
  if (!bin) return { ok: false, msg: '找不到 dsh，无法生成提案。' };
  // 防刷屏：30 分钟内最多一次，每天最多 3 次
  const statePath = path.join(WORK_ROOT, 'state.json');
  try {
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
    const now = Date.now();
    if (now - Number(st.lastAt || 0) < 30 * 60 * 1000) {
      return { ok: false, msg: '刚提过代码提案，先缓缓（30 分钟后再提）。' };
    }
    const today = new Date().toISOString().slice(0, 10);
    if (st.day === today && Number(st.count || 0) >= 3) {
      return { ok: false, msg: '今天提案次数到上限了（3 次），明天再说。' };
    }
  } catch { /* 第一次没有 state */ }
  const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const work = path.join(WORK_ROOT, 'work', id);
  fs.mkdirSync(work, { recursive: true });
  try { copyTree(REPO, work); } catch (e) { return { ok: false, msg: '复制仓库失败：' + (e && e.message) }; }

  const prompt = [
    '你在修改「鲸鲸」（微信机器人）的代码。当前目录是项目副本。',
    `需求：${req}`,
    '规则：',
    '1. 只修改完成需求所必需的文件，不要动 data/、node_modules/、runtime/、backups/、tools/ 下的 .ps1/.bat；',
    '2. 不要启动/重启任何服务，不要改数据库；',
    '3. 改完后用一两句话总结改了什么。',
  ].join('\n');

  const child = spawn(process.execPath, [bin, 'headless', prompt], {
    cwd: work,
    env: { ...process.env, DEEPSEEK_API_KEY: apiKey() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 10 * 60 * 1000);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    clearTimeout(timer);
    const files = [];
    for (const rel of listFiles(work)) {
      if (!allowedPath(rel)) continue;
      try {
        const a = fs.readFileSync(path.join(REPO, rel), 'utf8');
        const b = fs.readFileSync(path.join(work, rel), 'utf8');
        if (a !== b) files.push({ path: rel, content: b });
      } catch { /* 新文件或读不了，跳过 */ }
    }
    const summary = String(out || '').trim().slice(-400) || (code === 0 ? '（没有文字总结）' : '（agent 退出码 ' + code + '）');
    const proposal = { id, request: req, at: Date.now(), summary, files: files.slice(0, MAX_FILES), code };
    fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROPOSAL_DIR, id + '.json'), JSON.stringify(proposal, null, 1), 'utf8');
    logLine(`提案 ${id}：${files.length} 个文件变动（${req.slice(0, 40)}）`);
    try {
      const statePath = path.join(WORK_ROOT, 'state.json');
      const today = new Date().toISOString().slice(0, 10);
      let st = {};
      try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch { /* first */ }
      st.lastAt = Date.now();
      const prevDay = st.day;
      st.day = today;
      st.count = prevDay === today && st.count ? st.count + 1 : 1;
      fs.writeFileSync(statePath, JSON.stringify(st), 'utf8');
    } catch { /* ignore */ }
    const master = masterChatId();
    if (master) {
      const list = proposal.files.map((f) => f.path).join('、') || '（无文件变动）';
      outbox.enqueue({
        chatId: master,
        chatType: 'private',
        kind: 'text',
        text: `【代码提案 ${id}】\n需求：${req.slice(0, 200)}\n改动：${list}\n总结：${summary.slice(0, 200)}\n\n回复 /approve edit ${id} 应用，或 /deny edit ${id} 拒绝`,
        meta: { selfEdit: id },
      });
    }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  return { ok: true, id };
}

function loadProposal(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROPOSAL_DIR, String(id) + '.json'), 'utf8'));
  } catch { return null; }
}

function syntaxCheck(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.js') {
      const r = require('node:child_process').spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60000 });
      return r.status === 0 ? '' : String(r.stderr || r.stdout || '').slice(0, 400);
    }
    if (ext === '.py') {
      const r = require('node:child_process').spawnSync('python', ['-m', 'py_compile', file], { encoding: 'utf8', timeout: 60000 });
      return r.status === 0 ? '' : String(r.stderr || r.stdout || '').slice(0, 400);
    }
    if (ext === '.json') {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      return '';
    }
  } catch (e) {
    return String(e && e.message || e);
  }
  return '';
}

function approve(id) {
  const p = loadProposal(id);
  if (!p) return { ok: false, msg: '没找到这个提案（可能已处理）。' };
  if (!p.files || !p.files.length) return { ok: false, msg: '这个提案没有文件改动，不用应用。' };
  if (p.files.length > MAX_FILES) return { ok: false, msg: '改动文件太多，拒绝应用。' };
  const backups = [];
  try {
    for (const f of p.files) {
      if (!allowedPath(f.path)) throw new Error('不允许改的文件：' + f.path);
      const full = path.join(REPO, f.path);
      const bakDir = path.join(DATA_DIR, 'backups');
      fs.mkdirSync(bakDir, { recursive: true });
      const bak = path.join(bakDir, 'selfedit-' + id + '-' + path.basename(f.path) + '.bak');
      if (fs.existsSync(full)) fs.copyFileSync(full, bak);
      backups.push({ full, bak, existed: fs.existsSync(full) });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(f.content), 'utf8');
    }
    for (const f of p.files) {
      const err = syntaxCheck(path.join(REPO, f.path));
      if (err) throw new Error('语法检查失败：' + f.path + '\n' + err);
    }
  } catch (e) {
    for (const b of backups) {
      try {
        if (b.existed) fs.copyFileSync(b.bak, b.full);
        else fs.rmSync(b.full, { force: true });
      } catch { /* ignore */ }
    }
    return { ok: false, msg: '应用失败，已回滚：' + (e && e.message) };
  }
  try { fs.unlinkSync(path.join(PROPOSAL_DIR, id + '.json')); } catch { /* ignore */ }
  logLine(`已应用提案 ${id}：${p.files.map((f) => f.path).join('、')}`);
  // 3 秒后重启（当前进程会被 stop-all 杀掉，所以用 detached）
  try {
    const ps = 'Start-Sleep -Seconds 3; & "' + path.join(REPO, 'tools', 'start-all.ps1') + '"';
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch { /* 重启失败就得手动 */ }
  return { ok: true, msg: '已应用（' + p.files.length + ' 个文件），3 秒后自动重启。' };
}

function deny(id) {
  try { fs.unlinkSync(path.join(PROPOSAL_DIR, String(id) + '.json')); } catch { /* ignore */ }
  logLine(`拒绝提案 ${id}`);
  return { ok: true, msg: '已拒绝并删除提案。' };
}

module.exports = { setDataDir, isEnabled, setEnabled, create, approve, deny, loadProposal };
