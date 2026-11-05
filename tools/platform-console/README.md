# Whale Platform Console

多端控制台：监控为只读，接入页可编辑 QQ/微信 allowlist。不做启停/persona/queue 编辑。

```text
Vue 3 + Vite + TypeScript + Naive UI
Node HTTP server :3100
```

## 开发

```powershell
npm install
npm run dev
```

Vite 开发页在 `127.0.0.1:3101`，`/api` 代理到 `127.0.0.1:3100`。
同时另开一个终端：

```powershell
npm start
```

## 生产

```powershell
npm run build
npm start
```

打开：

```text
http://127.0.0.1:3100
```

## 数据源

```text
3080 DSH GUI
8788 platform-adapter /wechat/ping
8791 memory-server
8790 embedding
3000/3001 SnowLuma OneBot
5099 SnowLuma WebUI
data/bridge-ready.json 微信 bridge
research/qq-bridge/state/adapter-transport-status.json QQ transport
```

## API

```text
GET /api/status
GET /api/logs?source=adapter|wechatBridge|web|qqTransport&tail=80
GET /api/platforms
GET /api/access
GET /api/seen
PUT /api/access
```

`PUT /api/access` 只允许本机控制台代理到 adapter；adapter 侧仍要求 `x-bot-token`。

全部只读。

## SnowLuma

控制台不修改 SnowLuma，也不 iframe：

```text
右上角「打开 SnowLuma 控制台」→ 127.0.0.1:5099
```

## 环境变量

```text
CONSOLE_HOST        默认 127.0.0.1
CONSOLE_PORT        默认 3100
ADAPTER_URL         默认 http://127.0.0.1:8788
QQ_BRIDGE_ROOT      默认 D:/dsh-workspace/research/qq-bridge
SNOWLUMA_URL        默认 http://127.0.0.1:5099
DSH_WEB_LOG         默认 ~/AppData/Local/dsh/web.log
```

第一版绑定 localhost；不要在没有鉴权的情况下把 `CONSOLE_HOST` 改成 `0.0.0.0`。
