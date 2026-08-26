# 企业微信智能机器人 ↔ Open WebUI 桥接

该桥接程序使用企业微信智能机器人 WebSocket 长连接，将企微文本、图片及图文混排消息转发给本机 Open WebUI，并把文字和生成图片返回企业微信。无需公网 IP、域名、端口转发或内网穿透。

## 功能概览

- 企业微信智能机器人 WebSocket 长连接、心跳和自动重连；
- 支持单聊、群聊、用户及群聊白名单；
- 支持文本、图片、图文混排和视觉模型输入；
- 保留 Open WebUI 模型、知识库、工作区工具和服务器端工具循环；
- 支持生成图片下载、企微临时素材上传及私聊/群聊发送；
- 提供带鉴权的主动消息触发接口，可由定时任务或业务系统调用；
- 面向 Windows 主机提供 PowerShell 安装和启动脚本。

```text
企业微信用户/群聊
        ↕ WebSocket
wecom-openwebui-bridge
        ↕ HTTP API
Open WebUI → 模型 / 知识库 / 工具
```

> 本项目是社区项目，与腾讯、企业微信或 Open WebUI 官方无隶属或背书关系。生产使用前请自行完成权限、合规、日志脱敏和数据安全评估。

## 1. 企业微信侧

1. 在企业微信管理端进入“智能机器人”。
2. 选择手动创建，并切换到“API 模式”。
3. 连接方式选择“使用长连接”。
4. 保存 `Bot ID` 和只显示一次的 `Secret`。
5. 将机器人配置到允许使用的成员或群聊范围。

## 2. Open WebUI 侧

1. 建议创建独立的非管理员账号，例如 `wecom-bot`。
2. 仅给该账号授权需要的模型、知识库和工具。
3. 管理员在“设置 → Authentication”启用 API Keys。
4. 使用 `wecom-bot` 登录，在“设置 → Account → Secrets”创建 API Key。
5. 记下真实模型 ID 和工具 ID：工具 ID 可在工具编辑页 URL、工具列表 API或浏览器网络请求中查看。

如果使用本项目附带的 [`openwebui-tools/wan27_token_plan_tool.py`](openwebui-tools/wan27_token_plan_tool.py)，请将其完整代码粘贴到 Open WebUI 的 Wan 工具编辑页并保存。1.5.0 版会在服务器端下载短时效 OSS 图片，并保存到当前用户自己的 Open WebUI 文件空间，再把本地文件 URL 附加到助手消息。保存后检查工具 Valves 中的 `TOKEN_PLAN_API_KEY` 仍已配置；不要把密钥直接写进代码。

在 `.env` 中单独配置 Wan 工具 ID，图片请求将只挂载此工具并明确要求模型调用：

```text
OPENWEBUI_IMAGE_TOOL_ID=wan27_token_plan_tool
```

如果启用 API Key 路径限制，本桥接至少需要这些路径：

```text
/api/v1/chats
/api/chat/completions
/api/tasks/chat
```

## 3. Windows 安装

安装 Node.js 20 LTS 或更高版本，然后在 PowerShell 中运行：

```powershell
Set-Location "此项目所在目录"
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

安装脚本会生成 `.env`。用记事本打开并填写：

```powershell
notepad .env
```

最少需要填写：

```text
WECOM_BOT_ID=
WECOM_BOT_SECRET=
OPENWEBUI_URL=http://127.0.0.1:1145
OPENWEBUI_API_KEY=
OPENWEBUI_MODEL=
ALLOWED_USER_IDS=
```

初次不知道 UserID 时，可临时填写本人已知 UserID；未授权用户给机器人发消息时，回复和控制台都会显示其 UserID。得到后写入 `ALLOWED_USER_IDS` 并重启。不要长期配置 `ALLOWED_USER_IDS=*`。

## 4. 启动

确保 Open WebUI 已运行，然后执行：

```powershell
.\start.ps1
```

出现下面两类信息即说明连接成功：

```text
企业微信机器人认证成功，桥接服务已就绪。
收到消息：userid=...
```

在企业微信中测试：

```text
/status
你好
请查询数据库中的表并总结
请使用 Wan 生成一张图片
发送一张图片
发送图片并附带文字“识别图中的设备和文字”
```

## 5. 工具与知识库

- `OPENWEBUI_TOOL_IDS` 填工作区工具 ID，而不是工具显示名称；多个 ID 用英文逗号分隔。
- 知识库绑定到 `OPENWEBUI_MODEL` 对应的 Open WebUI 自定义模型。
- 桥接使用 Open WebUI 的原生服务器端工具循环，因此保留 `session_id`，可以使用知识库和多轮工具调用。
- 图片工具返回 Markdown 图片时，桥接会下载白名单域名中的图片并作为企微图片消息发送。
- 单聊和群聊都使用“上传临时素材 → 按 UserID/群 ChatID 主动发送图片”；文字回答仍使用流式回复，规避不同企微客户端不显示流式图片附件的问题。
- 图片来源同时从回答正文、助手消息 `files/output` 和 `chat:message:files` 流式事件提取；Open WebUI 本机文件地址会携带 API Key 下载。
- 视觉输入使用标准 `image_url` Base64 内容块。所选模型必须支持视觉，并在 Open WebUI 模型配置中启用 Vision 能力。
- 支持企微单独图片、图文混排，以及引用图片后发送文本提问。
- 图片只在当前请求中交给模型，不写入 `history.json`；需要重新查看原图时请再次发送或引用图片。

## 6. 对话命令

```text
/help    显示帮助
/whoami  显示 UserID 和群 ChatID
/reset   清空当前企微会话上下文
/status  查看非敏感运行状态
```

短期上下文保存在 `history.json`，不会存储机器人 Secret 或 Open WebUI API Key。将 `MAX_HISTORY_MESSAGES=0` 可关闭本地上下文。

## 7. 图片输入配置

`.env` 中的默认配置为：

```text
ENABLE_IMAGE_INPUT=true
MAX_INPUT_IMAGE_BYTES=10485760
MAX_INPUT_IMAGES=4
INPUT_IMAGE_DETAIL=auto
```

- 支持 JPEG、PNG、GIF 和 WebP。
- `MAX_INPUT_IMAGE_BYTES` 是单张图片的字节上限。
- `MAX_INPUT_IMAGES` 是一条消息最多携带的图片数量。
- `INPUT_IMAGE_DETAIL` 可填 `auto`、`low` 或 `high`；若后端不支持该参数，使用 `auto`。
- 图片以内联 Base64 送入 Open WebUI，不会上传到知识库，也不会写入本地历史文件。

## 8. 主动消息触发器

1.7.0 版提供本机 HTTP 入口。外部定时任务、数据库监控程序或业务系统在条件成立后调用该入口，桥接程序即可主动向指定企微用户或群聊发送消息。触发器负责发送，不负责判断业务条件。

在 `.env` 中启用：

```text
TRIGGER_API_ENABLED=true
TRIGGER_API_HOST=127.0.0.1
TRIGGER_API_PORT=8787
TRIGGER_API_TOKEN=替换为至少16个字符的随机Token
TRIGGER_MAX_BODY_BYTES=15728640
TRIGGER_MAX_MEDIA_BYTES=10485760
```

旧版本升级时，需要手动把以上配置追加到已有 `.env`。PowerShell 生成 32 字节随机 Token：

```powershell
$tokenBytes = New-Object byte[] 32
$tokenRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$tokenRng.GetBytes($tokenBytes)
$tokenRng.Dispose()
$triggerToken = -join ($tokenBytes | ForEach-Object { $_.ToString("x2") })
$triggerToken
```

复制最后输出的 64 位字符串填入 `TRIGGER_API_TOKEN`。以上每行分别执行即可，不要在行尾添加 `\`。

健康检查：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/health"
```

主动发送文字：

```powershell
$triggerToken = "替换为TRIGGER_API_TOKEN"
$triggerHeaders = @{ Authorization = "Bearer $triggerToken" }
$triggerBody = @{
    request_id = "stock-warning-20260826-001"
    chatid = "替换为群chatid"
    message_type = "markdown"
    content = "## 库存告警`n物料 A 已低于安全库存。"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/trigger" -Headers $triggerHeaders -ContentType "application/json; charset=utf-8" -Body $triggerBody
```

让 Open WebUI 先调用模型、知识库和工具生成内容，再主动发送：

```powershell
$triggerBody = @{
    request_id = "daily-report-20260826"
    userid = "替换为企微userid"
    message_type = "ai"
    content = "查询今天的业务数据，生成一份简洁日报并标出异常。"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/trigger" -Headers $triggerHeaders -ContentType "application/json; charset=utf-8" -Body $triggerBody
```

请求字段：

- 单聊直接提供 `userid`，群聊直接提供 `chatid`，二者只能提供一个；目标仍须在现有白名单中。
- 通用调用方也可以改用 `target_type`（`user`/`group`）和 `target_id` 这组字段。
- `message_type`：支持 `text`、`markdown`、`image`、`file`、`voice`、`video`、`template_card`、`ai`。
- `content`：文字、Markdown 或 AI 提示词。
- `request_id`：可选的幂等键。调用方因超时重试时使用相同值，可防止重复发送。
- 媒体消息使用 `media_base64` 和 `filename`；图片还可使用受 `IMAGE_DOWNLOAD_DOMAINS` 限制的 `media_url`。
- 模板卡片使用 `template_card` 对象，内容格式遵循企业微信模板卡片协议。

接口默认只监听 `127.0.0.1`。如果触发程序在另一台机器上，不建议直接把端口暴露到公网；可改为局域网地址，并同时配置 Windows 防火墙来源限制、足够长的 Token 和 HTTPS 反向代理。

## 9. 安全原则

- 不要把 Open WebUI 的 1145 端口映射到公网。
- 不要使用管理员账户的 API Key。
- SQL 工具使用只读数据库账户。
- `ALLOWED_USER_IDS` 和 `ALLOWED_GROUP_IDS` 使用明确白名单。
- `.env` 不要发送给他人或提交到 Git。
- 定期轮换企业微信 Secret 和 Open WebUI API Key。
- 若图片下载不需要，设置 `SEND_MARKDOWN_IMAGES=false`。
- 若不允许用户向模型发送图片，设置 `ENABLE_IMAGE_INPUT=false`。
- 主动触发目标仍必须加入 `ALLOWED_USER_IDS` 或 `ALLOWED_GROUP_IDS`；群聊还需设置 `ALLOW_GROUPS=true`。
- 不要把 `TRIGGER_API_TOKEN` 放进提示词、知识库或前端代码。

## 10. 开机运行

测试稳定后，可以使用 Windows 任务计划程序运行 `start.ps1`：

1. 触发器选择“计算机启动时”。
2. 操作选择启动 `powershell.exe`。
3. 参数填写：

```text
-NoProfile -ExecutionPolicy Bypass -File "项目绝对路径\start.ps1"
```

4. 勾选“使用最高权限运行”。
5. 配置失败后每 1 分钟重新启动。

## 11. 兼容性

- Node.js 20 或更高版本；
- Windows 10/11 或 Windows Server；核心 Node.js 服务也可在 Linux 上运行，但附带安装脚本为 PowerShell；
- Open WebUI 后端 API。Open WebUI 的内部聊天和工具接口可能随版本变化，升级 Open WebUI 后请先在测试环境验证；
- 企业微信智能机器人 API 模式和 WebSocket 长连接。

## 12. 参与贡献与许可证

- 变更记录见 [CHANGELOG.md](CHANGELOG.md)。
- 贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。
- 本项目使用 [MIT License](LICENSE)。

