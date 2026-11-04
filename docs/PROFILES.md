# DSH Profiles 配置

鲸鲸不把机器专属 profile 放进仓库。下面是四个 profile 的最小结构；把 `<REPO>`、`<SESSION_ID>`、`<WXID>`、API key 换成自己的值。

Windows 路径：

```text
C:\Users\<user>\.dsh\profiles\<profile-name>\
```

每个 profile 目录至少要有 `package.json` 和 `cordis.patch.yml`。插件用本地 link 安装：

```powershell
dsh plugin --profile whale-headless add "link:<REPO>/plugins/whale-persona"
```

## 0. Runtime state（推荐）

target/token 可以放在 `data/runtime.json`，profile 里留空：

```powershell
powershell -File tools\set-runtime.ps1 -SessionId "<SESSION_ID>" -MemoryToken "<MEMORY_TOKEN>"
```

```json
{ "guiSessionId": "<SESSION_ID>", "memoryToken": "<MEMORY_TOKEN>" }
```

`whale-persona`、`whale-memory-core`、`whale-memory-tools`、`whale-system-context`、adapter 会读取它；显式 profile 值仍然优先。

## 1. whale-agent（adapter）

`package.json`：

```json
{
  "name": "whale-agent",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } },
  "dependencies": {
    "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.2",
    "@whale/wechat-adapter": "link:<REPO>/plugins/wechat-adapter"
  }
}
```

`cordis.patch.yml` 关键部分：

```yaml
- insert:
    - id: wechat-adapter
      name: "@whale/wechat-adapter"
      config:
        legacyEnabled: false
        groupEnabled: true
        runner: headless
        headlessProfile: whale-headless
        taskProfile: whale-headless-task
        workspace: "<REPO>/../whale"
        agentOptions:
          provider: deepseek-official
          model: deepseek-flash
          reasoningEffort: max
        guiBroker:
          enabled: true
          guiInput: true
          url: "http://127.0.0.1:3080"
          tokenFile: "<REPO>/data/gui-3080.log"
          routes: ["master", "groups"]
          sessionId: "<SESSION_ID>"
          timeoutMs: 120000
```

建议把 bash/pwsh/fs/subagent 等工具在 adapter profile 里禁用；adapter 只做消息编排。

## 2. whale-headless（普通微信消息）

`package.json`：

```json
{
  "name": "whale-headless",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
  "dependencies": {
    "@whale/whale-persona": "link:<REPO>/plugins/whale-persona",
    "@whale/whale-memory-core": "link:<REPO>/plugins/whale-memory-core",
    "@whale/whale-memory-tools": "link:<REPO>/plugins/whale-memory-tools",
    "@whale/whale-system-context": "link:<REPO>/plugins/whale-system-context",
    "@whale/whale-sticker-tool": "link:<REPO>/plugins/whale-sticker-tool"
  }
}
```

`cordis.patch.yml` 必须包含：

```yaml
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
- id: tool-working-directory
  disabled: true

- insert:
    - id: whale-persona
      name: "@whale/whale-persona"
      config:
        personaFile: "<REPO>/personas/whale-agent.md"
- insert:
    - id: whale-memory-tools
      name: "@whale/whale-memory-tools"
- insert:
    - id: whale-memory-core
      name: "@whale/whale-memory-core"
- insert:
    - id: whale-system-context
      name: "@whale/whale-system-context"
- insert:
    - id: whale-sticker-tool
      name: "@whale/whale-sticker-tool"
```

普通微信会话没有文件工具，这是安全边界。

## 3. whale-headless-task（后台任务）

复制 `whale-headless`，然后：

- `package.json` 的名称改成 `whale-headless-task`；
- **不要**禁 `tool-fs` / `tool-fs-search` / `tool-working-directory`；
- 保留 persona / memory / context / sticker 插件。

它只给 `/task` 使用，避免普通微信消息拿到 fs。

## 4. web（GUI）

`package.json` 加：

```json
{
  "name": "web",
  "private": true,
  "dependencies": {
    "@whale/whale-persona": "link:<REPO>/plugins/whale-persona",
    "@whale/whale-memory-core": "link:<REPO>/plugins/whale-memory-core",
    "@whale/whale-memory-tools": "link:<REPO>/plugins/whale-memory-tools"
    "@whale/whale-system-context": "link:<REPO>/plugins/whale-system-context"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: whale-persona
      name: "@whale/whale-persona"
      config:
        personaFile: "<REPO>/personas/whale-agent.md"
        targetSessionId: "<SESSION_ID>"
- insert:
    - id: whale-memory-core
      name: "@whale/whale-memory-core"
      config:
        targetSessionId: "<SESSION_ID>"
        scope: "gui:whale"
        memoryUrl: "http://127.0.0.1:8791"
        token: "<MEMORY_TOKEN>"
- insert:
    - id: whale-memory-tools
      name: "@whale/whale-memory-tools"
      config:
        targetSessionId: "<SESSION_ID>"
        scope: "gui:whale"
        isMaster: true
        memoryUrl: "http://127.0.0.1:8791"
        token: "<MEMORY_TOKEN>"
- insert:
    - id: whale-system-context
      name: "@whale/whale-system-context"
      config:
        targetSessionId: "<SESSION_ID>"
```

**不要**安装：

- `@whale/whale-fixed-session`
- `@whale/whale-gui-input`

它们会强制页面/输入进入固定 target，曾导致所有 GUI 会话被锁死。

## 5. 安全检查

```powershell
dsh --profile web --dump-config
dsh --profile whale-headless --dump-config
dsh --profile whale-headless-task --dump-config
```

确认：

- web 没有 fixed-session / gui-input；
- headless 明确 `tool-fs: disabled`；
- task 没有禁用 fs；
- `guiBroker.legacyEnabled` 为 false。
