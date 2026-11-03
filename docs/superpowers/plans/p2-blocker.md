# P2 卡点记录：DSH Agent transport

日期：2026-11-02
状态：未解决；已切回 off，生产未受影响

## 症状

adapter 在 `whale-agent` / `whale-web` 自定义 profile 里通过 `ctx.agents.create()` 创建 agent，发送 followup 后：

```
DeepSeek Messages transport failed (TRANSPORT)
```

turn 直接失败，session 里没有 assistant 消息。

## 已排除

- API key 存在且正确（ping 诊断 keyLen=35；同一 key 跑 `p1-lite` 正常）；
- 模型/provider 配置正确（request/header：deepseek-official / deepseek-flash / reasoningEffort max / maxTokens 256000，与 p1-lite 成功请求一致）；
- 记忆工具不是原因（关闭 setupAgent 后仍失败）；
- 旧会话损坏（删除 core-sessions.json、新建 session 后仍失败）；
- headless 的 startup 插件不是原因（单独插入后仍不启动）；
- web profile 宿主也一样失败，排除 base-only 特有。

## 结论

p1-lite（headless 应用）能正常请求模型；但**在自定义常驻 profile 里手动 create agent**，transport 初始化不完整。属于 DSH 组合/初始化差异，不是 adapter 逻辑。

2026-11-02 13:56 用修好的记忆工具 JSON Schema 重测 resident（独立 8789 测试 profile），仍然 `TRANSPORT`，所以工具 schema 不是 resident 卡点；schema 修复只影响 headless 的原生工具调用（已验通）。

## Plan B（已验证可行）

用 **headless 一次性 agent 会话**作为 active 核心：

- adapter 对每条消息 spawn `dsh --profile whale-headless --session-id ... --json -`，消息从 stdin 进；
- 解析 `final` 事件作为回复，再走 `/api/core/send`；
- 实测：
  - “只回复两个字：收到” → `收到`
  - “用一句话说你是谁” → `我是哦鲸鲸，群里的鲸鱼娘。`
- 仍是 DSH agent（工具/会话/技能），只是每消息起进程，延迟更高；
- persona 通过 `@whale/whale-persona` 插件注入 `whale-headless` profile。

adapter 测试 19/19；active 端到端 capture 验证通过。

## 当前状态

- `data/core-mode.json` = off；
- adapter 监听 8788，配置已改回真实 `coreSendUrl/legacyBase`；
- 8788 服务运行中，capture 已删；
- 旧 bot HTTP 200，桥接未切；
- 等“shadow 切流”审批。
