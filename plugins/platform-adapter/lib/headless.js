/** Headless 一次性 agent：每条消息起一个 dsh 进程，用 session-id 续会话。 */

import { spawn } from 'node:child_process';

export function parseRunEvents(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.trim());
  let sessionId = '';
  let finalText = '';
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session' && e.sessionId) sessionId = e.sessionId;
    if (e.type === 'final') finalText = String(e.text || '');
  }
  return { sessionId, finalText };
}

export function runHeadlessTurn({
  sessionKey,
  message,
  store,
  profile = 'whale-headless',
  timeoutMs = 120000,
  cwd,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const sid = store && store.get(sessionKey);
  const baseArgs = ['--profile', profile, '--json'];
  if (sid) baseArgs.push('--session-id', sid);
  baseArgs.push('-');

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'dsh';
  const args = isWin ? ['/d', '/c', 'dsh', ...baseArgs] : baseArgs;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { cwd, env, windowsHide: true });
      child.stdin?.write(String(message));
      child.stdin?.end();
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('headless timeout'));
    }, timeoutMs);

    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const parsed = parseRunEvents(stdout);
      if (parsed.sessionId && store) store.set(sessionKey, parsed.sessionId);
      if (code !== 0 || !parsed.finalText) {
        reject(new Error('headless failed: code=' + code + ' ' + (stderr || stdout).slice(0, 300)));
        return;
      }
      resolve({ text: parsed.finalText, sessionId: parsed.sessionId });
    });
  });
}
