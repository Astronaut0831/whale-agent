
/**
 * 后台任务队列：主人派活 → 入队 → worker 取一条执行 → 关键节点播报 → 完成/失败通知。
 * 持久化在 data/tasks.json，重启不丢（运行中的任务重启后标记为 interrupted）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './runtime.js';

let FILE = path.join(repoRoot, 'data', 'tasks.json');
const MAX_DONE = 50;

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'tasks.json');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { items: Array.isArray(d.items) ? d.items : [] };
  } catch {
    return { items: [] };
  }
}

function save(d) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* ignore */ }
}

function enqueue({ chatId, chatType = 'private', ownerId = '', instruction = '' }) {
  const d = load();
  const id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  const item = {
    id, chatId: String(chatId || ''), chatType, ownerId: String(ownerId || ''),
    instruction: String(instruction || '').slice(0, 2000),
    status: 'queued', createdAt: Date.now(), startedAt: 0, endedAt: 0,
    steps: [], result: '', error: '', cancelled: false,
  };
  d.items.push(item);
  // 只保留最近 50 条已完成
  const done = d.items.filter((x) => x.status === 'done' || x.status === 'failed' || x.status === 'cancelled');
  if (done.length > MAX_DONE) {
    const drop = new Set(done.slice(0, done.length - MAX_DONE).map((x) => x.id));
    d.items = d.items.filter((x) => !drop.has(x.id));
  }
  save(d);
  return item;
}

function next() {
  const d = load();
  const it = d.items.find((x) => x.status === 'queued');
  if (!it) return null;
  it.status = 'running';
  it.startedAt = Date.now();
  save(d);
  return { ...it };
}

function update(id, patch) {
  const d = load();
  const it = d.items.find((x) => x.id === id);
  if (!it) return null;
  Object.assign(it, patch || {});
  save(d);
  return { ...it };
}

function addStep(id, text) {
  const d = load();
  const it = d.items.find((x) => x.id === id);
  if (!it) return null;
  it.steps = Array.isArray(it.steps) ? it.steps : [];
  it.steps.push({ at: Date.now(), text: String(text || '').slice(0, 200) });
  if (it.steps.length > 30) it.steps = it.steps.slice(-30);
  save(d);
  return it.steps.length;
}

function get(id) {
  return load().items.find((x) => x.id === id) || null;
}

/** 取消：排队中直接取消；运行中置 cancelled（worker 在步骤间检查） */
function cancel(id) {
  const d = load();
  const it = d.items.find((x) => x.id === id);
  if (!it) return null;
  if (it.status === 'queued') {
    it.status = 'cancelled';
    it.endedAt = Date.now();
  } else if (it.status === 'running') {
    it.cancelled = true;
  } else {
    return null;
  }
  save(d);
  return { ...it };
}

function cancelAll() {
  const d = load();
  let n = 0;
  for (const it of d.items) {
    if (it.status === 'queued') { it.status = 'cancelled'; it.endedAt = Date.now(); n += 1; }
    else if (it.status === 'running') { it.cancelled = true; n += 1; }
  }
  save(d);
  return n;
}

function list(limit = 10) {
  return load().items.slice(-limit).reverse();
}

/** 启动时把"运行中"的任务标记为中断（不自动重跑，避免重复副作用） */
function markInterrupted() {
  const d = load();
  let n = 0;
  for (const it of d.items) {
    if (it.status === 'running') {
      it.status = 'failed';
      it.error = '服务重启，任务中断';
      it.endedAt = Date.now();
      n += 1;
    }
  }
  if (n) save(d);
  return n;
}

export { enqueue, next, update, addStep, get, cancel, cancelAll, list, markInterrupted, setDataDir, load };
