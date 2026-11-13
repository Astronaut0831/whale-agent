import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

export const SERVICE_NAMES = ['qq-transport', 'wechat-bridge'];

/**
 * Pure pre-flight guard. Kept free of I/O so it can be unit tested.
 */
export function startGuard(name, state, body = {}) {
  if (!SERVICE_NAMES.includes(name)) {
    return { ok: false, status: 400, error: '未知服务' };
  }
  if (state.bridgeRunning) {
    return { ok: true, status: 200, alreadyRunning: true };
  }
  if (name === 'qq-transport' && !state.onebot) {
    return { ok: false, status: 409, error: 'SnowLuma OneBot 未在线：先打开 5099 登录并启动 OneBot' };
  }
  if (name === 'wechat-bridge' && body.confirmBotWindow !== true) {
    return { ok: false, status: 400, error: '请先勾选“已只保留机器人号窗口”' };
  }
  return { ok: true, status: 202 };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function processSnapshot() {
  // One PowerShell call for both processes keeps the 5s status poll cheap.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$qq = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'adapter-transport\\.js' } | Select-Object -First 1",
    "$wx = Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'wechatauto_bridge\\.py' } | Select-Object -First 1",
    "[pscustomobject]@{ qq = [int64]($qq.ProcessId); wechat = [int64]($wx.ProcessId) } | ConvertTo-Json -Compress",
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: 4000,
    }, (err, stdout) => {
      if (err) return resolve({ qq: 0, wechat: 0 });
      try {
        const data = JSON.parse(String(stdout || '').trim());
        resolve({ qq: Number(data.qq) || 0, wechat: Number(data.wechat) || 0 });
      } catch {
        resolve({ qq: 0, wechat: 0 });
      }
    });
  });
}

export async function getServices({ root, qqRoot, checkPort }) {
  const snapshot = await processSnapshot();
  const [webui, onebotHttp, onebotWs] = await Promise.all([
    checkPort(5099),
    checkPort(3000),
    checkPort(3001),
  ]);
  const bridgeReady = readJson(path.join(root, 'data', 'bridge-ready.json'));
  const qqStatus = readJson(path.join(qqRoot, 'state', 'adapter-transport-status.json'));
  return {
    snowluma: {
      webui,
      onebot: onebotHttp && onebotWs,
    },
    qqTransport: {
      running: Boolean(snapshot.qq),
      lastError: String((qqStatus && qqStatus.lastError) || ''),
    },
    wechatBridge: {
      running: Boolean(snapshot.wechat),
      ready: Boolean(bridgeReady && bridgeReady.readyAt),
      stopFlag: fs.existsSync(path.join(root, 'data', 'bridge-stop.flag')),
    },
  };
}

function bridgePython() {
  const explicit = String(process.env.WHALE_PYTHON || '').trim();
  if (explicit) return explicit;
  return path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe');
}

function launch(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

export async function startService(name, ctx, body = {}) {
  const state = await getServices(ctx);
  const bridgeRunning = name === 'wechat-bridge'
    ? state.wechatBridge.running
    : state.qqTransport.running;
  const guard = startGuard(name, {
    onebot: state.snowluma.onebot,
    bridgeRunning,
  }, body);
  if (!guard.ok || guard.alreadyRunning) return guard;

  try {
    if (name === 'qq-transport') {
      launch('cmd.exe', ['/c', 'npm start'], { cwd: ctx.qqRoot });
    } else if (name === 'wechat-bridge') {
      const python = bridgePython();
      if (!fs.existsSync(python)) {
        return { ok: false, status: 500, error: '找不到 Python：' + python };
      }
      fs.rmSync(path.join(ctx.root, 'data', 'bridge-stop.flag'), { force: true });
      launch(python, [path.join(ctx.root, 'examples', 'wechatauto_bridge.py')], {
        cwd: ctx.root,
        env: { ...process.env, WHALE_BOT_URL: 'http://127.0.0.1:8788/webhook/wechat' },
      });
    }
    try {
      fs.appendFileSync(
        path.join(ctx.root, 'data', 'console-services.log'),
        `[${new Date().toISOString()}] start ${name}\n`,
        'utf8',
      );
    } catch { /* logging is best effort */ }
    return { ok: true, status: 202 };
  } catch (e) {
    return { ok: false, status: 500, error: String((e && e.message) || e) };
  }
}
