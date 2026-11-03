# 鲸鲸当前架构

> 更新时间：2026-11-03
> 目标：统一、独立、可发 GitHub。当前仍是迁移硬化中，legacy 栈尚未删除。

## 1. 运行时拓扑

```text
微信客户端
  └─ examples/wechatauto_bridge.py
       ├─ UIA 发送
       ├─ 微信 DB 只读监听
       └─ POST /webhook/wechat
            └─ wechat-adapter :8788
                 ├─ commands / mute / group policy
                 ├─ 群聊 → headless agent
                 ├─ 主子私聊 → GUI broker :3080
                 └─ outbox → bridge → 微信

DSH GUI :3080 / web profile
  └─ target session
       ├─ whale-persona (systemPrompt)
       ├─ whale-memory-core (observe)
       └─ whale-memory-tools (工具)

memory-server :8791
  ├─ /observe → memory-episodes.jsonl
  ├─ digest worker (5 min) → memories / digest-state / narrative
  ├─ /recall → memories.json + embedding :8790
  ├─ /memory/backup /restore → data/backups
  └─ /narrative
```

## 2. 会话与 scope

| 路径 | 运行时 | scope |
|---|---|---|
| 群聊 | headless | `wechat:g:<chatId>` |
| 主人私聊 | GUI broker | `gui:whale` |
| 非主人私聊 | headless | `wechat:u:<wxid>` |
| GUI 其它会话 | 直接 DSH | 无 persona/memory 注入（只对 target） |

## 3. 上下文层

- 人设：`whale-persona` → `systemPrompt.section`
- 规矩/自省：`whale-system-context` → `systemPrompt.section`（headless）
- 记忆：`memory_recall` 工具按需召回
- 旧 `memory-context.js` 已废弃，不再拼进 user message

## 4. 记忆模型

- `memories.json`：原子事实、来源、向量、provenance
- `memory-episodes.jsonl`：原始 turn
- `memory-digest-state.json`：digest 游标
- `narrative.json`：摘要时间线
- `tombstones/preferences/selfnotes`：边界与自省
- 召回：关系 0.6 + 重要度 0.2 + 新近度 0.2，按 audience 过滤

## 5. 控制面

- `/offline` `/online`：逻辑上线/下线，不杀进程
- `tools/bot-switch.ps1`：本地切换
- `GET/POST /api/online`：HTTP 切换（POST 需 token）
- `tools/p4-healthcheck.ps1`：只读健康检查
- `WhaleBotMaintenance`：每 5 分钟 `start-all` 自愈（wscript 隐藏）
- `WhaleMemoryBackup`：每日 03:30 快照

## 6. 当前问题（按优先级）

### P0

1. target/token 已支持 `data/runtime.json`，profile 留空；GUI 已重启并加载 web profile，但 target 行为探针尚未得到可判定结果。
2. 根目录 `server.js`、`src/bot.js`、旧 tests 已归档到 `legacy/`；主路径不再保留可启动旧栈。
3. 备份已补 episodes/digest/narrative，但真实恢复演练仍是手动的。
4. `isMaster` 已改为真实 sender；仍需端到端非主人权限回归。

### P1

5. GUI target 已接入 `whale-system-context`；profile 已加载，target 工具记录存在，但行为级 system-context 验收未完成；其它 GUI 会话仍按设计不注入。
6. `care` 与 `proactive.care` 两套配置并存。
7. 普通 headless 与 task profile 两份配置需要手工同步。
8. `legacy/` 集中存放 server.js、src-bot.js、旧 tests/web/scripts/plugins；主路径不依赖。

### P2

9. `whale-fixed-session` / `whale-gui-input` 已移到 `legacy/plugins`，未安装；仍可能被手工误装。
10. 仍有 Windows 假设；核心启动脚本已相对化，旧维护脚本还有绝对路径。
11. 旧 `tests/` 62 个测试未纳入新 CI；新栈测试独立 72 项。
12. 已有本地 git commit 和 CI 基线；尚未配置 remote/push。

## 7. 继续方向

1. 配置集中：target/token/路径进入 runtime state，不再散落 profile（已完成核心链路）。
2. 旧栈已归档到 `legacy/`；后续只做删除/保留决策，不再接回主路径。
3. GUI target 的 system-context 需要行为级验收。
4. 统一 care 配置。
5. 完成真实验收：非主人、群话题、`/dl`、图片。
6. GitHub：配置 remote、push、打 tag。
