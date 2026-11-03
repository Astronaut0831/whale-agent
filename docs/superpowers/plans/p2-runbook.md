# P2 Adapter Runbook（开发期）

## 组件

- 插件：`D:\dsh-workspace\chat\whale_gril\plugins\wechat-adapter`
- Profile：`C:\Users\astronaut\.dsh\profiles\whale-agent`
- 端口：`127.0.0.1:8788`（`/wechat/ping` 健康检查）
- 旧 bot：`127.0.0.1:8787`（未改动）

## 启动

```powershell
Set-Location D:\dsh-workspace\chat\whale_gril
$cfg = Get-Content config.json -Encoding UTF8 | ConvertFrom-Json
$env:DEEPSEEK_API_KEY = $cfg.deepseek.apiKey
dsh --profile whale-agent
```

验证：

```powershell
Invoke-WebRequest http://127.0.0.1:8788/wechat/ping -UseBasicParsing
# {"ok":true,"plugin":"wechat-adapter"}
```

## Headless runner（Plan B，已验证）

`whale-agent` profile 的 adapter 配置：

```yaml
runner: headless
headlessProfile: whale-headless
```

每条消息会 spawn：

```
dsh --profile whale-headless --session-id <id> --json -
```

消息从 stdin 进入；人格由 `@whale/whale-persona` 插件注入。
首次运行不带 `--session-id`，之后复用 `data/core-sessions.json` 里的 id。

## 模式

`data/core-mode.json`：

```json
{ "mode": "off" }
```

- `off`：adapter 只代理旧 bot；
- `shadow`：旧 bot 正常回，agent 旁路记录；
- `active`：agent 接管主人私聊，失败回退旧 bot。

改动后无需重启 profile（handler 每次热读）。

## 回滚

1. 把 `data/core-mode.json` 改成 `off`；
2. 或把桥接 `WHALE_BOT_URL` 改回 `http://127.0.0.1:8787/webhook/wechat`；
3. 停 whale-agent：结束监听 8788 的进程。

## Active 已切（2026-11-02 18:11）

- `data/core-mode.json` = `{"mode":"active"}`
- 主人私聊由 headless agent 直接回复，经 `/api/core/send` → outbox → 桥接发送；
- 群聊仍代理旧 bot，行为不变；
- 切流前 shadow 真实样本 **56/50**，fallback 0；
- 冒烟：`test-active-smoke-1` → “收到了，忽略”，6.6s，桥接 18:11:24 发送成功。

### 回滚 active

一键回退（会设 off、移除桥接 WHALE_BOT_URL、重启桥接）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\rollback-legacy.ps1
```

手动：

1. 删除 `run-bridge.bat` 里的 `WHALE_BOT_URL` 行（或改成 8787）；
2. `data/core-mode.json` 改回 off；
3. 重启桥接。

## 守护（2026-11-02）

- 脚本：`tools/adapter-watchdog.ps1`
- 每 60 秒：
  - ping `http://127.0.0.1:8788/wechat/ping`，失败就重启 `dsh --profile whale-agent`；
  - 检查 8791 是否在监听，失败就启动 `node tools/memory-server.js`。
- 日志：`data/adapter-watchdog.log`、`data/adapter-stdout.log`
- 8791 无 token 返回 401 属正常（服务在监听）。

## Shadow 报告

```
node tools/shadow-report.js 10
node tools/shadow-report.js --write
```

- 自动区分真实样本（msgId 非 `test-*`）与测试样本；
- 统计 p50/p95 延迟、agent/legacy 平均长度、emoji 数；
- `--write` 落盘到 `docs/superpowers/plans/shadow-report.md`。

## Headless 记忆

两条路都通：

1. adapter 在消息前注入 `【你记得的事】`（召回；主人私聊还会带间隔复习 `【可以自然想起】`）；
2. `@whale/whale-memory-tools` 在 `agent/created` 时注册 `memory_recall/add/correct`，
   scope 来自环境变量 `WHALE_SESSION_SCOPE`，URL/token 来自 `WHALE_MEMORY_URL/TOKEN`。

### 完整记忆管线（旧 bot 移植）

- `@whale/whale-memory-core` 在每轮 `turn/end` 把对话写进 `data/memory-episodes.jsonl`（海马体）；
- `POST /digest/run` → `src/digestCore.js`：模型摘要、拆条、provenance、`bestSpan`、仲裁、叙事、长期记忆；
- `POST /consolidate/run` → 旧 `memoryConsolidate.runOnce`：机械合并、模型判重、遗忘、显著性重放；
- `POST /correct-auto`：主人纠正时 `reconsolidate.autoCorrect`，adapter 在 active 前调用；
- 间隔复习：`/recall` 在 `isMaster` 时返回 `review` 并 `markReviewed`。

后台 worker 每 5 分钟 digest、每天 03:00 后巩固。**当前 `MEMORY_WORKERS=0` 暂停**，因为旧 bot 还在写同一份 `data/memories.json`；旧 bot 下线后改成 1。

实测（临时库、真实模型）：3 轮对话 → 6 条事实，带 quote/confidence/about。

## Whale 工作区（2026-11-02 18:28）

- 她的 headless agent 工作目录：`D:\dsh-workspace\chat\whale`
- 工作区说明：`whale\AGENTS.md`
- 子目录：`notes/`、`projects/`、`tmp/`
- adapter 配置：`workspace: "D:/dsh-workspace/chat/whale"`
- 验证：在 whale 目录跑 headless，回答当前路径 = `D:\dsh-workspace\chat\whale`
- 权限：`workspace-write`；仍只接主人私聊，群聊走旧 bot。

## 旧 bot 已下线（2026-11-02 21:00）

- 8787 `server.js` 已停；旧 bot 不再回复、不再写记忆。
- adapter 自己提供：
  - `POST /api/core/send`
  - `GET /api/bridge/outbox`
  - `POST /api/bridge/outbox/ack`
  - `GET /healthz`
- 桥接只连 adapter；发送实测成功。
- `MEMORY_WORKERS=1`，记忆摘要在 adapter episodes 上跑；旧 bot 不再写同一份 `memories.json`。
- 图片理解：`/api/vision` → `src/vision.describe`，实测通过。
- 表情包：adapter 的 `StickerService` + `send_sticker` 工具，enqueue/pending/claim/ack 实测通过。
- 主动关心：`/api/care/due`、`/api/care` 已接回 `src/care`；当前 `care.enabled=false`，不会主动发。
- 群聊：`groupEnabled=true`，按旧 `src/attention.js` 打分；@/问号/点名/冷却/每小时上限/灰区模型判断已接；群聊独立 session 与记忆隔离。
- `/task`：adapter 复用 `src/tasks.js`；`/task list`、`/task cancel [id]`、`/task <指令>`；worker 5 秒轮询，固定 `whale` 工作区，完成/失败经 outbox 播报。
- 链接：消息里的 URL 先经 `src/links.describeLink` 抓摘要，再注入 agent；`/api/share` 复用 `src/bilibili.js`，实测返回视频。
- 基础命令：`/help`、`/status`、`/mute [分钟]`、`/unmute`、`/talk 少/正常/多`；mute 会拦私聊和群，talk 改群注意力阈值。
- `/listen`：直接改 `config.wechat.listen`，桥接 5 秒热更新；支持 list/chats/blocked/add/del/on/off。
- `/corpus`：写 `wechat.groupSettings[chatId].collect`，群消息按开关写入 `data/corpus/<chatId>.jsonl`。
- 主动关心：`/proactive on|off` 改 `proactive.group.enabled`（群起话题）；`/care on|off` 改 `care.enabled`（个人主动关心）；`/api/care*` + 桥接 5 秒热更新。
- 提醒：`/remind` 列表/取消；主人私聊「提醒我…」自动解析；20 秒扫到期提醒入 outbox。
- selfnote：首次或隔 >2h 注入 `selfnotes.json` 的 5 条自我观察；状态在 `selfnote-state.json`。
- selfedit：`/selfedit on|off|status|<提案>`、`/approve edit <id>`、`/deny edit <id>`；默认关闭。
- behavior：`/behavior set key value|reset`，复用 `src/behavior.js`；影响 addressed 冷却与气泡数。
- prefs：`/pref add|list|del`，复用 `src/prefs.js`；每轮把全部规矩注入消息。
- persona：`/persona show|<人设>`，写 `personas/whale-agent.md` 并保留 Agent 规则段，同时更新 config.persona.customPrompt。
- `/facts` / `/memory`：adapter → memory server `/facts`，支持列表/搜索/详情/删除/恢复。
- `/backup`：adapter → `/memory/backup|backups|restore|export`；`/backup status` 看快照，`/backup restore <name>` 恢复，`/backup export` 导出脱敏 bundle；`/backup drives` 读盘符。
- 表情包：`/api/stickers/image|delete|upload|open-folder|test` 已接；`sticker.collect=true` 时入站表情按视觉判断收进 `data/stickers`。
- 旧历史：`node tools\import-legacy-history.js --dry-run` 先看，正式导入会备份 `memory-episodes.jsonl`；默认只导私聊（`--all-scopes` 可改）。
- `/task`、`/mute`、`/listen`、`/talk`、`/corpus`、`/proactive`、`/care`、`/remind` 已迁；群话题 `/proactive` 需本次 on 才武装。
- GUI 固定会话：`web` profile 装 `@whale/whale-fixed-session`，打开即 `<SESSION_ID>`；memory-core/memory-tools 仅在该 session 写入/注册，persona 也只在该 session 注入。详见 `docs/superpowers/specs/2026-11-03-gui-fixed-session.md`。
- API broker：adapter → GUI `session/prompt`，回复从 `session/list.turnOutline` 取回；默认 `guiBroker.enabled=false`。开启/回滚：`powershell -File tools\toggle-gui-broker.ps1 -On` / 不带 `-On`，然后重启 adapter。详见 `docs/superpowers/specs/2026-11-03-api-broker-constraint.md`。
- GUI 记忆验证：memory server 8791 必须在跑；`gui:whale` episode 和 `recall_memory` 已实测。

## 注意

- 插件代码改动需要重启 profile（Cordis 不是热更新）；
- 凭据只走环境变量，不写进插件；
- **bridge 现在依赖 adapter（8788）代理回旧 bot；adapter 挂了微信入站就会停**，watchdog 每 60 秒兜底；
- **桥接自重启**：`run-bridge.bat` 已改成 `:loop`，exit 7 会等 3 秒重拉（13:52 曾因缺这个循环掉线，13:52–14:07 的入站消息被启动宽限跳过，需用户重发）；
- headless runner 每条消息起一个 dsh 进程，实测单条 **5.6~6.1s**（含 agent 工具循环），shadow 期记录到 `data/adapter.log`；
- 2026-11-02 13:29 的 active 回归测试中有一条真实私聊被 active 接管，回复发到了测试 capture、旧 bot 未参与；已立即恢复 shadow，若用户当时没收到回复需重发。
- bridge 自愈：`run-bridge.bat` 任何退出都 5 秒重拉；停止重拉用 `data\bridge-stop.flag`。
- watchdog 自愈：`adapter-watchdog.ps1` 有心跳；`tools\install-autostart.ps1` 安装每 5 分钟一次的 `WhaleBotMaintenance` 计划任务，确保 watchdog 自身死了也能被拉起；卸载用 `tools\install-autostart.ps1 -Uninstall`。
- P0 记录：`docs/superpowers/specs/2026-11-03-p0-reliability.md`。
- GUI 输入：默认 web profile **不装** `whale-fixed-session` / `whale-gui-input`。2026-11-03 02:25 曾因这两个插件把所有会话锁到主会话，已紧急回滚；备份 `cordis.patch.yml.bak-emergency-20261103-022512`。GUI 输入恢复直接提交。
- 服务端 `/api/gui/input` 仍保留：loopback、`guiInput=true`、支持 body `sessionId` 按会话路由；CLI `node tools/whale-cli.mjs [--session <id>] "文本"`。不要再把 wrapper 装回默认 profile。
- `tools\rollback-gui-input.ps1` 只移除 `whale-gui-input`；紧急情况还要移除 `whale-fixed-session` 再重启 GUI。
- 2026-11-03 02:18 正确启动参数：`dsh --profile web --port 3080 --no-open`，工作目录 `D:\dsh-workspace\chat`；直接 `cmd /c dsh web` 曾导致工作区/会话列表错误。
- P4 健康检查：`powershell -File tools\p4-healthcheck.ps1`，结果写 `data\p4-healthcheck.json`；只读，不重启服务。
- 每日记忆快照：`tools\backup-memory.ps1`；安装 `tools\install-backup-task.ps1`（每天 03:30，任务 `WhaleMemoryBackup`）；卸载 `tools\install-backup-task.ps1 -Uninstall`。日志 `data\memory-backup.log`。
- 主动关心：bridge 读旧 `care.enabled`（不是 `proactive.care.enabled`），现在全天 `00:00-24:00`、`maxPerDay=0`、`quietAfterMinutes=0`、`everyMinutes=1`；`care.modelDecide=true`，每分钟由模型结合时间/上次主动/记忆判断发不发（`model_skip`/`model_ok` 写 adapter 日志）。改完重启 adapter + bridge。
- 群主动话题：adapter 启动读 `proactive.group.enabled`；以前 `groupProactiveArmed` 硬编码 false，已修。手动 `/proactive on|off` 立即生效。
- 任务静默：`WhaleBotMaintenance` / `WhaleMemoryBackup` 已改成 `wscript.exe` 调 `tools\*-hidden.vbs`，避免每 5 分钟/每日闪 cmd 窗口；安装脚本同步使用 VBS。
- bridge 重复：watchdog 旧进程可能加载旧的“只看 Python”检测，重启 watchdog 后才会识别 `run-bridge.bat` 包装进程。已清理旧包装并重启；排查时看 `run-bridge.bat` 数量，正常应为 1。
- 上线/下线开关：主人微信发 `/offline` / `/online`；本地 `powershell -File tools\bot-switch.ps1 -Action status|off|on`；HTTP `GET/POST /api/online`（POST 需 `x-bot-token`）。状态存 `data\bot-online.json`。下线只停止回复与主动/提醒/task，不杀 adapter/bridge；`/online` 仍可把它叫回来。
- P1–P4 状态：`docs/superpowers/specs/2026-11-03-p1-p4-status.md`；P4 parity：`docs/superpowers/specs/2026-11-03-p4-parity.md`。
