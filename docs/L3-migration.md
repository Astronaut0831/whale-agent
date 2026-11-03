# 哦鲸鲸 L3 迁移架构（讨论稿）

> 目标：把“通用 agent 基础设施”交给 DSH，把“微信侧 + 产品行为”保留为自研，
> 最终让微信 / QQ / B站 三个入口共享同一个“自我”。

---

## 1. 目标与原则

1. **一个自我，多种在场**：人格、记忆、叙事唯一；平台差异由适配器处理。
2. **平台侧自研**：微信/QQ/B站的消息收发、媒体转换、风控，DSH 不提供。
3. **通用能力交给 DSH**：agent 循环、工具、技能、审批、计划、子 agent、上下文压缩。
4. **并行迁移**：每个阶段新旧双跑，可一键回滚。
5. **数据先行**：记忆、叙事、语料、表情库是资产，迁移不能丢。

---

## 2. 目标架构

```
微信桥接      QQ适配器      B站适配器
   │             │             │
   └──────── 统一事件协议 ──────┘
                 │
        ┌────────▼─────────┐
        │   鲸鲸核心        │
        │  DSH 会话 × N     │  ← 每个 (platform, chat) 一个会话
        │  persona / 工具    │
        │  记忆服务(HTTP)    │
        │  主动/预算/审计    │
        └────────┬─────────┘
                 │
            统一 outbox
```

- **核心**：一个 DSH profile 进程，内部多会话；
- **适配器**：只做协议翻译 + 平台能力（表情、引用、文件）；
- **记忆**：先独立 HTTP 服务，少改现有代码；后续再考虑插件化。

---

## 3. 组件清单

### DSH 现成（直接用）

| 能力 | 插件 |
|---|---|
| agent 循环 | `agent` |
| 模型/密钥 | `llm` |
| 会话持久化 | `session` |
| 人设/指令 | `agent-instructions` / `persona` |
| 文件/shell/搜索 | `tool-fs` / `tool-pwsh` / `tool-fs-search` |
| 网页 | `tool-web` |
| 技能 | `skill` / `tool-skill` |
| 子 agent/工作流 | `subagent*` / `workflow-ptc` |
| 计划/目标/待办 | `plan-mode` / `goal` / `tool-todo` |
| 定时 | `tool-schedule` |
| 权限/审批 | `approval` / `permission` |
| 压缩/预算 | `compaction-basic` / `token-meter` |

### 自研（保留）

1. 微信桥接（UIA 收发、截图、文件、只读 DB）
2. 统一记忆服务（origin/privacy、事实、偏好、叙事、披露审计）
3. 表情服务（识别、盗图、发送）
4. 统一 outbox + 文件清理
5. 产品行为：群/私聊判断、说话频率、语料、主动关心、提醒
6. 平台适配器：QQ、B站（后续）

### 要新写

| 组件 | 作用 |
|---|---|
| `wechat-adapter` | 消息→核心，回复→outbox |
| `memory-api` | recall/remember/narrative/audit |
| `sticker-tools` | send_sticker / 盗图入库 |
| `proactive-scheduler` | schedule 触发 care/群话题/报备 |
| `platform-router` | sessionKey 映射与并发控制 |

---

## 4. 接口契约（第一阶段冻结）

### 4.1 入站事件

```json
{
  "platform": "wechat|qq|bilibili",
  "chatType": "private|group",
  "chatId": "...",
  "senderId": "...",
  "senderName": "...",
  "text": "...",
  "media": [{"kind":"image|file|sticker","path":"...","mime":"..."}],
  "mentions": ["..."],
  "quote": {"sender":"...","text":"..."},
  "ts": 0,
  "raw": {}
}
```

### 4.2 出站

```json
{
  "bubbles": ["..."],
  "files": ["..."],
  "sticker": {"emotion":"...","path":"..."},
  "quote": true,
  "delayMs": 0
}
```

### 4.3 记忆 API

```
POST /memory/recall   { scope, query, limit }
POST /memory/add      { origin, kind, text, weight }
POST /memory/narrative{ session, title, lines }
POST /memory/audit    { actor, action, detail }
```

- `scope` = `platform:chatType:chatId` / `master` / `global`
- 隐私规则在记忆服务内部执行，核心只拿结果。

### 4.4 会话键

```
sessionKey = `${platform}:${chatType}:${chatId}`
```

---

## 5. 身份与隐私模型

1. 每个会话独立上下文，避免群聊串味；
2. 共享记忆带 `origin`，默认只回本会话；
3. **跨平台连续只对主人开放**（把主人的各平台账号绑定到同一 person）；
4. 群友之间不共享；同一平台不同群不共享；
5. 披露审计与现在一致。

---

## 6. 数据迁移

| 现有 | 去向 |
|---|---|
| `bot.db` 消息 | 保留为归档；核心不再直接读 |
| `facts/prefs/selfnotes` | 迁入记忆服务（加 origin） |
| `narrative.json` | 迁入记忆服务 |
| `persona.customPrompt` | 迁入 profile 人设插件 |
| `corpus/*.jsonl` | 保留，作为独立语料 |
| `stickers/*` | 保留，工具直读 |
| `outbox` | 保留 |
| `behavior.json` | 迁入核心行为参数 |

---

## 7. 阶段步骤

### P0 冻结接口与盘点（1~2 天）

- 产出：`docs/interfaces.md`、功能迁移矩阵（保留/移植/丢弃）
- 动作：定事件/记忆/outbox 契约；列出所有现有行为
- 验收：矩阵无遗漏，接口评审通过

### P1 DSH 内核验证（2~3 天）

- 建 profile `wechat-agent`：persona + tool-web/fs/pwsh/skill/subagent/plan
- 手动喂 5 条真实消息
- 验收：能查、能看链接、能落文件；记录 p95 延迟与单条成本
- 回滚：删 profile，不影响现有 bot

### P2 微信适配器 + 主人私聊双跑（约 1 周）

- 网关改为：入站 → 核心；核心 → outbox
- 只把**主人私聊**路由到核心，群聊仍走旧 bot
- 记忆先走 HTTP 工具
- 验收：一周无回归；`/rollback` 一键切回
- 回滚：路由开关切回旧 bot

### P3 记忆与隐私对齐（1~2 周）

- 移植 origin/privacy、叙事、偏好、审计
- 每 chat 一个 DSH 会话
- 验收：隐私测试全过（跨群不可见、主人跨平台可见）
- 回滚：记忆服务灰度，旧逻辑仍在

### P4 群聊 + 主动 + 表情（1~2 周）

- 群会话、语料、频率档位、care/群话题、sticker 工具
- 验收：与旧 bot 行为清单逐项对比
- 回滚：按群开关

### P5 QQ 适配器（约 1 周）

- 选型：OneBot 小号 / QQ频道官方
- 验收：私聊 + 一个群跑通，限频生效

### P6 B站实验（约 1 周）

- 只读：浏览器看视频/评论 + 定时报备
- 验收：连续 7 天无风控异常，报备质量可接受

### P7 退役旧 bot

- 旧 Node bot 只保留桥接/outbox/sticker 服务
- 监控、备份、回滚脚本就绪

---

## 8. 风险与闸门

| 风险 | 闸门 |
|---|---|
| DSH 升级破坏 | 锁版本；升级前跑回归清单 |
| 延迟/成本上升 | P1 必须测出数据；预算闸 |
| 记忆迁移丢失 | 双写 + 对账 |
| 核心单点 | 守护进程 + 自动重启 |
| 平台风控 | 限频、小号、只读起步 |

---

## 9. 待决策

1. 记忆：**独立 HTTP 服务**（推荐先）还是直接写 DSH 插件？
2. 会话：每 chat 一个（推荐）还是每用户一个？
3. 审批：危险工具默认拒绝，主人私聊文本 `/approve` 放行？
4. QQ：OneBot 小号还是官方/频道？
5. B站：只读报备，还是允许私信/评论？
6. 迁移节奏：先 P1 验证，还是直接 P2 双跑？

---

## 10. 估算

- 技术验证 P0-P1：3~5 天
- 主人私聊双跑 P2：约 1 周
- 记忆/隐私 P3：1~2 周
- 群聊/主动/表情 P4：1~2 周
- QQ/B站 P5-P6：各约 1 周
- 总计（业余推进）：约 5~7 周
