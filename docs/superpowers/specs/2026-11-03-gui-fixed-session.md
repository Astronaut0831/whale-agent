# GUI 固定“鲸鲸”会话 + 仅会话记忆

日期：2026-11-03
目标：GUI 固定一个会话；记忆/人格插件只在这个会话生效，不做 profile 全局注入。

## 设计

- 固定目标 session：`<SESSION_ID>`
  - cwd：`D:\dsh-workspace\chat`
  - 已在 GUI 会话列表可见
- client plugin：`@whale/whale-fixed-session`
  - 等 `sessions` / `workspaces` ready
  - 直接 `uiWorkspace.openSession(target)`
  - 刷新、新标签、重新打开 GUI 都回到目标会话
- 记忆 scope：`gui:whale`
- 门控规则：

```text
WHALE_SESSION_SCOPE 存在
  → 微信 headless 原逻辑，scope 来自 env

无 env（GUI）
  → 只有 session.id === targetSessionId 才 observe / 注册记忆工具
  → 其他 GUI 会话、subagent 完全不写、不注入、不注册
```

## 改动文件

- `legacy/plugins/whale-fixed-session/`
  - `package.json`：`dsh.client.inject` 指向 ui-workspace 包
  - `client.js`：`window.__ModuleLoader__.load(...)` 格式；代码 `inject = ["uiWorkspace"]`
  - `index.js`：host 无行为
- `plugins/whale-memory-core/index.js`
  - 新增 `resolveScope(sessionId, config, envScope)`
  - 无 env 时要求 `session.id === config.targetSessionId`
- `plugins/whale-memory-tools/index.js`
  - 新增 `resolveScope(agent, config, envScope)`
  - 无 env 时要求 `agent.session.id === config.targetSessionId`
- `plugins/whale-persona/index.js`
  - 微信 headless（有 env）继续 profile 级注入
  - GUI 只在目标 session 的 `agent/created` 上挂 `agent.ctx.systemPrompt.section`
- `C:\Users\astronaut\.dsh\profiles\web\cordis.patch.yml`
  - 插入 persona / memory-core / memory-tools / fixed-session
  - 备份：`cordis.patch.yml.bak-whale-*`
- `C:\Users\astronaut\.dsh\profiles\web\package.json`
  - 以 `link:` 方式加入四个 `@whale/*` 包

## 验证

- `dsh --profile web --dump-config`：四个 insert 条目都在
- 3081 临时 GUI：
  - 启动后 RootWebArea 标题为 `只回复：鲸鲸 GUI 主会话已建`
  - 侧边栏选中的是目标 session
  - 第二次启动仍回到同一 session
- scope 门控测试：9/9 通过
  - env 优先
  - 目标 session 写入 `gui:whale`
  - 非目标 GUI 会话不 fetch
  - 没有 targetSessionId 时不生效
- 3080 实际 GUI（2026-11-03 00:58 验证）：
  - 新进程 PID 27100，创建时间 00:55:38
  - 新 token 打开后 RootWebArea 为 `只回复：鲸鲸 GUI 主会话已建`
  - `restoreSelection` 之后 client plugin 会持续校正，最终回到目标 session
  - `gui-restart.log` 的 `health=False` 是重启脚本探测过早，页面实际可用
- 2026-11-03 01:20 回归修复：首次打开 target 后不立刻停止，保留 12 秒保护窗口；实测新标签 1 秒内切到 target，13 秒后仍是 target。

## 运维注意

- 切换目标 session 需要同时改三处：
  1. `legacy/plugins/whale-fixed-session/client.js` 的 `TARGET_SESSION`
  2. `profiles/web/cordis.patch.yml` 的 `targetSessionId`（persona/memory-core/memory-tools）
  3. 重启 GUI server
- 目标 session 被删除时 client plugin 不会自动新建，会退回 GUI 默认选择；此时需要重新建 target 并改 id。
- 3080 重启命令（会中断当前 GUI 会话，需明确执行）：

```powershell
# 先找到 3080 进程
Get-NetTCPConnection -LocalPort 3080 -State Listen
# 停掉后，在 D:\dsh-workspace\chat 启动
$env:DEEPSEEK_API_KEY = (Get-Content 'D:\dsh-workspace\chat\whale_gril\config.json' -Raw | ConvertFrom-Json).deepseek.apiKey
dsh --profile web --port 3080
```

- 3081 只是验证实例，验证完应停止。
- 未做：跨端 broker、把微信消息注入这个 GUI session、自动 recall 注入（当前只注册记忆工具，agent 需要主动调用）。
