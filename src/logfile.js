'use strict';

/**
 * 滚动日志：超过大小上限就改名成 xxx.1（只保留 1 份历史），再从空文件开始。
 * 用于 recall.log / memory-merge.log 这类只增不减的观测日志。
 */

const fs = require('node:fs');
const path = require('node:path');

function rotateIfNeeded(file, maxBytes) {
  try {
    if (!fs.existsSync(file)) return false;
    const st = fs.statSync(file);
    if (st.size < maxBytes) return false;
    const old = file + '.1';
    try { fs.rmSync(old, { force: true }); } catch { /* ignore */ }
    fs.renameSync(file, old);
    return true;
  } catch {
    return false;
  }
}

/** 追加一行；超限先轮转 */
function appendLine(file, line, { maxMB = 5 } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, Math.max(1, Number(maxMB) || 5) * 1024 * 1024);
    fs.appendFileSync(file, String(line).replace(/\n*$/, '\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { appendLine, rotateIfNeeded };
