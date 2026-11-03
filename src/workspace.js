'use strict';

/**
 * workspace：她自己的文件空间（读写都限这里，碰不到配置/记忆库）
 * 与 sandbox 分开：sandbox 放可执行脚本，workspace 放文档/笔记。
 */

const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE = 'D:\\dsh-workspace\\chat\\whale_gril\\workspace';
const MAX_READ = 64 * 1024;
const MAX_WRITE = 256 * 1024;

function ensure() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  return WORKSPACE;
}

/** 把相对路径安全地解析到 workspace 内；越界直接抛错 */
function resolve(p) {
  const base = ensure();
  const rel = String(p || '').replace(/^[\\/]+/, '');
  const full = path.resolve(base, rel);
  const normBase = path.resolve(base) + path.sep;
  if (full !== path.resolve(base) && !full.startsWith(normBase)) {
    throw new Error('路径越界：只能访问 workspace 里的文件');
  }
  return full;
}

function readFileText(p) {
  const full = resolve(p);
  if (!fs.existsSync(full)) throw new Error('文件不存在：' + String(p));
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new Error('这是个目录，不是文件');
  if (st.size > MAX_READ) throw new Error('文件太大（超过 64KB），先分段读');
  return { text: fs.readFileSync(full, 'utf8'), name: path.basename(full), bytes: st.size };
}

function writeFileText(p, content) {
  const txt = String(content == null ? '' : content);
  if (Buffer.byteLength(txt, 'utf8') > MAX_WRITE) throw new Error('内容太大（超过 256KB）');
  const full = resolve(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, txt, 'utf8');
  return { name: path.relative(ensure(), full), bytes: Buffer.byteLength(txt, 'utf8') };
}

function listFiles(sub) {
  const dir = resolve(sub || '');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
    const full = path.join(dir, d.name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* ignore */ }
    return { name: d.name, dir: d.isDirectory(), size };
  });
}

module.exports = { WORKSPACE, ensure, resolve, readFileText, writeFileText, listFiles, MAX_READ, MAX_WRITE };
