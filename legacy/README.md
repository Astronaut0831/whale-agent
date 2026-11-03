# Legacy v3 (archived)

这里存放从新栈移出的旧实现，仅保留用于历史审计和必要时用 git 历史恢复。**这些文件不是运行路径，也不保证可启动。**

- `server.js`：旧 HTTP 服务归档；根目录已不再有 `server.js`。
- `src-bot.js`：旧 `src/bot.js` 归档。
- `tests/`：旧栈测试归档；新 CI 只跑 `npm test`。
- `src/`：已退役的 behavior / bilibili / care / corpus / links / proactive / tasks / vision；主路径使用 `plugins/lib/` 的共享实现。
- `web/`：旧网页控制台。
- `scripts/`：旧部署/重置/发布脚本。
- `plugins/whale-fixed-session/`：曾强制 GUI 进入固定 target。
- `plugins/whale-gui-input/`：曾把 GUI 输入接到固定 wrapper。

新栈入口：

```text
adapter: plugins/wechat-adapter
DSH profiles: docs/PROFILES.md
start: npm start
tests: npm test
```

旧文件即使手工运行，也不再保证导入路径/网页资源完整；需要旧行为时请从 git 历史恢复整个旧栈，而不是直接跑归档副本。
