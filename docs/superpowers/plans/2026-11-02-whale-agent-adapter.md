# 微信 Adapter（C 方案 P2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主人私聊由 DSH 里的 agent 会话直接接管，微信只做 I/O；旧 bot 作为 off/shadow 与失败回退通道。

**Architecture:** 新建 `@whale/wechat-adapter` Cordis 插件，挂进 `whale-agent` profile；插件注册 `/wechat/inbound`，按 `sessionKey` 创建/恢复 `ctx.agents` 会话，`followup` 后 `whenIdle` 取 `agent.session.deriveMessages()` 的最后一条 assistant 文本，拆气泡交给桥接发送。`off`/`shadow` 代理旧 bot，`active` 才接管。

**Tech Stack:** Node.js ESM、Cordis 4、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-host-webserver`、`dsh-session`、现有 Python 桥接、node:test。

**Spec:** `docs/superpowers/specs/2026-11-02-whale-agent-adapter-design.md`

## Global Constraints

- 只接管主人私聊 `wechat:u:<master wxid>`；群聊、QQ、B 站一律不碰。
- 桥接仍是唯一 UIA 发送方；插件不直接操作微信窗口。
- 失败必须回退旧 bot，且回退不能重复回复。
- 记忆隐私规则不变：群间隔离，跨会话只对主人开放。
- 不修改现有 bot 的行为；新增开关默认 `off`。
- 现有仓库不是 git 仓库：每个任务结束用 `safe_patch` 备份或复制文件，不执行 git commit。
- 凭据不写进插件代码；从环境变量 `DEEPSEEK_API_KEY` 注入 profile。

## Review Focus

- 桥接 `msg_id` 重复投递时只回一次；
- active 模式 agent 超时/报错时旧 bot 恰好接手，不双回；
- 同一会话两条消息并发时顺序不乱；
- 会话恢复后不把历史消息再当新消息发送；
- 代理旧 bot 时保留原始 `msg_id` 与 `at_me` 语义。

---

### Task 1: 插件骨架与开发 profile

**Files:**
- Create: `plugins/wechat-adapter/package.json`
- Create: `plugins/wechat-adapter/index.js`
- Create: `plugins/wechat-adapter/test/ping.test.js`
- Modify: `~/.dsh/profiles/whale-agent/package.json`、`cordis.patch.yml`（新建 profile，从 `p1-lite` 复制）

**Interfaces:**
- Produces: `GET /wechat/ping` → `{ ok: true, plugin: 'wechat-adapter' }`
- Produces: `POST /webhook/wechat`（兼容旧 bot 路径）
- Produces: package name `@whale/wechat-adapter`

- [ ] **Step 1: 写失败测试**

```js
// plugins/wechat-adapter/test/ping.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pingPayload } from '../index.js';

test('ping 返回插件标识', () => {
  assert.deepEqual(pingPayload(), { ok: true, plugin: 'wechat-adapter' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test plugins/wechat-adapter/test/ping.test.js`
Expected: FAIL（`pingPayload` 未导出）

- [ ] **Step 3: 写最小插件**

`package.json`：`"name":"@whale/wechat-adapter"`, `"type":"module"`, `"main":"index.js"`。
`index.js`：

```js
export const name = 'wechat-adapter';
export const inject = ['webServer'];
export function pingPayload() { return { ok: true, plugin: 'wechat-adapter' }; }
export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/wechat/ping',
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(pingPayload()));
    },
  });
}
export default { name, inject, apply };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test plugins/wechat-adapter/test/ping.test.js`
Expected: PASS

- [ ] **Step 5: 建 whale-agent profile 并挂插件**

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\p1-lite" "$env:USERPROFILE\.dsh\profiles\whale-agent" -Recurse
dsh plugin --profile whale-agent add "D:\dsh-workspace\chat\whale_gril\plugins\wechat-adapter"
# 把 @whale/wechat-adapter 加进 package.json 的 dsh.profile.bundles，并确保 tool-web 仍启用
dsh --profile whale-agent --dump-config
```
Expected: dump 里出现 `wechat-adapter`，无 `patch: entry ... not found`。

- [ ] **Step 6: 启动 profile 并验证路由**

Run: `dsh --profile whale-agent`（后台），然后 `Invoke-WebRequest http://127.0.0.1:<port>/wechat/ping`
Expected: `{"ok":true,"plugin":"wechat-adapter"}`

- [ ] **Step 7: 备份并记录端口**

把 profile 端口写进 `docs/superpowers/plans/p2-runbook.md`；插件目录复制一份到 `backups/`。

---

### Task 2: 纯函数（归一化 / 模式 / 拆气泡）

**Files:**
- Create: `plugins/wechat-adapter/lib/normalize.js`
- Create: `plugins/wechat-adapter/lib/bubbles.js`
- Create: `plugins/wechat-adapter/test/normalize.test.js`

**Interfaces:**
- Produces: `normalizeInbound(payload)` → `{ msgId, sessionKey, chatId, chatType, senderId, senderName, text, images, atMe, chatTitle, ts }`
- Produces: `decideMode({ mode, masterWxid }, msg)` → `'off' | 'shadow' | 'active' | 'legacy'`
- Produces: `splitBubbles(text, { maxBubbles, maxChars })` → `string[]`

- [ ] **Step 1: 写失败测试**

覆盖：私聊文本归一化、群聊不接管、`msg_id` 缺失报错、长文本按标点拆条且不超 `maxBubbles`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test plugins/wechat-adapter/test/normalize.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现纯函数**

`senderId` 优先 `sender_id/user_id`；`sessionKey = wechat:${group?'g':'u'}:${chatId}`；`decideMode` 只有 `chatType==='private' && chatId===masterWxid` 才允许 `shadow/active`，否则 `legacy`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test plugins/wechat-adapter/test/normalize.test.js`
Expected: PASS

- [ ] **Step 5: 备份**

`Copy-Item plugins\wechat-adapter\lib backups\wechat-adapter-lib-<ts> -Recurse`

---

### Task 3: `/webhook/wechat` + off 代理 + 幂等

**Files:**
- Create: `plugins/wechat-adapter/lib/inbound.js`
- Modify: `plugins/wechat-adapter/index.js`
- Create: `plugins/wechat-adapter/test/inbound.test.js`

**Interfaces:**
- Consumes: `normalizeInbound`、`decideMode`
- Produces: `handleInbound(payload, deps)` → `{ handled: boolean, bubbles?: string[], mode: string }`
- `deps`: `{ token, mode, masterWxid, legacyBase, fetchImpl, seen, now }`
- 路由：`POST /webhook/wechat`；其余路径代理到 `legacyBase`

- [ ] **Step 1: 写失败测试**

覆盖：token 错 401、重复 `msg_id` 返回已处理、off/legacy 转发旧 bot 保留 payload、旧 bot 5xx 返回 502。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test plugins/wechat-adapter/test/inbound.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 handler**

JSON body 解析上限 1MB；`/wechat/inbound` POST；token 从 `x-bot-token` 或 query；`seen` 用 Map + 10 分钟 TTL；off/legacy 用 `fetch(legacyUrl, {method:'POST', body: JSON.stringify(payload)})`；返回旧 bot 的 JSON。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test plugins/wechat-adapter/test/inbound.test.js`
Expected: PASS

- [ ] **Step 5: 备份**

同 Task 2。

---

### Task 4: Agent 会话管理

**Files:**
- Create: `plugins/wechat-adapter/lib/sessions.js`
- Create: `plugins/wechat-adapter/test/sessions.test.js`

**Interfaces:**
- Produces: `runTurn({ ctx, sessionKey, message, timeoutMs, store })` → `{ text, sessionId, usage? }`
- `store`：`{ get(sessionKey), set(sessionKey, sessionId) }`，默认落 `data/core-sessions.json`

- [ ] **Step 1: 写失败测试（fake agent）**

fake `ctx.agents.create/resume` 返回 `{ agent: { followup, whenIdle, session: { deriveMessages } } }`；覆盖：首次 create、已有映射 resume、whenIdle 超时调用 cancel、取最后一条 assistant 文本。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test plugins/wechat-adapter/test/sessions.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 runTurn**

`followup({ content:[{type:'text', text: message}], source:{kind:'wechat'} })`；`await whenIdle()` 用 `Promise.race` + timeout；超时 `agent.cancel('timeout')` 并 throw；最后从 `deriveMessages()` 反向找 `role==='assistant'` 的文本。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test plugins/wechat-adapter/test/sessions.test.js`
Expected: PASS

---

### Task 5: active/shadow 接线与回退

**Files:**
- Modify: `plugins/wechat-adapter/lib/inbound.js`
- Modify: `plugins/wechat-adapter/index.js`
- Modify: `server.js`（新增 `POST /api/core/send`）
- Create: `plugins/wechat-adapter/test/modes.test.js`

**Interfaces:**
- Consumes: `runTurn`、`splitBubbles`
- Produces: `runActive(payload, deps)` → `{ bubbles }`；`runShadow(payload, deps)` → 记录后转发旧 bot
- 旧 bot 新接口：`POST /api/core/send` `{ chatId, chatType, bubbles, quote? }` → `{ ok:true }`；校验 `x-bot-token`，把气泡入现有 outbox

- [ ] **Step 1: 写失败测试**

覆盖：shadow 转发旧 bot 且 agent 结果只写日志；active agent 成功返回气泡；active agent 抛错转发旧 bot；active 超时回退且不双发。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test plugins/wechat-adapter/test/modes.test.js`
Expected: FAIL

- [ ] **Step 3: 实现模式分支**

index.js 把 `writeFile`/`fetch`/`runTurn` 注入 handler；shadow 不阻塞旧 bot；active 异常 catch → legacy；日志用 `ctx.logger` 或 `console.error` 到 `data/adapter.log`。

模式**每次请求热读** `data/core-mode.json`（`{mode:'off|shadow|active'}`，默认 off），不重启生效；新增 `tools/core-mode.js` 写该文件，作为 `/rollback core` 的等价 CLI。

- [ ] **Step 3b: 旧 bot 加 `/api/core/send`**

在 `server.js` 路由区加 POST 处理：校验 `x-bot-token`（复用 `config.gateway.wechat.inboundToken`），调用现有 outbox 入队函数写入 `{chatId, chatType, bubbles}`；返回 `{ok:true}`。加一条 server 端测试或 curl 验证。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test plugins/wechat-adapter/test/modes.test.js`
Expected: PASS

---

### Task 6: 记忆 HTTP 服务与工具

**Files:**
- Create: `tools/memory-server.js`
- Create: `tools/memory-server.test.js`
- Create: `plugins/wechat-adapter/lib/memory-tools.js`

**Interfaces:**
- Produces: `POST /recall` `{scope,query,limit}` → `{items}`
- Produces: `POST /add` `{scope,text,about,evidence}`；`POST /correct`；`POST /narrative`
- Produces: DSH tools `memory_recall`、`memory_add`、`memory_correct`

- [ ] **Step 1: 写失败测试**

用临时 `memories.json` 起服务，覆盖：无 token 401、主人跨会话可见、群会话隔离、add→recall 命中。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tools/memory-server.test.js`

- [ ] **Step 3: 实现服务**

复用 `src/memories.js`，`memories.setDataDir` 指向 `data`；默认 `127.0.0.1:8791`；token 用 `config.gateway.wechat.inboundToken`；只监听回环。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tools/memory-server.test.js`

- [ ] **Step 5: 注册工具**

`memory-tools.js` 导出 `registerMemoryTools(ctx, { memoryUrl, scopeOf })`，用 `ctx.tools.register(defineTool({...}))`，工具失败返回结构化错误，不抛到 agent。

- [ ] **Step 6: 备份**

---

### Task 7: 人格 prompt 与 profile 配置

**Files:**
- Create: `personas/whale-agent.md`（从 `config.persona.customPrompt` 迁移，保留原文）
- Modify: `plugins/wechat-adapter/index.js`（启动时读文件，`ctx.systemPrompt.section` 注入）
- Modify: `~/.dsh/profiles/whale-agent/cordis.patch.yml`

**Interfaces:**
- Produces: 每个 agent 的系统提示包含人格段；不含旧 bot 的工具规则。

- [ ] **Step 1: 写失败测试**

读 `personas/whale-agent.md`，断言长度 > 200 且包含“主人”“引用”两个关键词；缺文件时报错。

- [ ] **Step 2: 实现注入**

plugin apply 时读文件一次；`ctx.systemPrompt.section({ name:'whale-persona', order: 100, text: persona })`；文件改动需重启 profile（写进 runbook）。

- [ ] **Step 3: 验证**

`dsh --profile whale-agent --dump-config` 看到 section；跑一条“你是谁”确认口吻。

---

### Task 8: shadow 验收与 runbook

**Files:**
- Create: `docs/superpowers/plans/p2-runbook.md`
- Modify: 无生产代码

- [ ] **Step 1: shadow 模式切流**

桥接 `bot_url` 指向 adapter；`core.mode=shadow`；确认旧 bot 正常回复、adapter 日志有 agent 结果。

- [ ] **Step 2: 收集 50 条指标**

记录：adapter 延迟、agent 输入/输出 token、与旧 bot 回复差异、失败/回退次数。

- [ ] **Step 3: 切 active**

`core.mode=active`；观察 24h；`/rollback core` 演练一次。

- [ ] **Step 4: 更新设计文档**

把实测数据写回 `docs/superpowers/specs/2026-11-02-whale-agent-adapter-design.md` 的验收节。
