# 统一 Envelope + 旧记忆模块移植

日期：2026-11-02
状态：代码完成，真实模型验证通过；自动 worker 因旧 bot 双写风险暂挂

## 1. 统一 Envelope

`plugins/wechat-adapter/lib/envelope.js`

- 所有端先转成 `{ v, platform, chatType, chatId, sessionKey, threadId, message:{id,text,images,atMe,ts,sender}, raw }`；
- `normalizeInbound()` 自动附加 `msg.envelope`；
- active 回复生成 `outbound`（`replyTo/threadId/bubbles`）；
- 目前只有微信 bridge 接入。

## 2. 记忆模块移植（完整）

### 2.1 摘要核心

`src/digestCore.js`：从旧 `server.js` 的 `runDigestPass` **原样抽出**，保留：

- token/idle 触发、分段、多段 reduce；
- 模型 JSON 摘要、`splitFacts` 再拆；
- 墓碑过滤；
- digest 游标与累积；
- 叙事 `narrative.append`；
- 模型仲裁（旧事实 vs 新事实，confidence 门槛）；
- `bestSpan` 源句定位 + `provenances`/`evidences`；
- `memories.addMany`、`dedupeSession`、`pruneSuperseded`；
- selfnote。

### 2.2 Episodes runtime

`tools/episode-runtime.js`：把 `data/memory-episodes.jsonl` 转成旧 digest 需要的：

- `store.sessionKeys()/sessions/messages/digestOf/setDigest`
- 消息按 episode 展开为 user/assistant，带 `msgId/ts`
- digest 状态持久化到 `memory-digest-state.json`

### 2.3 Memory server

`tools/memory-server.js` 新增：

- `POST /observe`：只追加海马体 episode，**不再启发式直写长期记忆**；
- `POST /digest/run`：episodes → `runDigestPass` → 长期记忆；
- `POST /consolidate/run`：`memoryConsolidate.runOnce`（机械合并 + 模型判重 + 遗忘 + 显著性重放）；
- `POST /correct-auto`：`reconsolidate.autoCorrect`；
- `GET /recall`：主人私聊额外返回 `review`（间隔复习事实），并 `markReviewed`。

### 2.4 插件

`@whale/whale-memory-core`：监听 `session/event` 的 `turn/end`，取最后一轮 user/assistant（过滤 runtime context），POST `/observe`。

### 2.5 后台 worker

`startWorkers`：

- 每 5 分钟跑一次非强制 digest（受 idle/token 触发）；
- 每天 03:00 后跑一次 consolidation；状态写 `memory-consolidate-state.json`。

## 3. 验证

- adapter + 插件：32/32；
- digest/episode/maintenance/memory-server：5/5；
- 真实模型临时库测试：
  - 3 轮对话 → 6 条事实；
  - 带 quote/confidence/about；
  - `/recall` 命中“主人喜欢喝手冲咖啡”。

## 4. 当前状态（2026-11-02 21:00）

- 旧 `server.js` 已停，8787 不再监听；adapter 接管 outbox：
  `/api/core/send`、`/api/bridge/outbox`、`/api/bridge/outbox/ack`、`/healthz`；
- 桥接进程仍作为“微信驱动”运行，只连 adapter；
- `MEMORY_WORKERS=1`，digest/巩固 worker 已开启；旧 bot 不再写 `memories.json`；
- adapter 自测：active → outbox → bridge 发送成功；
- 海马体验证：原始用户文本 + 纯 text 回复，runtime/system-reminder/记忆注入块/推理内容均被过滤。

### 群聊注意力（2026-11-02 21:22）

- 源：`src/attention.js` **原样复用**（字符二元组 Jaccard、权重、HI/LO 阈值）；
- adapter 新增 `lib/group-policy.js`、`lib/group-history.js`；
- 已接：@/回复她、问号、明确叫她说话、静默、主人常回、冷却、每小时上限、`requireAt=false`、打分、灰区模型判断、freeChat；
- 灰区判断用同一把 DeepSeek（旧 `judgeAddressee` 提示词）；
- 群聊独立 session（`wechat:g:<id>`）、独立 group-history、记忆按群隔离；
- 实测：test 群一条 `at_me` 消息 → `addressed` → DSH 回复 → 桥接发送成功。

尚未迁的群能力：`/mute`、`/listen`、awayChance、engaged 接话窗口、群命令。

### 旧 bot 能力现状

- 记忆：完整移植；
- 私聊文本回复/发送：已迁移；
- 图片理解：`/api/vision` 已接回 `src/vision.describe`，实测测试图返回描述；
- 表情包：adapter 复用 `StickerService`，`send_sticker` 工具已挂到 headless；enqueue/pending/claim/ack 实测通过；
- 主动关心：`/api/care/due`、`/api/care` 已接回 `src/care`，当前沿用 `care.enabled=false`，不会主动发；
- 群聊回复：未迁移；旧 bot 停后群消息被忽略；
- `/task`、分享、部分 sticker 管理接口：未迁移。

## 5. 下一步

1. 观察 DSH 私聊与记忆 worker；
2. 按优先级迁移表情/图片/主动关心/群聊；
3. 再做 GUI/broker。
