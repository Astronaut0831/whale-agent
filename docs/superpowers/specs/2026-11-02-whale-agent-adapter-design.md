# 哦鲸鲸 Agent 化（C 方案）设计

> 日期：2026-11-02
> 状态：待批准
> 关联：`docs/L3-migration.md`、`docs/memory-vs-brain.md`

## 1. 意图

让哦鲸鲸**本人成为一个真正的 DSH agent 会话**：

- 她的思考、工具调用、计划、技能、子 agent、记忆读写，全部走 DSH 原生 agent loop；
- 微信只是她的输入输出通道，不再由旧 Node bot 的 prompt 拼装和工具循环代劳；
- 旧 bot 降级为“桥接 + outbox + 回退通道”，不再拥有“她是谁”的逻辑。

一句话：**不是让旧 bot 调用 DSH，而是让 DSH 里的她直接活在微信里。**

## 2. 目标

1. 主人私聊先跑通：微信消息 → DSH 会话 → agent 回复 → 微信发出；
2. 她拥有与 DSH 一致的 agent 能力：工具、技能、计划、子 agent、上下文压缩；
3. 人格、记忆、表情、主动行为逐步迁成 DSH 插件/工具，不再散落在旧 bot；
4. 全程可回滚：一键切回旧 bot，不丢消息、不重复回复；
5. 影子模式先观察，再切正式。

## 3. 非目标（本期）

- 不迁移群聊、QQ、B 站；
- 不重写微信桥接（UIA 收发、图片、文件继续用现有 Python 桥）；
- 不改记忆服务内部算法（只加 HTTP/工具接口）；
- 不做主动关心、群话题、盗图入库的完整迁移；
- 不追求“改插件代码即时热更新”。

## 4. 反目标

- 做成“旧 bot 里再包一层 DSH 调用”，人格和判断仍在旧代码里；
- 为了 agent 化牺牲稳定性：消息丢、重复回、隐私串群；
- 把危险工具默认全开且无审批；
- 切换后无法回退。

## 5. 约束

- 现有 bot 在 C 跑通前保持在线；
- 主人私聊优先，群聊不动；
- 记忆隐私规则（origin/privacy、跨会话仅主人）必须保持；
- 每条消息最多一次回复，重试不能重复发送；
- 桥接仍是唯一 UIA 发送方；
- 插件代码改动需要重启 profile，按“重启便宜”设计。

## 6. 方案选择

| 方案 | 做法 | 取舍 |
|---|---|---|
| A | 旧 Node 路由 + `dsh headless` 每消息一进程 | 最快，但她是“被调用的一次性任务”，不是常驻 agent |
| B | 常驻 DSH Web/API 会话服务 | 延迟低，但接口层要自己包，仍是“外部调用” |
| **C** | **自定义 Cordis adapter 插件，DSH 会话常驻，微信直连** | 工作量最大，但最接近“真正的 agent”，选 C |

## 7. 目标架构

```
微信桥接（Python/UIA）
   │  POST /wechat/inbound
   ▼
┌──────────────────────────────────────────┐
│ DSH profile: whale-agent                  │
│                                          │
│  wechat-adapter（自研 Cordis 插件）       │
│    ├─ 入站：微信事件 → DSH 会话消息       │
│    ├─ 会话：每个 (platform,chatId) 一个   │
│    ├─ 出站：agent 最终文本 → 气泡 → 桥接  │
│    └─ 幂等/回退/影子开关                  │
│                                          │
│  DSH 原生：agent loop / tools / skills /  │
│            plan / goal / subagent / 压缩  │
│                                          │
│  自研工具：memory_recall / memory_add /   │
│            memory_correct / sticker_send  │
└──────────────────────────────────────────┘
   │  POST /send（现有 outbox/桥接发送接口）
   ▼
微信
```

- 她的人格 = `agent-instructions` 里的系统提示；
- 她的记忆 = 记忆 HTTP 服务暴露的工具；
- 她的“手” = DSH 原生工具 + 自研工具；
- 适配器**不写人格、不做判断**，只做协议翻译和路由。

## 8. 组件

### 8.0 已验证的 DSH 能力

- `dsh-host-webserver`：插件可 `register(route)` / `registerUpgrade` 注册本地 HTTP 路由；
- `dsh-agent`：`ctx.agents.create()` / `resume()` 创建或恢复 agent，`handle.agent.followup()` 投递用户消息，`whenIdle()` 等待整轮结束；
- `dsh-session`：会话事件日志持久化，适配器可从 session 读 assistant 输出；
- `dsh-agent-loop`：默认 agent 驱动，需与 `dsh-agent` 一起挂载。

适配器按这套 API 实现，不需要改 DSH 本体。

### 8.1 `wechat-adapter`（新，Cordis 插件）

职责：

1. 暴露本地 HTTP 入口，接收桥接 webhook；
2. 把微信事件转成 DSH 会话消息（sender、群/私聊、引用、图片、文件）；
3. 按 `sessionKey = platform:chatType:chatId` 找到/创建 DSH 会话；
4. 触发 agent turn，拿最终回复；
5. 按行为配置拆气泡，调用桥接发送接口；
6. 幂等：`msg_id` 去重，失败重试不重发；
7. 模式：`off | shadow | active`；
8. 失败/超时回退旧 bot。

不做：人格、记忆检索、群频率、主动行为、表情选择。

### 8.2 `memory-tools`（新，Cordis 插件）

把现有 `memories.js` 暴露为 HTTP 服务，并提供工具：

- `memory_recall(query, scope)`：按当前会话/主人权限召回；
- `memory_add(text, about, evidence)`：写入事实；
- `memory_correct(old_hint, new_fact)`：纠正；
- `memory_narrative()`：读叙事线。

隐私规则在服务端执行，工具只传 scope，不暴露其他会话内容。

### 8.3 人格

- 现有 `config.persona.customPrompt` 原文迁入 `agent-instructions`；
- 保留名字、称呼、语气、引用规则、自改规则；
- 不再在旧 bot 里拼 system prompt。

### 8.4 会话与状态

- DSH session 持久化（JSONL）按 `sessionKey` 映射；
- 映射表存 `data/core-sessions.json`；
- 微信消息以 `user` 消息追加，发送者名前缀；
- 她的输出以 `assistant` 消息落盘；
- 重启后按 session id 恢复，不重放旧消息。

### 8.5 出站

- agent 最终文本按现有 `maxBubbles` / 标点规则拆条；
- 调桥接发送接口（复用 outbox），不直接操作 UIA；
- 发送失败进重试队列，幂等键 `msg_id + bubbleIndex`。

### 8.6 回退

- `core.mode=off`：适配器不接管，桥接直接回旧 bot；
- `core.mode=shadow`：适配器生成并记录，不发送；旧 bot 正常回；
- `core.mode=active`：适配器接管主人私聊；
- 任何异常 → 转发旧 bot，并记 `fallback` 日志；
- 主人命令 `/rollback core` 立即切回 off。

### 8.7 路由与切换

桥接的环境变量 `WHALE_BOT_URL` 指向 adapter 的兼容入口：

```
WHALE_BOT_URL=http://127.0.0.1:8788/webhook/wechat
```

adapter 只接管 `/webhook/wechat`，其余路径（`/api/*`、表情/文件相关）**原样反向代理**到旧 bot（`127.0.0.1:8787`），保证桥接的 outbox/表情/文件接口不变。

- `off`：adapter 收到后直接转发旧 bot，行为与现在完全一致；
- `shadow`：adapter 先转发旧 bot 并同步返回它的回复，再异步跑 agent、只记录结果与成本，不发送；
- `active`：adapter 跑 agent；成功则调用旧 bot 新增的 `POST /api/core/send`（token 保护）把气泡入 outbox；失败/超时则转发旧 bot 兜底；
- 桥接无需改代码，只改 `WHALE_BOT_URL`；回滚把 URL 改回旧 bot 或把 mode 设 off。

幂等：adapter 用桥接 `msg_id` 建去重表；旧 bot 兜底时沿用原 `msg_id`，不会重复回复。

### 8.8 记忆服务

- 复用现有 `memories.js`，起一个本地 HTTP 服务（默认 `127.0.0.1:8791`），只监听回环；
- token 复用 `config.gateway.wechat.inboundToken`，拒绝无 token 请求；
- 接口：`/recall`、`/add`、`/correct`、`/narrative`、`/audit`；
- adapter 把它注册成 DSH 工具（`memory_recall` 等），agent 主动调用；
- 隐私 scope 由服务端按 `sessionKey + isMaster` 计算，工具不能越权。

### 8.9 输出捕获与顺序

- `followup()` 后 `await whenIdle()`，从 session 的 `assistant/message` 事件取本轮最终文本（不看流式中间片段）；
- 每个 `sessionKey` 一个串行队列：同一会话同时只跑一轮，避免两条微信消息交叉；
- 超时（默认 60s）调用 `cancel()`，然后回退旧 bot；
- 同一 `msg_id` 只处理一次；重试复用去重键。

## 9. 热更新与重启策略

- Cordis 插件代码改动：重新构建 + 重启 `whale-agent` profile，预计数秒；
- `cordis.patch.yml` 改动：重启 profile；
- 状态全部外置（DSH session、记忆服务、outbox），重启不丢；
- 开发期用 `--patch` 覆盖配置，不动主 bot；
- 不承诺“改完即时生效”，但保证“重启即可生效、回滚即可恢复”。

## 10. 迁移步骤（C 的第一刀）

1. 建 `whale-agent` profile：base + agent + 人格 + 原生工具 + 自研工具；
2. 写 `wechat-adapter` 插件，先只支持主人私聊文本；
3. shadow 模式跑 50 条真实消息，对比旧 bot：延迟、成本、口吻、工具使用；
4. active 模式接管主人私聊，观察 24 小时；
5. 稳定后迁移图片/文件/表情；
6. 再谈群聊迁移。

## 11. 验收

- 消息不丢、不重复、不乱序；
- 主人私聊 p95 延迟与成本有记录，且可接受；
- shadow 期间旧 bot 回复不受影响；
- active 后 `/rollback core` 10 秒内切回；
- 隐私测试：群会话不可见其他群事实；主人跨会话可见；
- 插件重启后会话可恢复。

## 12. 风险

| 风险 | 缓解 |
|---|---|
| agent 多轮工具导致延迟/成本高 | 限制工具集、超时回退、shadow 先测 |
| 重复回复 | msg_id 幂等 + 发送确认 |
| 会话恢复错乱 | sessionKey 映射 + 启动对账 |
| 危险工具误操作 | 沙箱 + 权限 + 初期只开 web/memory |
| 插件 API 不稳定 | 锁 DSH 版本，适配器薄，升级回归 |

## 13. 已确认的决定

2026-11-02，主人授权“按你的建议来”，确定：

1. **工具权限**：初期只开 `web + memory + 表情`；fs/shell/subagent 等 P2 稳定后再开；
2. **记忆方式**：agent 主动调 `memory_recall/add/correct`，提示词要求“先 recall 再答”；不做每轮自动注入；
3. **切换节奏**：shadow 跑 50 条主人私聊消息；active 后旧 bot 继续兜底一周；`/rollback core` 随时切回；
4. 状态：设计**批准**，进入 `writing-plans`。

## 14. 原始待确认（已被 13 取代）

1. **工具权限**：初期给她 DSH 全工具（fs/shell/子 agent），还是先 web + memory + 表情，稳定后再开？我建议先 web + memory + 表情，P2 稳定后开全量。
2. **记忆方式**：她主动调 `memory_recall`（更像 agent），还是适配器每轮自动注入一段（更像现在的她）？我建议“工具为主 + 提示词要求先 recall”。
3. **切换时机**：shadow 跑多久、active 后旧 bot 是否继续兜底一周？

批准这份设计后，我再用 `writing-plans` 出 P2 的任务清单并开始实现。
