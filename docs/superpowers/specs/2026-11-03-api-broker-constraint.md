# API Broker 约束与设计

日期：2026-11-03
状态：设计已定，实现待做；目标 `goal-63ec1c1e...` 已从 broker-lite 改为 API broker。

## 实测硬约束

在 `D:\dsh-workspace\chat` 用 target session 直接 headless resume：

```powershell
dsh --profile whale-headless --json --session-id <SESSION_ID> "只回复：resume ok"
```

结果：

```json
{"type":"error","message":"session \"<SESSION_ID>\" is already owned by an active write handle"}
```

原因：固定 GUI 会话正被 3080 的 DSH web 进程持有写句柄。DSH 不允许第二个进程 resume 同一 session。

结论：**broker-lite（adapter 自己 headless resume target）不可行**。必须把消息送给持有句柄的 GUI 进程。

## 已验证的可用通道

GUI web 暴露 `session/prompt` RPC。实测请求：

```json
{
  "type": "client-request",
  "rpcId": "p8",
  "method": "session/prompt",
  "payload": {
    "args": {
      "request": {
        "requestId": "selftest8",
        "sessionId": "<SESSION_ID>",
        "mode": "queue",
        "content": [{ "type": "text", "text": "自测：只写入鲸鲸会话记忆" }],
        "clientTimeZone": "Asia/Shanghai"
      }
    }
  }
}
```

返回：

```json
{"type":"server-response","rpcId":"p8","result":{"ok":true,"value":{"accepted":true}}}
```

认证方式：

1. 先 `GET /?token=<web token>` 建立 `dsh-auth-*` cookie；
2. 后续 `POST /api/session/prompt` 带 `Content-Type: application/json` 和该 cookie；
3. `body` 必须是合法 JSON（PowerShell `Set-Content -Encoding UTF8` 会带 BOM，要用 `UTF8Encoding(false)`/Node 写）。

关键 RPC 约定：

- `payload` 只能包含一个 `args` 字段；
- `args` 的字段名来自方法 descriptor：`session/prompt` 是 `request`，`session/list` 是 `_request`；
- `session/list` 也验证通过，可用于拿 `running`/`updatedAt`。

## 方案选择

### A. API broker（选定）

- 微信 bridge → adapter → 本机 GUI `/api/session/prompt` → target session。
- 不 spawn 第二个 dsh，不抢写句柄。
- 回复获取候选：`session/page` / `session/follow` / `session/projections`，需要下一轮验证。
- 单写者队列仍在 adapter 内，按 sessionKey 串行。
- 开关默认关闭，失败直接回退到现有独立 session。

### B. 关闭 GUI 后 headless resume（拒绝）

- 可行但 GUI 不能同时在线，违背“多端同一会话”。

### C. 外部 broker 拥有 session，GUI 只做客户端（未来）

- 最彻底，但要改 GUI 输入路径和会话所有权；当前不做。

## 可逆措施

- broker 开关默认 `false`；
- 只新增 `lib/gui-broker.js` / 配置，不覆盖原 adapter 会话映射；
- 失败/超时/未开开关 → 走原路径；
- 改 profile 前备份，保留 `*.bak-*`；
- 不修改 DSH session 存储格式。

## 已实现（2026-11-03 01:08）

- `plugins/wechat-adapter/lib/gui-broker.js`
  - 303 认证：`redirect: 'manual'` 捕获 `dsh-auth-*` cookie
  - `session/prompt` 用 `payload.args.request`
  - 回复：轮询 `session/list` 的 `projections.values.turnOutline`，取 `seq > beforeSeq` 的 response
  - 同一个 broker 实例内 promise 链串行
- adapter 接入：
  - `guiBroker.enabled` 默认 `false`
  - 仅主人私聊、非 `/` 命令走 broker
  - 成功：回复拆气泡写入 outbox
  - 失败/超时/未开开关：记录 `gui-broker-fail` 后回退原链路
  - token 优先 config，否则每次从 `guiBroker.tokenFile`（默认 `data/gui-3080.log`）解析
- 测试：`plugins/wechat-adapter/test/gui-broker.test.js` 4/4；adapter 回归 10/10
- 真实端到端（不经过微信）：
  - `tools/broker-live-test.mjs`
  - 输出 `text: "收到"`，`turn: 3`，`seq: 45`
  - 证明注入 GUI 持有写句柄的 target session 可取回回复

## target 记忆验证（2026-11-03 01:11）

- 3080 的 five plugins 均为 `active`；
- 用 `pluginManager/setPluginEnabled` 关-开 `include:whale-memory-core`，无需重启 3080；
- 日志确认 plugin config 正确：
  `targetSessionId=<SESSION_ID>, scope=gui:whale, envScope=''`
- 日志确认 memory-core 收到目标 session 的 `turn/end`；
- 真实 broker turn 5 之后，`memory-episodes.jsonl` 写入：

```json
{"scope":"gui:whale","user":"自测：broker 注入，只回复收到。","assistant":"收到","ts":...}
```

- 让 GUI agent 调 `recall_memory`，返回“工具可用”（memory server 已恢复）；
- 之前 episode 没写出的根因是 memory server 8791 意外停了，不是 memory-core 门控。

## 未完成

- GUI 自身输入与 broker 的并发锁仍未加；目前只能靠 `mode: queue`，不是完整单写者。
- broker 尚未在 adapter 生产配置中开启（目标要求默认关闭，需用户确认后再开）。

## 开关 / 回滚

adapter profile 已写入：

```yaml
guiBroker:
  enabled: false
  url: "http://127.0.0.1:3080"
  tokenFile: "D:/dsh-workspace/chat/whale_gril/data/gui-3080.log"
  sessionId: "<SESSION_ID>"
  timeoutMs: 120000
```

- 开启：`powershell -File tools\toggle-gui-broker.ps1 -On`，重启 adapter；
- 回滚：`powershell -File tools\toggle-gui-broker.ps1`，重启 adapter；
- 脚本每次先备份 profile 为 `*.bak-guiBroker-*`；
- 不开启时 adapter 完全走原链路。
