# 贡献指南

感谢你帮助改进 wecom-openwebui-bridge。

## 开始之前

- 请勿在 Issue、日志、提交或截图中包含企业微信 Secret、Open WebUI API Key、触发器 Token、数据库密码或真实用户数据。
- 新功能应保持 Windows Server 与 Node.js 20 兼容。
- 涉及企业微信协议时，优先使用官方 `@wecom/aibot-node-sdk` 已公开的能力。

## 本地开发

```powershell
npm.cmd install
npm.cmd run check
```

运行服务前复制配置模板：

```powershell
Copy-Item .env.example .env
notepad .env
node .\index.js
```

`.env`、`history.json`、日志和 `node_modules` 不得提交。

## 提交 Pull Request

1. 从 `main` 创建功能分支。
2. 尽量保持一个 Pull Request 只解决一个问题。
3. 更新相关 README、环境变量模板和版本说明。
4. 运行 `npm.cmd run check`，并说明实际验证过的消息类型。
5. 若修改媒体处理、鉴权或主动触发接口，请同时说明安全影响。

提交 Pull Request 即表示你同意按仓库的 MIT License 提供贡献。

