# 旧 bot 迁移审计

日期：2026-11-02 21:40
范围：`server.js` 路由、`src/*.js` 模块、`tools/start-all.ps1`、`tools/rollback-legacy.ps1`、`adapter-watchdog.ps1`、adapter 实际能力。

## 已迁移

| 能力 | 入口 |
|---|---|
| 私聊文本回复、气泡、outbox、发送 | adapter `/webhook/wechat`、`/api/core/send`、`/api/bridge/outbox*` |
| 记忆摘要/巩固/再巩固/叙事/复习 | `src/digestCore.js`、episode-runtime、memory server、`/correct-auto` |
| 图片理解 | adapter `/api/vision` → `src/vision.describe` |
| 表情包发送链路 | adapter StickerService + `send_sticker` 工具 |
| 主动关心接口 | adapter `/api/care*` → `src/care`；默认关闭，可 `/proactive on` 开 |
| 群聊注意力 | `src/attention.js` + `lib/group-policy.js`/`group-history.js` |
| 群聊 DSH 回复 | 群 session + outbox，实测 test 群发送成功 |
| `/task` 后台任务 | adapter 复用 `src/tasks.js`；`/task list/cancel/<指令>`；worker 固定 `whale` 工作区 + `task:` session；完成/失败入 outbox |
| 链接阅读 | adapter 检测消息 URL，调用 `src/links.describeLink`，摘要注入 agent 消息 |
| `/api/share` 视频分享 | adapter 复用 `src/bilibili.js` 的 `pickVideo/pickByKeyword/fetchComments`，实测返回视频 |
| 基础管理命令 | `/help`、`/status`、`/mute [分钟]`、`/unmute`、`/talk 少/正常/多`；mute 同时拦私聊和群；talk 改注意力阈值 |
| `/listen` | adapter 读写 `config.wechat.listen`；chats/blocked/list/add/del/on/off；桥接 5 秒热更新 |
| `/corpus` | 写 `wechat.groupSettings[chatId].collect`；群消息按开关 append 到 `data/corpus/<chatId>.jsonl` |
| 主动关心 | `/proactive on|off` 写 `care.enabled`，adapter `/api/care*` + 桥接 5 秒热更新 |
| 提醒 | `/remind` 列表/取消；adapter 复用 `src/proactive.js`；20 秒扫到期提醒入 outbox |
| 自然语言提醒 | 主人私聊「提醒我…」由 `parseReminder` 解析后入提醒队列 |
| selfnote | adapter 复用 `data/selfnotes.json`；首次或隔 >2h 注入 `selfnote.block(5)`，状态写 `selfnote-state.json` |
| selfedit | `/selfedit on|off|status|<提案>`、`/approve edit <id>`、`/deny edit <id>`；复用 `src/selfedit.js`，默认关闭 |
| behavior/prefs/persona | `/behavior set|reset` 复用 `src/behavior.js`，影响冷却/气泡数；`/pref add|list|del` 复用 `src/prefs.js` 并每轮注入；`/persona show|set` 写 persona 文件并保留 Agent 规则段 |
| `/facts` / `/memory` | adapter → memory server `/facts`；列表/搜索/详情/删除/恢复；`/memory` 走同一入口 |
| 记忆备份/恢复 | adapter → `/memory/backup`、`/memory/backups`、`/memory/restore`；实测生成快照 |
| 表情包管理 | `/api/stickers/image|delete|upload|open-folder|test` 已补，实测 image/delete/test；收表情按 `sticker.collect` 走视觉判断 |
| 旧 bot.db 私聊历史 | `tools/import-legacy-history.js` 读取 messages，按 user/assistant 配对成 episode 追加到 `memory-episodes.jsonl`；实测导入 224 条，自动备份 |
| 群起话题 | adapter 15 分钟 worker；`/proactive on` 本次武装，`/proactive off` 关闭；按 `proactive.group` 静默/时段/频率 |
| Web 状态 | `GET /api/status` 返回 mode/uptime/workspace/memory/stickers/tasks |
| USB 自动备份 | `usb.startAuto` 接入 adapter，按 `memory.usb.dir` 每分钟检查 |

## 未迁移（按优先级）

1. **剩余管理命令（非目标 11 必需）**：`/set`、`/digest`、`/usage`、`/sendfile`、`/dl`、`/ls`、`/run`、`/reset`、`/agent` 未迁；其中很多能力由 DSH 原生工具/GUI 提供。
2. **旧 Web UI 专用接口（有意不迁）**：`/api/config`、`/api/settings`、`/api/debug/*`、`/api/wechat/accounts*`、`/api/chat`、`/api/digest/run`；DSH GUI 已替代，必要的 `/api/status` 已补。

## 源码检查发现并修复

1. **`start-all.ps1` 会复活旧 server**
   - 原第 84-90 行会在 8787 启动 `server.js`，开机/重启后重新引入双大脑和双写。
   - 已改为启动 adapter（8788）、memory（8791）、bridge、watchdog；不再启动 8787。
   - 已验证 `start-all -Quiet` 后 8787 仍 down。

2. **`rollback-legacy.ps1` 回退不完整**
   - 原脚本只改 bridge URL，不启动旧 server，也不停 memory/adapter/watchdog；回退后 8787 不可达，且记忆会双写。
   - 已改为：停 watchdog → 停 adapter/memory → 移除 `WHALE_BOT_URL` → 启动 `server.js` → 重启 bridge → 检查 8787。
   - 只做了语法检查，没有实际执行回退。

3. **watchdog 可重复启动**
   - 实测出现两个 watchdog，会竞争重启 adapter/bridge。
   - 已加全局 Mutex `Global\WhaleAdapterWatchdog`，第二个实例立即退出。

## 仍需注意

- `server.js` / `run-server.bat` 保留，仅用于 deliberate rollback；不要再加入 `start-all`。
- 若手动启动 8787，必须同时停 memory worker（遵循 rollback 脚本），否则两份 `memories.json` 写入会丢更新。
- `start-all` 需要 `dsh` 在 PATH、`config.json` 有 DeepSeek key；没有 key 时 adapter 不会启动。
- 回退后再迁移：需要重新给 `run-bridge.bat` 加 `WHALE_BOT_URL=http://127.0.0.1:8788/webhook/wechat`，并重启 bridge；目前没有单独的反向脚本。
- `/proactive` 已按旧语义改为「群聊起话题」；个人主动关心改用 `/care`。群话题不会因重启自动武装，需要本次发 `/proactive on`。

## 最终验收（2026-11-02 22:14）

- adapter 测试 43/43，memory/import 测试 3/3；
- 8787 down，8788 adapter up，8790 embed up，8791 memory up，bridge PID 46868；
- `GET /api/status` 返回 mode=active、groupEnabled=true、stickers.enabled=true；
- legacy 历史：224 条 episode 导入，digest 首次运行新增 6 条摘要；
- `start-all.ps1` / `rollback-legacy.ps1` 语法检查通过，start-all 不再启动 8787。
