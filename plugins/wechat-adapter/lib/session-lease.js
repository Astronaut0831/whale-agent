/**
 * 本地文件 lease：只解决多个 adapter 进程同时写同一个 GUI target 的问题。
 * GUI 进程本身不遵守这个锁，因此它不是完整的跨进程单写者。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { repoRoot } from '../../lib/runtime.js';

function lockPath(dir, key) {
  const safe = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
  return path.join(dir, 'leases', safe + '.lock');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function withLease(key, fn, {
  dir = path.join(repoRoot, 'data'),
  owner = 'pid-' + process.pid,
  ttlMs = 60000,
  waitMs = 30000,
  pollMs = 100,
} = {}) {
  const file = lockPath(dir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = owner + '-' + Math.random().toString(36).slice(2, 8);
  const deadline = Date.now() + waitMs;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ key, owner: token, pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      acquired = true;
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs > ttlMs) { fs.unlinkSync(file); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('session lease timeout');
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.owner === token) fs.unlinkSync(file);
    } catch { /* ignore */ }
  }
}
