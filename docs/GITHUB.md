# GitHub 发布清单

## 1. 发布前

```powershell
npm test
npm run doctor
git status --short
git diff --cached --check
```

确认：

- `config.json`、`data/`、profiles、logs 没有 staged
- `config.example.json` 没有真实 key / wxid / 群号 / 本机盘符
- `.github/workflows/test.yml` 是唯一 workflow
- `git log` 不是空（至少一个 commit）

## 2. 首次提交

```powershell
git add -A
git commit -m "chore: unify Whale on DSH adapter and memory stack"
```

需要先配置作者：

```powershell
git config user.name "Your Name"
git config user.email "you@example.com"
```

## 3. 远程

```powershell
git remote add origin <HTTPS_OR_SSH_URL>
git branch -M main
git push -u origin main
```

如果仓库已有历史，先确认不会把旧 secrets 带上去：

```powershell
git log --all -- config.json
git grep -n -E "sk-|wxid_|@chatroom" $(git rev-list --all) -- . ':!config.json'
```

一旦旧 commit 里有真实 key/token，删除文件不够，必须轮换密钥并重写历史。

## 4. Release

仓库当前是源码发布，不附带 `runtime/` 或 `data/`。

```powershell
npm run package
# -> dist/whale-girl-source.zip
```

脚本用 `git checkout-index`，只导出 staged/committed 内容，并显式剔除 `config.json` / `data/`。

如果做 Windows 发行包，应只打包：

- `plugins/`
- `personas/`
- `tools/`
- `examples/`
- `src/` 中 memory 相关模块
- `config.example.json`
- README / docs / LICENSE

不要打包：

- `config.json`
- `data/`
- `runtime/`
- `wechatauto_logs/`
- `workspaces/`
- 本地 `.archify/`

## 5. 已知未完成

- GUI 输入仍未统一走 broker（P3）
- 非主人私聊、群主动话题、真实 `/dl` 仍需真实账号验收
- 旧 `server.js` / `legacy/web/` / old tests 仍是仓库中的 legacy，不应进入发布包
