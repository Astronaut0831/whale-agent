# QQ 官方 Loop + 鲸鲸记忆内核

更新时间：2026-11-04

## 结论

QQ 使用官方 `@tencent-connect/dsh-qqbot` 的完整 agent loop，保留：

- 官方 WebSocket / 群聊 / 单聊
- 图片、视频、语音、文件下载
- 原图多模态
- `qqbot_send_file`
- 官方 markdown / 流式 / 审批 / 问答通道

鲸鲸内核由 `@whale/whale-qq-memory` 注入：

- `personas/whale-agent.md`
- `memory_recall` / `memory_add` / `memory_correct`
- `memory-server /observe`
- `memory-server /recall`

## Scope

```text
QQ 主人私聊   -> wechat:u:<masterWxid>   （和微信主人共用记忆）
QQ 群聊       -> qq:g:<group_openid>     （群间隔离）
QQ 其他私聊   -> qq:u:<openid>
```

日志确认：

```text
[whale-qq-memory] attach scope=c2c peer=...
[whale-qq-memory] memory=wechat:u:wxid_...
[whale-qq-memory] master=true tools=true
[whale-qq-memory] turn/end ... known=true
```

## 官方插件 Patch

插件安装目录：

```text
%USERPROFILE%\.dsh\profiles\web\node_modules\@tencent-connect\dsh-qqbot
```

打的两个 hook：

```text
lib/session/session-manager.js
  after this.sessions.set(key, record):
  ctx.emit('qqbot/session-ready', { record })

lib/gateway/bootstrap.js
  after handleInbound:
  ctx.emit('qqbot/inbound', { msg, mCtx })
```

插件升级/重装后补丁会被覆盖，重新执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\patch-qq-official-hooks.ps1
```

## Profile

`web/cordis.patch.yml` 保留：

```text
- id: im-qqbot
  config:
    access: ...
- insert:
  - id: whale-qq-memory
    name: "@whale/whale-qq-memory"
```

AppID/AppSecret 只放在 Windows 用户环境变量：

```text
QQBOT_APPID
QQBOT_SECRET
```

不写入 YAML。

## 当前不用的 fallback

`tools/qq-bridge.mjs` 是文本版统一 bridge，当前**不启动**，避免和官方 loop 抢 QQ 连接。
只有在官方插件不可用时才作为 fallback。

## 未验收

- QQ 群聊 @
- QQ 入站文件/语音
- QQ 主动发文件
- 官方 vision 工具（目前原图多模态已验证，`vision.enabled` 未开）
