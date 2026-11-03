# Legacy v3

这里存放从新栈移出的旧实现，保留是为了可逆审计，不是运行路径。

- `plugins/whale-fixed-session/`：曾强制 GUI 进入固定 target；已从 web profile 移除。
- `plugins/whale-gui-input/`：曾把 GUI 输入接到固定 wrapper；已移除。

仍留在仓库根目录但属于 legacy：

- `web/`：旧网页控制台，已移到 `legacy/web/`。
- 旧部署/重置/发布脚本：`legacy/scripts/`。
- `server.js`（直接运行会拒绝启动，除非 `WHALE_LEGACY=1`）
- `src/bot.js`
- `tests/` 旧栈测试

新栈入口：

```text
adapter: plugins/wechat-adapter
DSH profiles: docs/PROFILES.md
start: npm start
tests: npm test
```
