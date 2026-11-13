# 控制台服务启动面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在鲸鲸控制台 `:3100` 增加固定白名单的服务启动面板：SnowLuma 只读状态，QQ transport 和微信 bridge 可手动启动。

**Architecture:** 控制台 Node 后端新增 `services.mjs`，集中做固定进程探测、启动前校验和 detached 启动；`server.mjs` 暴露 `/api/services` 和 `/api/services/:name/start`；Vue 前端在监控页显示状态和按钮。所有启动目标写死，不接受命令字符串。

**Tech Stack:** Node 24 ESM、PowerShell `Get-CimInstance` 进程探测、Vue 3 + Naive UI、Vite。

**Spec:** `docs/superpowers/specs/2026-11-13-console-service-start-design.md`

## Global Constraints

- 控制台只绑定 `127.0.0.1:3100`，不新增公网监听。
- 只允许两个服务名：`qq-transport`、`wechat-bridge`。
- 不启动/停止 SnowLuma；只显示 5099/3000/3001 与进程状态。
- 不提供任意 shell、命令字符串或路径参数。
- 微信 bridge 启动必须收到 `confirmBotWindow: true`；先删除 `data/bridge-stop.flag`。
- QQ transport 启动前必须 3000 和 3001 都在线；否则返回 409。
- 重复启动必须幂等：已有进程时返回 `running`，不产生第二个实例。
- 所有代码改动使用 `safe_patch.py`；涉及中文的文件用 edit/write。

## Review Focus

- OneBot 离线时点 QQ 启动：必须 409，不能产生半启动进程。
- 微信确认框未勾选：必须 400，不能删 stop flag。
- 已存在 bridge 进程时重复点击：不能起第二个 Python。
- SnowLuma 只读：不能出现启动/停止按钮或对应 API。
- 状态探测慢或 PowerShell 失败：页面仍能显示已有状态，不阻塞 5s 轮询。

---

### Task 1: 纯启动校验

**Files:**
- Create: `tools/platform-console/services.mjs`
- Test: `tools/platform-console/services.test.mjs`

**Interfaces:**
- Produces: `startGuard(name, state, body = {}) -> { ok: boolean, status: number, error?: string }`
- `state` shape: `{ onebot: boolean, bridgeRunning: boolean }`
- Names: only `qq-transport`, `wechat-bridge`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuard } from './services.mjs';

test('qq transport requires OneBot', () => {
  assert.deepEqual(
    startGuard('qq-transport', { onebot: false, bridgeRunning: false }),
    { ok: false, status: 409, error: 'SnowLuma OneBot 未在线：先打开 5099 登录并启动 OneBot' },
  );
});

test('wechat bridge requires explicit confirmation', () => {
  assert.equal(
    startGuard('wechat-bridge', { onebot: true, bridgeRunning: false }).status,
    400,
  );
});

test('wechat bridge accepts confirmed start', () => {
  assert.equal(
    startGuard('wechat-bridge', { onebot: true, bridgeRunning: false }, { confirmBotWindow: true }).ok,
    true,
  );
});

test('unknown service is rejected', () => {
  assert.equal(startGuard('rm-rf', { onebot: true, bridgeRunning: false }).status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd D:\dsh-workspace\chat\whale_gril\tools\platform-console
node --test services.test.mjs
```

Expected: FAIL because `services.mjs` does not exist.

- [ ] **Step 3: Implement `startGuard`**

In `services.mjs`:

```js
export const SERVICE_NAMES = ['qq-transport', 'wechat-bridge'];

export function startGuard(name, state, body = {}) {
  if (!SERVICE_NAMES.includes(name)) return { ok: false, status: 400, error: '未知服务' };
  if (state.bridgeRunning) return { ok: true, status: 200, alreadyRunning: true };
  if (name === 'qq-transport' && !state.onebot) {
    return { ok: false, status: 409, error: 'SnowLuma OneBot 未在线：先打开 5099 登录并启动 OneBot' };
  }
  if (name === 'wechat-bridge' && body.confirmBotWindow !== true) {
    return { ok: false, status: 400, error: '请先勾选“已只保留机器人号窗口”' };
  }
  return { ok: true, status: 202 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node --test services.test.mjs
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```powershell
git add tools/platform-console/services.mjs tools/platform-console/services.test.mjs
git commit -m "feat: add console service start guards"
```

---

### Task 2: 状态探测和启动函数

**Files:**
- Modify: `tools/platform-console/services.mjs`

**Interfaces:**
- Consumes: `startGuard`.
- Produces:
  - `getServices({ root, qqRoot, checkPort }) -> Promise<ServicesState>`
  - `startService(name, ctx, body) -> Promise<{ ok, status, alreadyRunning?, error? }>`

`ServicesState`:

```ts
{
  snowluma: { webui: boolean; onebot: boolean },
  qqTransport: { running: boolean; lastError: string },
  wechatBridge: { running: boolean; ready: boolean; stopFlag: boolean }
}
```

- [ ] **Step 1: Add process snapshot**

Implement:

```js
function psJson(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}
```

Use one PowerShell call returning:

```json
{ "qq": 1234, "wechat": 5678 }
```

Match only:

```text
node.exe command line contains adapter-transport.js
python.exe command line contains wechatauto_bridge.py
```

- [ ] **Step 2: Implement `getServices`**

- `snowluma.webui = await checkPort(5099)`
- `snowluma.onebot = await checkPort(3000) && await checkPort(3001)`
- `qqTransport.running = Boolean(ps.qq)`
- `wechatBridge.running = Boolean(ps.wechat)`
- `wechatBridge.ready = Boolean(readJson(root/data/bridge-ready.json)?.readyAt)`
- `wechatBridge.stopFlag = exists(root/data/bridge-stop.flag)`

- [ ] **Step 3: Implement `startService`**

```js
const guard = startGuard(name, {
  onebot: state.snowluma.onebot,
  bridgeRunning: name === 'wechat-bridge' ? state.wechatBridge.running : state.qqTransport.running,
}, body);
if (!guard.ok || guard.alreadyRunning) return guard;
```

QQ:

```js
spawn('cmd.exe', ['/c', 'npm start'], {
  cwd: qqRoot, detached: true, stdio: 'ignore', windowsHide: true,
}).unref();
```

微信：

```js
if (state.wechatBridge.stopFlag) fs.rmSync(stopFlag, { force: true });
spawn('cmd.exe', ['/c', 'tools\\run-bridge.bat'], {
  cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
}).unref();
```

- [ ] **Step 4: Add tests for idempotency and guard wiring**

Add to `services.test.mjs`:

```js
test('already running is idempotent', () => {
  assert.equal(startGuard('qq-transport', { onebot: false, bridgeRunning: true }).alreadyRunning, true);
});
```

Run `node --test services.test.mjs`; expect 5 pass.

- [ ] **Step 5: Commit**

```powershell
git add tools/platform-console/services.mjs tools/platform-console/services.test.mjs
git commit -m "feat: add console service status and launcher"
```

---

### Task 3: 后端 API 接线

**Files:**
- Modify: `tools/platform-console/server.mjs`

**Interfaces:**
- Consumes: `getServices`, `startService`.
- Produces:
  - `GET /api/services` → `ServicesState`
  - `POST /api/services/:name/start` → `{ ok, status, alreadyRunning?, error? }`

- [ ] **Step 1: Import services**

```js
import { getServices, startService } from './services.mjs';
```

Create `serviceCtx = { root: ROOT, qqRoot: QQ_ROOT, checkPort }`.

- [ ] **Step 2: Add GET route**

Before `/api/logs`:

```js
if (url.pathname === '/api/services' && req.method === 'GET') {
  return sendJson(res, 200, await getServices(serviceCtx));
}
```

- [ ] **Step 3: Add POST route**

```js
const m = url.pathname.match(/^\/api\/services\/([a-z-]+)\/start$/);
if (m && req.method === 'POST') {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
  const result = await startService(m[1], serviceCtx, body);
  return sendJson(res, result.status, result);
}
```

Place before the generic `read-only console` 405 fallback.

- [ ] **Step 4: Verify endpoints**

Restart console:

```powershell
Get-NetTCPConnection -LocalPort 3100 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory 'D:\dsh-workspace\chat\whale_gril\tools\platform-console' -WindowStyle Hidden
```

Check:

```powershell
Invoke-RestMethod http://127.0.0.1:3100/api/services | ConvertTo-Json -Depth 5
```

Expected: `snowluma`, `qqTransport`, `wechatBridge` all present.

QQ guard check (OneBot currently offline):

```powershell
try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/api/services/qq-transport/start -ContentType 'application/json' -Body '{}' } catch { $_.Exception.Response.StatusCode.value__ }
```

Expected: `409`.

WeChat guard check:

```powershell
try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/api/services/wechat-bridge/start -ContentType 'application/json' -Body '{}' } catch { $_.Exception.Response.StatusCode.value__ }
```

Expected: `400`; stop flag must still exist.

- [ ] **Step 5: Commit**

```powershell
git add tools/platform-console/server.mjs
git commit -m "feat: expose console service endpoints"
```

---

### Task 4: 前端状态和按钮

**Files:**
- Modify: `tools/platform-console/src/api.ts`
- Modify: `tools/platform-console/src/App.vue`

**Interfaces:**
- Consumes: `GET /api/services`, `POST /api/services/:name/start`.
- Produces: service panel with status, start buttons, confirmation checkbox.

- [ ] **Step 1: Add types and API functions**

In `api.ts`:

```ts
export interface ServicesState {
  snowluma: { webui: boolean; onebot: boolean };
  qqTransport: { running: boolean; lastError: string };
  wechatBridge: { running: boolean; ready: boolean; stopFlag: boolean };
}

export async function fetchServices(): Promise<ServicesState> { ... }
export async function startService(name: 'qq-transport' | 'wechat-bridge', body = {}): Promise<{ ok: boolean; error?: string; status?: number }> { ... }
```

- [ ] **Step 2: Load services**

In `App.vue` script:

- import `NCheckbox` and functions.
- add:

```ts
const services = ref<ServicesState | null>(null);
const serviceError = ref('');
const starting = ref('');
const bridgeConfirmed = ref(false);

async function loadServices() {
  try { services.value = await fetchServices(); } catch (e) { serviceError.value = String((e as Error)?.message || e); }
}
```

- call `loadServices()` in `refresh()` and in the 5s timer.
- `startOne(name)` calls `startService`; for WeChat send `{ confirmBotWindow: bridgeConfirmed.value }`; on error set `serviceError`; then `loadServices()`.

- [ ] **Step 3: Add UI**

In the monitor grid, after the SnowLuma card:

- QQ card adds:

```vue
<NButton size="small" type="primary" :disabled="!services?.snowluma.onebot || services?.qqTransport.running" :loading="starting === 'qq-transport'" @click="startOne('qq-transport')">启动</NButton>
```

- SnowLuma card remains status-only; add link, no start button.
- WeChat card adds:

```vue
<label class="check-row"><input v-model="bridgeConfirmed" type="checkbox" /> 已只保留机器人号窗口</label>
<NButton size="small" type="primary" :disabled="!bridgeConfirmed || services?.wechatBridge.running" :loading="starting === 'wechat-bridge'" @click="startOne('wechat-bridge')">启动</NButton>
```

- show `serviceError`.

- [ ] **Step 4: Build**

```powershell
cd D:\dsh-workspace\chat\whale_gril\tools\platform-console
npm run build
```

Expected: exit 0, `dist/index.html` updated.

- [ ] **Step 5: Verify page**

Open `http://127.0.0.1:3100`:

- SnowLuma no start button.
- QQ start disabled while OneBot offline.
- WeChat start disabled until checkbox.
- No console errors.

- [ ] **Step 6: Commit**

```powershell
git add tools/platform-console/src/api.ts tools/platform-console/src/App.vue tools/platform-console/dist
git commit -m "feat: add service start controls to console"
```

---

## Self-Review

- Spec coverage: SnowLuma read-only, QQ guard, WeChat confirmation, idempotency, fixed allowlist all have tasks.
- No arbitrary command path.
- Frontend types match backend `ServicesState`.
- Stop buttons intentionally omitted.
- WeChat start still requires operator confirming only bot window; not auto-detected.
