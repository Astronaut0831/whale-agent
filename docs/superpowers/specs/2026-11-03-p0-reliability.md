# P0 稳定性与 GUI 长期记忆闭环

日期：2026-11-03
状态：已完成；真实微信入站、bridge/watchdog 自愈、GUI 长期记忆均已实测。

## 事故

- 00:35 后 bridge 和 watchdog 都不在了；
- 用户 01:36 发出的测试消息没有到 adapter；
- `run-bridge.bat` 只在 exit code 7 时重启，其他退出会让 cmd 结束；
- watchdog 自己退出后没有上层守护；
- `start-all.ps1` 只在手动运行时拉起 watchdog。

## 修复

### 1. bridge 自愈

`tools/run-bridge.bat`：

- 任何退出都会 5 秒后重拉；
- 保留 `data\bridge-stop.flag`：存在时正常退出并停止重拉；
- 重启记录写 `data\bridge-restart.log`。

### 2. watchdog 自愈

`tools/adapter-watchdog.ps1`：

- 每 5 个 tick 写一次 `watchdog tick` 心跳；
- 记忆服务重启时显式带 `MEMORY_WORKERS=1`；
- 继续检查 adapter / bridge / memory。

### 3. 上层守护

- `tools/start-all.ps1` 加全局 Mutex `Global\WhaleStartAll`，避免手动和计划任务并发启动；
- 新增 `tools/install-autostart.ps1`：
  - 创建 `WhaleBotMaintenance` 计划任务；
  - 每 5 分钟以当前交互用户运行 `start-all.ps1 -Quiet`；
  - 卸载：`tools\install-autostart.ps1 -Uninstall`；
  - 任务 XML 备份在 `data\task-backups`。

### 4. 验证

实测：

1. 杀掉 bridge（Python 47864 + wrapper 22516）；
2. 不手工启动，75 秒后 watchdog 拉起新 bridge 48656；
3. 日志：`[2026-11-03T01:47:13] bridge down, restarted`；
4. 杀掉 watchdog 13224；
5. 计划任务在 `01:51:02` 启动 watchdog；
6. `startup.log`：`watchdog: started`，五个服务全 up。

## GUI 长期记忆闭环

之前 `gui:whale` 只有 episode，没有 digest。手动触发：

```text
POST /digest/run {"force":true}
```

返回：

```json
{"key":"gui:whale","added":5,"digest":[
  "主人用broker注入做自测，只要求她回复“收到”",
  "她会严格按主人要求只回复指定短语",
  "主人让她用recall_memory查broker记忆，无则回“工具可用”",
  "她回复“工具可用”，表示当时未查到broker相关记忆",
  "主人要求只回复“broker已接通”，她照做"
]}
```

`/recall?scope=gui:whale` 返回了实际条目，不是只有“工具可用”。

测试结束后已清理：

- `gui:whale` episodes 0 条；
- digest state 删除 `gui:whale`；
- facts scope `gui:whale` 删到 0；
- 备份：`*.bak-testclean-*`。

## 真实微信入站确认（2026-11-03 01:55）

bridge 日志：

```text
[01:55:12] 收到 私聊 Astronaut. ← Astronaut.：自愈测试：只回复收到
[01:55:13] 已连上鲸鲸服务 http://127.0.0.1:8788
[01:55:16] 发送成功 → Astronaut.
```

adapter 日志：

```json
{"ts":1793642113674,"kind":"gui-broker","sessionId":"<SESSION_ID>","text":"收到"}
```

- 这条消息在 bridge 被自动拉起之后真实入站；
- adapter 走 API broker，不是旧 bot；
- outbox 已由 bridge 发送；
- 目标 GUI session 处理并返回“收到”；
- 该测试 episode 已清理（备份 `*.bak-p0test-*`）。

## P1/P2 仍未做

- GUI 自身输入与 broker 的跨进程单写者锁；
- 群聊/非主人/任务统一到同一个 GUI session；
- 旧命令 `/set`、`/digest`、`/usage`、`/sendfile`、`/dl`、`/ls`、`/run`、`/reset`、`/agent`；
- 固定目标 session 的自动创建/恢复；
- 真实回滚演练。
