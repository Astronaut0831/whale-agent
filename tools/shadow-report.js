'use strict';

/**
 * Shadow 对比报告。
 * 用法：
 *   node tools/shadow-report.js [N]          打印最近 N 条
 *   node tools/shadow-report.js --write      写 docs/superpowers/plans/shadow-report.md
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const logFile = path.join(root, 'data', 'adapter.log');
const outFile = path.join(root, 'docs', 'superpowers', 'plans', 'shadow-report.md');
const args = process.argv.slice(2);
const write = args.includes('--write');
const limit = Number(args.find((a) => /^\d+$/.test(a))) || 10;

if (!fs.existsSync(logFile)) {
  console.log('没有 adapter.log');
  process.exit(0);
}

const rows = [];
for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  try { rows.push(JSON.parse(line)); } catch { /* skip */ }
}

const isReal = (r) => !/^test[-_]/i.test(String(r.msgId || ''));
const shadows = rows.filter((r) => r.kind === 'shadow');
const real = shadows.filter(isReal);
const fallbacks = rows.filter((r) => r.kind === 'fallback' && isReal(r));
const actives = rows.filter((r) => r.kind === 'active');

function pct(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function stats(list) {
  const ms = list.map((r) => Number(r.ms)).filter(Number.isFinite);
  const agentLen = list.map((r) => String(r.text || '').length);
  const legacyLen = list.map((r) => String((r.legacy && r.legacy.reply) || '').length);
  const emoji = (s) => (String(s).match(/[\p{Extended_Pictographic}]/gu) || []).length;
  const comfort = (s) => (String(s).match(/别|没事|我在|陪你|不急|慢慢|抱|心疼|辛苦|好好睡/g) || []).length;
  const shorter = list.filter((r, i) => agentLen[i] < legacyLen[i]).length;
  return {
    count: list.length,
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    agentAvgLen: Math.round(agentLen.reduce((a, b) => a + b, 0) / Math.max(1, agentLen.length)),
    legacyAvgLen: Math.round(legacyLen.reduce((a, b) => a + b, 0) / Math.max(1, legacyLen.length)),
    emoji: list.reduce((n, r) => n + emoji(r.text), 0),
    comfortAgent: list.reduce((n, r) => n + comfort(r.text), 0),
    comfortLegacy: list.reduce((n, r) => n + comfort(r.legacy && r.legacy.reply), 0),
    shorterPct: Math.round((shorter / Math.max(1, list.length)) * 100),
  };
}

const s = stats(real);
const lines = [];
lines.push('# Shadow 验收报告');
lines.push('');
lines.push('- 生成时间：' + new Date().toISOString());
lines.push('- 真实 shadow：' + real.length + ' / 50');
lines.push('- 测试 shadow：' + (shadows.length - real.length));
lines.push('- fallback：' + fallbacks.length);
lines.push('- active 记录：' + actives.length);
lines.push('');
lines.push('## 真实样本延迟');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | --- |');
lines.push('| p50 | ' + s.p50 + ' ms |');
lines.push('| p95 | ' + s.p95 + ' ms |');
lines.push('| agent 平均长度 | ' + s.agentAvgLen + ' 字 |');
lines.push('| legacy 平均长度 | ' + s.legacyAvgLen + ' 字 |');
lines.push('| agent emoji 数 | ' + s.emoji + ' |');
lines.push('| agent 共情词 | ' + s.comfortAgent + ' |');
lines.push('| legacy 共情词 | ' + s.comfortLegacy + ' |');
lines.push('| agent 比 legacy 短 | ' + s.shorterPct + '% |');
lines.push('');
lines.push('## 最近对比');
lines.push('');
for (const r of real.slice(-limit).reverse()) {
  const legacy = (r.legacy && (r.legacy.reply || (r.legacy.bubbles || []).join(' / '))) || '';
  lines.push('### ' + r.msgId + (r.ms ? '（' + r.ms + 'ms）' : ''));
  lines.push('');
  lines.push('- agent：' + String(r.text || '').replace(/\n/g, ' '));
  lines.push('- legacy：' + String(legacy).replace(/\n/g, ' '));
  lines.push('');
}
if (fallbacks.length) {
  lines.push('## 最近 fallback');
  lines.push('');
  for (const r of fallbacks.slice(-5)) lines.push('- ' + r.msgId + '：' + r.error);
  lines.push('');
}
const md = lines.join('\n');

if (write) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, md, 'utf8');
  console.log('written', outFile);
}
console.log('真实 shadow:', real.length, '/50 | p50', s.p50, 'ms | p95', s.p95, 'ms');
for (const r of real.slice(-limit).reverse()) {
  const legacy = (r.legacy && (r.legacy.reply || (r.legacy.bubbles || []).join(' / '))) || '';
  console.log('-', r.msgId, r.ms ? r.ms + 'ms' : '');
  console.log('  agent :', String(r.text || '').replace(/\n/g, ' ').slice(0, 80));
  console.log('  legacy:', String(legacy).replace(/\n/g, ' ').slice(0, 80));
}
