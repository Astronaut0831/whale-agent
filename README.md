# 鲸鲸 · Whale

DSH-native 多端陪伴机器人：微信、QQ、GUI 共用同一套人格与长期记忆。

> 状态：**自托管，不是克隆即用**。
> 目标平台：Windows 10/11 + DSH 0.2.x + 微信 4.x + SnowLuma OneBot。
> 微信走本机 UI/DB bridge；QQ 走个人号 SnowLuma transport-only。

## 架构

```text
微信客户端
  └─ examples/wechatauto_bridge.py
       ├─ 微信 DB 只读监听
       ├─ UIA 发送
       └─ POST /webhook/wechat ─┐
                                │
QQ（SnowLuma OneBot）           │
  └─ qq-bridge                  │
       └─ POST /webhook/qq ─────┤
                                ▼
                    platform-adapter :8788
                       ├─ access / 命令 / 群策略
                       ├─ gui-broker / headless DSH
                       └─ outbox → 平台 bridge
                                │
                    DSH GUI :3080 / whale-headless
                       ├─ persona
                       ├─ memory-core / memory-tools
                       └─ system-context
                                │
                    memory-server :8791
                    embedding :8790
```

控制台：

```text
http://127.0.0.1:3100
监控 / access allowlist / 平台上下线 / 全局人设
```

详细结构、坑位和文件速查见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 已实现

- 微信私聊 / 群聊文本、图片、表情、文件
- 微信快速连发合并（900ms，同会话；群聊仅同发送者）
- 群 @ / 群注意力 / 静默策略
- QQ 个人号（SnowLuma OneBot → transport-only）
- 主人 QQ 私聊映射到微信主人记忆 scope
- 长期记忆：episode、事实、来源、digest、叙事线、召回
- 人格只注入鲸鲸会话，不污染 coding / 工具会话
- 提醒、主动关心、群话题
- 动态 `/help`；控制台管理 `/listen`、`/online`、`/offline`、`/persona`
- 官方 QQ 插件已停用，避免第二套 agent

## 快速开始

### 1. 配置

```powershell
Copy-Item config.example.json config.json
```

至少填写：

- `deepseek.apiKey`
- `gateway.wechat.inboundToken`
- `wechat.listen.groups` / `privates`
- `persona.master.wxids`

`config.json`、`data/`、profile、数据库和日志都不入库。

### 2. DSH profiles

本仓库不包含机器专属 profile。需要准备：

```text
whale-agent          platform-adapter :8788
whale-headless       普通 headless：persona + memory
whale-headless-task  带 workspace 工具的 headless
web                  DSH GUI :3080
```

示例见 [`docs/PROFILES.md`](docs/PROFILES.md)。

### 3. 启动

```powershell
npm start
```

实际入口是 [`tools/start-all.ps1`](tools/start-all.ps1)。启动顺序：

```text
GUI :3080 → adapter :8788 → memory :8791 → 微信 bridge
```

QQ 需要另起 SnowLuma 和 `qq-bridge`（默认在 `D:\dsh-workspace\research\qq-bridge`）：

```text
D:\SnowLuma\launcher.bat           # :3000/:3001/:5099
cd D:\dsh-workspace\research\qq-bridge
npm start                          # transport-only
```

### 4. 控制台

`npm start` 已经会顺带拉起控制台。手动启动只用于调试：

```powershell
cd tools/platform-console
npm install
npm run build
npm start
```

打开 `http://127.0.0.1:3100`。

### 5. 健康检查

```powershell
npm run doctor
```

## 常用命令

```text
/help                    动态命令列表
/status                  运行状态（主人）
/mute /unmute            群闭麦
/talk 少|正常|多          群说话频率
/corpus on|off           群语料
/proactive on|off        群主动话题
/care on|off             主动关心
/remind                  提醒
/behavior /pref          行为与规矩
/facts /memory           长期记忆
/backup                  记忆快照
/task                    后台任务
/set /digest /usage      配置 / 摘要 / 用量
```

控制台专有：

```text
/listen /online /offline /persona
```

已移除：

```text
/agent /ls /sendfile /dl /run
```

文件/脚本操作交给 agent 工具；不再通过聊天命令执行。

## 测试

```powershell
npm test
```

当前维护测试：

```text
97 项通过
```

CI：GitHub Actions，Ubuntu + Windows，Node 24。

## 安全与边界

- 个人微信 / QQ 自动化都不是官方接口，有账号风险；只用小号测试。
- 微信 UIA 发送仍可能在不可靠窗口上回退前台；多账号时未确认窗口会拒绝发送。
- 控制台只绑定 `127.0.0.1`，没有额外鉴权；不要暴露到公网。
- QQ allowlist 默认拒绝，需在控制台显式允许群/私聊。
- 记忆按 scope 隔离：群与群、群与私聊不混；主人微信/QQ 私聊共享。

## 文档

- [架构](docs/ARCHITECTURE.md)
- [Profiles](docs/PROFILES.md)
- [微信接入](docs/接入微信.md)
- [Gateway](docs/GATEWAY.md)
- [记忆设计](docs/memory-vs-brain.md)
- [GitHub 发布](docs/GITHUB.md)

## License

MIT
