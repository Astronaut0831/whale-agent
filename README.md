# 鲸鲸 · Whale

DSH-native 微信陪伴机器人：微信群 / 私聊 / GUI 共用一套人格与长期记忆。

> 状态：**迁移硬化中，尚未达到“克隆即用”**。
> 目标平台：Windows 10/11 + DSH 0.2.x + 微信 4.x。
> 新栈可用；旧 `server.js` 栈保留为 legacy，不参与日常启动。

## 架构

```text
微信客户端
  └─ examples/wechatauto_bridge.py   (UIA + 只读 DB 监听)
       └─ wechat-adapter :8788
            ├─ 群聊 ──> headless DSH agent ──> memory-core / memory-tools
            ├─ 主子私聊 ──> GUI broker :3080 ──> GUI target session
            └─ outbox ──> bridge ──> 微信

DSH GUI :3080
  └─ web profile ──> target session ──> persona + memory tools

memory-server :8791
  ├─ /observe ──> memory-episodes.jsonl
  ├─ digest worker (5 min) ──> memories.json + digest-state + narrative
  ├─ /recall ──> memories.json + embedding :8790
  └─ /memory/backup /restore ──> data/backups
```

详细架构与缺口：

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/PROFILES.md`](docs/PROFILES.md)
- [`docs/GITHUB.md`](docs/GITHUB.md)
- [`docs/superpowers/specs/2026-11-03-p4-parity.md`](docs/superpowers/specs/2026-11-03-p4-parity.md)
- [`docs/superpowers/specs/2026-11-03-p1-p4-status.md`](docs/superpowers/specs/2026-11-03-p1-p4-status.md)

## 已可用

- 微信私聊 / 群聊文本
- 群 @ 与群注意力
- 图片 / 表情理解（DSH image block）
- 文件发送 `/sendfile`
- 后台任务 `/task`
- 提醒
- 长期记忆：事实、来源、digest、叙事线、召回
- 主动关心（模型判断；不再固定死时间窗）
- 上线 / 下线开关
- bridge / watchdog / 定时备份自愈
- GUI target 的 persona + system-context + memory tools

## 已知缺口

- GUI 输入还没有统一走 broker（P3 未完成；不要重新安装固定 target 的 GUI 插件）
- 非主人私聊、群主动话题、真实 `/dl` 还没有完成全部真实验收
- 旧 `server.js` / `src/bot.js` / `legacy/web/` / `legacy/scripts/` 仍在仓库中，属于 legacy
- target/token 已迁移到 `data/runtime.json`（profile 只留空 fallback）；GUI 已重启，target system-context 仍需行为级验收
- 备份已补齐 memory 原始文件；仍需定期做真实恢复演练
- 语音、天气、媒体、旧 Web UI：optional / retired

## 目录

```text
plugins/wechat-adapter/       新微信适配器（命令、群策略、broker、headless）
plugins/whale-memory-core/    观察 turn/end，写入 memory-server
plugins/whale-memory-tools/   注册 memory_recall / add / correct
plugins/whale-system-context/ 规矩/自省 → systemPrompt
plugins/whale-persona/        人设 → systemPrompt
tools/start-all.ps1           幂等启动
tools/adapter-watchdog.ps1    进程级自愈
tools/memory-server.js        记忆 HTTP 服务
tools/backup-memory.ps1       每日快照
src/memories.js               事实库 / 召回 / audience
src/digestCore.js             摘要与事实抽取
examples/wechatauto_bridge.py 微信桥
docs/                         架构、运行、历史记录
legacy 文件                   旧 server.js / bot.js / old web（不参与启动）
```

## 环境要求

- Windows 10/11（微信 UIA / 数据库监听）
- Node.js 22+
- Python 3.10+（bridge）
- DSH CLI 0.2.x
- 微信 4.x，且与本机登录账号匹配
- 可选：本地 embedding 服务 `:8790`（缺失时召回退回关键词）

如果微信或 Python 不在默认路径：

```powershell
$env:WHALE_WECHAT_EXE = "C:\Path\To\Weixin.exe"
$env:WHALE_PYTHON = "C:\Path\To\python.exe"
```

## 快速开始

1. 复制配置并填值：

```powershell
Copy-Item config.example.json config.json
```

至少填写：

- `deepseek.apiKey`
- `gateway.wechat.inboundToken`（bridge 与 adapter 共用）
- `wechat.listen.groups` / `privates`
- `persona.master.wxids`

2. 准备 DSH profiles（本仓库不含机器专属 profile）：

- `whale-agent`：加载 `@whale/wechat-adapter`
- `whale-headless`：persona + memory-core + memory-tools + system-context
- `whale-headless-task`：同上，但开启 workspace 文件工具
- `web`：GUI persona + memory-core + memory-tools（target session）

profile 示例与安装步骤见 [`docs/PROFILES.md`](docs/PROFILES.md)。

3. 启动服务：

```powershell
npm start
```

4. 打开 GUI：

```powershell
dsh --profile web --port 3080 --no-open
```

5. 健康检查：

```powershell
npm run doctor
```

## 常用命令

```text
/help                    命令
/status                  状态
/offline /online         全局下线 / 上线
/task ...                后台任务
/sendfile <path>         发文件
/dl <url>                下载到 workspace
/remind ...              提醒
/care on|off             主动关心
/proactive on|off        群主动话题
/facts ...               长期事实
/backup ...              记忆快照
```

## 测试

```powershell
npm test
```

只跑新栈：adapter、memory、context、GUI-input 测试。
旧栈测试仍保留：

```powershell
npm run legacy:test
```

## 安全

- `config.json`、`data/`、profile、日志、数据库均不入库
- `/api/gui/input` 仅 loopback
- `/run` 仅主人，必须 `--yes`，限 workspace、15 秒
- `/dl` 仅主人，http/https，20 MB
- 默认 headless 无文件工具；task 专用 profile 才有
- 不要重新安装 `whale-fixed-session` / `whale-gui-input` 到默认 web profile

## Legacy

旧 v3 README 在 [`docs/legacy/README-v3.md`](docs/legacy/README-v3.md)，迁移残留清单在 [`legacy/README.md`](legacy/README.md)。
旧入口仍可通过 `npm run legacy:start` 手动启动，**日常不要运行**；`start-all` 不再启动 8787。

## License

MIT
