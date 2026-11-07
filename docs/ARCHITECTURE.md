# 鲸鲸当前架构

> 更新时间：2026-11-07
> 这份文档写**现在的真实结构**。结构变了就回来改，别让它过期。

## 0. 最底层原则：一个主体，一套人设

**每一个鲸鲸会话都是「我」。** 微信私聊、每一个群、QQ、GUI 主会话，进的都是同一个鲸鲸；coding/工具会话不属于鲸鲸，不注入人设。

- 人设 `personas/whale-agent.md` 必须挂到**所有鲸鲸会话**：GUI 主会话（target）以及 `data/chat-sessions.json` 映射出的微信/QQ 会话。`plugins/whale-persona` 用 `resolveTarget + scopeForSession` 过滤；**不能**用 `Boolean(sid)`，否则会把人设注入 coding/工具会话。
- 会话拆开只是为了**上下文不互相污染**（群里的闲话不进私聊），不是分裂人格。
- 记忆可以按 scope 隔离（群与群、群与私聊），但**人格不按会话分**。
- 主动消息（搭话、群起话题）也必须由「记得上下文的那一方」生成，否则会编出「你上次说的那家店」。

## 1. 运行时拓扑

```text
微信客户端
  └─ examples/wechatauto_bridge.py
       ├─ 微信 DB 只读监听（收消息）
       ├─ UIA 发送（发消息、取图、发文件）
       └─ POST /webhook/wechat → platform-adapter :8788
            ├─ 命令 / 群策略 / 静音
            ├─ 选会话（chat-sessions.json）
            ├─ gui-broker → DSH GUI :3080 的某个会话
            └─ outbox → bridge → 微信

DSH GUI :3080（profile web）
  ├─ 主会话（主人私聊，sessionId 存在 data/runtime.json）
  ├─ 每个群一个会话（data/chat-sessions.json）
  ├─ 每个非主人私聊一个会话
  └─ 插件树：
       whale-persona        人设（只挂鲸鲸会话）
       whale-system-context 规矩/自省（主会话全量，映射会话短版）
       whale-memory-core    每轮写记忆
       whale-memory-tools   memory_recall 工具
       dsh-see-now          看屏幕/摄像头/视频文件

platform-adapter :8788（profile whale-agent）
  ← 微信 bridge / QQ transport-only
  → gui-broker 或 headless DSH / outbox

QQ：SnowLuma OneBot（:3000/:3001/:5099）
  → research/qq-bridge（branch adapter-transport）
  → POST /webhook/qq → platform-adapter
  官方 @tencent-connect/dsh-qqbot 已停用

memory-server :8791
  ├─ /observe    把 turn 写进 episodes
  ├─ digest      worker 定期压成 memories / narrative
  └─ /recall     语义 + 关系 + 新近度
embed_server :8790（向量）
```

## 2. 会话与 scope

| 路径 | 会话 | 记忆 scope |
|---|---|---|
| 主人私聊 | 主会话（`runtime.json → guiSessionId`） | `gui:whale`（另可按 `wechat:u:<wxid>`） |
| 群聊 | 每群一个，首次说话时 `session/create` | `wechat:g:<chatId>` |
| 非主人私聊 | 每人一个 | `wechat:u:<wxid>` |
| QQ 私聊（主人） | platform-adapter headless（映射到微信 master） | `wechat:u:<master wxid>`，和微信共享记忆 |
| QQ 群 | platform-adapter headless，独立会话 | `qq:g:<peerId>` |

映射文件 `data/chat-sessions.json`：

```json
{ "byChat": { "44172210093@chatroom": "session-xxxx", "wxid_xxx": "session-yyyy" } }
```

`plugins/lib/runtime.js` 负责读它、反查 `sessionId → scope`，人设/记忆/上下文插件都靠这个反查。

## 3. 一条消息的旅程

1. bridge 轮询微信数据库 → `POST /webhook/wechat`
2. adapter 校验 token、去重、分派
3. 命令就地处理；普通消息继续
4. 群消息先过 `lib/group-policy.js`：被 @ / 被引用 → 直接唤醒；否则打分，灰区交 `groupJudge` 小模型；判否就 `group-skip`，**不进会话**
5. `ensureChatSession` 拿到该 chat 的会话（没有就创建并写映射）
6. `gui-broker` 用 RPC `session/prompt` 投进该会话
7. 结束后用 `session/page` 读**完整正文**（不能用 `turnOutline.response`——那是 120 字预览，带省略号）
8. 分气泡写进 `data/outbox.json`
9. bridge 轮询 `/api/bridge/outbox`，逐条 UIA 发送，逐条 ack

## 4. 记忆

- `memory-episodes.jsonl`：原始 turn（按 scope）
- `memories.json`：原子事实 + 来源 + 向量
- `narrative.json`：摘要时间线
- 召回：关系权重 + 重要度 + 新近度，按 audience 过滤
- 群记忆隔离；主人私聊跨端（微信/QQ）共享

## 5. 主动行为

| 行为 | 判断 | 内容生成 |
|---|---|---|
| 私聊主动搭话 | `/api/care/due`：时间窗、间隔、上限 + 模型判断 | **主会话**（`runGuiInput`），失败才退小模型 |
| 群起话题 | `groupTopicTimer`：静默够久且该群允许 | **该群自己的会话** |
| 提醒 | 主人自然语言「提醒我…」→ `data/proactive.json` | 固定文案 |

## 6. 已知坑（踩过的）

1. **DSH GUI token 是一次性的**：GUI 重启后 adapter 必须重启重新拿 token，否则 `no dsh auth cookie`。顺序永远是：先 GUI，后 adapter。
2. **`turnOutline.response` 是界面预览**（120 字 + 省略号），回复正文必须走 `session/page`。
3. **图片**：优先本机 `.dat`（重试 4 次，微信落盘有延迟）；实在没有才截图兜底，截图要排除头像（贴左边、小于 120px）。
4. **引用**：桥接解析 `<refermsg>`；引用任何人都会标注来源，引用自己人不会标成「你说过」。
5. **前台兜底**：账号窗口没确认时宁可这次不发，也不能把主人自己的微信窗口拉到前台。
6. **重启会吞消息**：所有重启脚本都延迟执行，避免打断正在发送的那条。
7. **分层重启**：改 plugins/*.js → 重启 GUI；改 platform-adapter → 重启 adapter；改 bridge.py → 重启 bridge。别混。
8. **微信多开**：多窗口时至少 5 条最近会话证据才允许锁定；不足就拒绝发送，宁可不回，也不能从主号窗口发。
9. **微信连发**：adapter `lib/wechat-batch.js` 把 900ms 内的同会话文本合并；群聊只合并同一发送者，命令/图片不合并。
10. **headless 工作区**：cwd 必须是 `chat/whale`（workspace 实际路径），不是 `chat/微信`；否则报 `session recorded in ... not ...`。旧 `core-sessions.json` 映射过期要清。

## 7. 改动纪律

- 代码改动走 `python tools/safe_patch.py --file X --spec patch.json`（自动备份、唯一匹配、语法失败回滚）
- 不按行号裁剪大段代码
- 改完立刻 `node --check` / `py_compile`，再按层重启，看日志确认
- 结构有变，回来更新这份文档

## 8. 文件速查

```
plugins/platform-adapter/index.js   多端适配器主入口
plugins/platform-adapter/lib/       broker / outbox / 群策略 / 气泡 / 批处理
plugins/whale-persona/              人设注入（只挂鲸鲸会话）
plugins/whale-memory-core/          对话写记忆
plugins/whale-memory-tools/         memory_recall 工具
plugins/whale-system-context/       规矩/自省注入
plugins/lib/runtime.js              target/scope 解析、chat-sessions 读取
personas/whale-agent.md             人设正文
examples/wechatauto_bridge.py       微信 UI/DB 桥
tools/platform-console/             控制台（:3100，Vue3）
research/qq-bridge/                 QQ SnowLuma transport-only（仓库外）
data/chat-sessions.json             会话映射
data/outbox.json                    下行队列
data/runtime.json                   主会话 id、token
tools/safe_patch.py                 可逆改码
tools/start-all.ps1                 拉起全部服务
tools/adapter-watchdog.ps1          守护
```
