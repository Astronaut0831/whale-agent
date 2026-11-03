'use strict';

/**
 * 用量预算：防止被"套话"刷爆 token。
 *
 * - 每次模型调用后累加 total_tokens（按天重置）
 * - 超过警戒线：群友的上下文和回复额度自动缩水
 * - 超过硬上限：除主人外，一律用最小上下文 + 短回复
 *
 * 数据存 data/usage.json，重启不清零。
 */

const fs = require('node:fs');
const path = require('node:path');

let FILE = path.join(__dirname, '..', 'data', 'usage.json');

function setDataDir(dir) {
  if (dir) FILE = path.join(String(dir), 'usage.json');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d.date !== today()) return { date: today(), tokens: 0, calls: 0 };
    return d;
  } catch {
    return { date: today(), tokens: 0, calls: 0 };
  }
}

function save(d) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(d), 'utf8');
  } catch { /* 统计失败不影响聊天 */ }
}

/** 记一笔用量 */
function add(tokens, logger) {
  const n = Number(tokens) || 0;
  if (n <= 0) return load();
  const d = load();
  d.tokens += n;
  d.calls += 1;
  save(d);
  return d;
}

function status() {
  return load();
}

/**
 * 当前该用多大的上下文/回复额度。
 * @returns {{level:'normal'|'warn'|'low', histTurns:number, maxTokens:number}}
 */
function policy(config, { isMaster = false } = {}) {
  const b = (config && config.budget) || {};
  const daily = Number(b.dailyTokens) || 800000;
  const warnAt = Number(b.warnRatio) || 0.5;
  const lowAt = Number(b.lowRatio) || 0.8;
  const used = load().tokens;
  const ratio = daily > 0 ? used / daily : 0;

  const chat = (config && config.chat) || {};
  const fullHist = Number(chat.groupHistoryTurns) || 800;
  const fullMax = Number((config && config.deepseek && config.deepseek.maxTokens)) || 6000;

  if (isMaster) {
    // 主人始终给足，但撞了硬上限也减半，避免一天烧穿
    if (ratio >= 1.2) return { level: 'low', histTurns: Math.min(fullHist, 200), maxTokens: Math.min(fullMax, 1200) };
    return { level: 'normal', histTurns: fullHist, maxTokens: fullMax };
  }
  if (ratio >= 1.2) return { level: 'low', histTurns: 60, maxTokens: 400 };
  if (ratio >= lowAt) return { level: 'low', histTurns: 120, maxTokens: 800 };
  if (ratio >= warnAt) return { level: 'warn', histTurns: Math.min(fullHist, 300), maxTokens: Math.min(fullMax, 1500) };
  return { level: 'normal', histTurns: Math.min(fullHist, 500), maxTokens: Math.min(fullMax, 2500) };
}

module.exports = { add, status, policy, setDataDir };
