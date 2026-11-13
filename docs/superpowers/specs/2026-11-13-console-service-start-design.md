# 控制台服务启动面板（短设计）

日期：2026-11-13  
状态：待确认  
范围：`tools/platform-console`

## 目标

在鲸鲸控制台 `:3100` 增加一个「服务」区：

- SnowLuma：只显示 WebUI / OneBot / 进程状态，不提供启动按钮。
- QQ transport：显示状态；SnowLuma OneBot 在线时可一键启动。
- 微信 bridge：显示状态；满足确认条件时可一键启动。

## 非目标

- 不从控制台启动/停止 SnowLuma，也不代替 SnowLuma 登录 QQ。
- 不提供任意 shell、任意命令、任意路径执行。
- 不自动修改微信账号配置，不猜测哪个窗口是机器人号。
- 本期不做 Windows 服务/开机自启；仍是手动控制台按钮。

## 设计

采用「控制台后端白名单进程管理」：

### 后端 `server.mjs`

`GET /api/services`

返回：

```json
{
  "snowluma":  { "webui": true, "onebotHttp": false, "onebotWs": false, "pid": 45220 },
  "qqTransport": { "running": false, "lastError": "" },
  "wechatBridge": { "running": false, "ready": false, "stopFlag": true }
}
```

状态来源：

- SnowLuma：5099 / 3000 / 3001 的 TCP/HTTP 探测。
- QQ transport：一次 PowerShell 进程查询（固定匹配 `adapter-transport.js`）。
- 微信 bridge：一次 PowerShell 进程查询（固定匹配 `wechatauto_bridge.py`）+ `data/bridge-ready.json` + `data/bridge-stop.flag`。

`POST /api/services/qq-transport/start`

条件：

- SnowLuma `3000` 和 `3001` 都在线；否则 `409`，提示先去 5099 登录/启动 OneBot。
- 已有 transport 进程则直接返回 `running`，不重复启动。

动作：

```text
cwd: D:\dsh-workspace\research\qq-bridge
cmd: npm start
detached + hidden；stdout/stderr 写 data/console-services.log
```

`POST /api/services/wechat-bridge/start`

请求体必须包含：

```json
{ "confirmBotWindow": true }
```

条件：

- 没有确认 → `400`，不启动。
- 已有 bridge 进程 → 直接返回 `running`，不重复启动。
- `data/bridge-stop.flag` 存在时，先删除 flag，再启动 `tools/run-bridge.bat`。
- 启动前在日志写一条「操作者确认只保留机器人号窗口」。

动作：

```text
cwd: D:\dsh-workspace\chat\whale_gril
cmd: cmd /c tools\run-bridge.bat
detached + hidden；日志由 run-bridge 自己写
```

所有启动接口只接受固定服务名，不接受命令字符串。

### 前端 `App.vue`

在监控区下新增「服务」卡片：

| 服务 | 显示 | 按钮 |
|---|---|---|
| SnowLuma | WebUI / OneBot HTTP / WS / PID | 无，只给「打开 5099」链接 |
| QQ transport | 运行中 / 未运行 | 「启动」，OneBot 离线时禁用并提示 |
| 微信 bridge | 运行中 / ready / stop flag | 「启动」，必须先勾选「已只保留机器人号窗口」 |

启动后 5 秒轮询刷新状态；失败显示后端返回的中文错误。

## 安全边界

- 控制台只绑定 `127.0.0.1`，不新增公网监听。
- 启动接口只允许两个固定 target；无参数拼接进 shell。
- 微信 bridge 不自动选择账号；确认框是把「只留机器人窗口」的责任显式交给操作者。
- 不做「启动 SnowLuma」或「停止 SnowLuma」。

## 验收

1. SnowLuma 在线、QQ transport 未运行 → 点「启动」后进程出现，状态变为运行中。
2. OneBot 离线 → QQ 启动按钮禁用/返回 409，不产生进程。
3. 微信 bridge 未勾选确认 → 不启动。
4. 勾选确认 → 删除 stop flag、启动 bridge，状态变为运行中。
5. 重复点击不会产生第二个实例。
6. `npm run build` 通过；控制台页面刷新后按钮仍正常。

## 待确认

- 是否同意「微信 bridge 用确认勾选，而不是控制台自动判断哪个窗口是机器人号」。
- 是否只做启动，不做停止按钮。
