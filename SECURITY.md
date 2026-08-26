# 安全策略

## 支持范围

安全修复优先应用到最新发布版本。使用者应及时升级 Node.js、Open WebUI 和项目依赖。

## 报告漏洞

请优先使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告入口。不要在公开 Issue 中发布可用的密钥、真实接口地址、数据库连接串、员工 UserID、群 ChatID 或未经脱敏的日志。

报告中请包含：

- 受影响版本；
- 最小复现步骤；
- 可能影响；
- 已完成脱敏的日志或请求示例。

## 部署基线

- 使用独立、非管理员的 Open WebUI 服务账号，并执行最小权限授权。
- 明确配置 `ALLOWED_USER_IDS` 和 `ALLOWED_GROUP_IDS`，不要长期使用 `*`。
- 默认保持 `TRIGGER_API_HOST=127.0.0.1`；如需局域网访问，应增加防火墙来源限制和 HTTPS 反向代理。
- SQL 工具只能使用只读数据库账号。
- 不要提交 `.env`、`history.json`、日志、数据库文件或用户上传内容。

