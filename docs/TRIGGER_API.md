# 主动消息触发器 API 接入文档

适用版本：WeCom Open WebUI Bridge v1.9.0 及以上
用途：供同一台 Windows 主机上的业务程序调用，将文本、AI 结果或媒体主动推送给指定企业微信用户或群聊。

## 1. 快速接入信息

把下面这段信息提供给调用方开发者即可开始联调：

```text
服务地址：http://127.0.0.1:8787
单目标接口：POST /api/trigger
批量接口：POST /api/trigger/batch
健康检查：GET /health
认证方式：Authorization: Bearer <TRIGGER_API_TOKEN>
请求格式：application/json; charset=utf-8
```

指定用户发送文本的最小请求：

```http
POST /api/trigger HTTP/1.1
Host: 127.0.0.1:8787
Authorization: Bearer <TRIGGER_API_TOKEN>
Content-Type: application/json; charset=utf-8

{
  "request_id": "event-20260827-0001",
  "bot_key": "default",
  "userid": "目标企业微信userid",
  "message_type": "text",
  "content": "这是一条业务通知。"
}
```

## 2. 桥接程序配置

桥接程序的 `.env` 至少需要以下配置：

```env
TRIGGER_API_ENABLED=true
TRIGGER_API_HOST=127.0.0.1
TRIGGER_API_PORT=8787
TRIGGER_API_TOKEN=替换为至少16个字符的随机Token

ALLOWED_USER_IDS=userid-001,userid-002
ALLOW_GROUPS=false
ALLOWED_GROUP_IDS=
```

修改 `.env` 后重启桥接程序：

```powershell
node .\index.js
```

控制台出现以下信息表示接口已经监听：

```text
主动消息触发器接口：http://127.0.0.1:8787/api/trigger
```

注意：

- 推送目标必须存在于 `ALLOWED_USER_IDS` 或 `ALLOWED_GROUP_IDS` 白名单。
- 群聊推送还需要设置 `ALLOW_GROUPS=true`。
- 两个程序在同一台电脑时保持 `TRIGGER_API_HOST=127.0.0.1`，无需开放防火墙端口。
- 调用程序不需要 Open WebUI API Key，也不需要企业微信机器人 Secret，只需要触发器 Token。

### 配置多个机器人

```env
WECOM_BOT_KEYS=default,sales
WECOM_DEFAULT_BOT_KEY=default

WECOM_BOT_DEFAULT_ID=填写第一个BotID
WECOM_BOT_DEFAULT_SECRET=填写第一个Secret
WECOM_BOT_DEFAULT_NAME=通用助手

WECOM_BOT_SALES_ID=填写第二个BotID
WECOM_BOT_SALES_SECRET=填写第二个Secret
WECOM_BOT_SALES_NAME=销售助手
WECOM_BOT_SALES_ALLOWED_USER_IDS=userid-001,userid-002
WECOM_BOT_SALES_ALLOW_GROUPS=true
WECOM_BOT_SALES_ALLOWED_GROUP_IDS=chatid-001
```

设置 `WECOM_BOT_KEYS` 后，旧的 `WECOM_BOT_ID/WECOM_BOT_SECRET` 被忽略。每个机器人可设置独立白名单；没有设置机器人专属白名单时继承全局 `ALLOWED_*`。主动推送通过 `bot_key` 选择机器人，省略时使用 `WECOM_DEFAULT_BOT_KEY`。

## 3. 身份认证

推荐使用 Bearer Token：

```http
Authorization: Bearer <TRIGGER_API_TOKEN>
```

也兼容以下请求头：

```http
X-Trigger-Token: <TRIGGER_API_TOKEN>
```

不要把 Token 放在 URL、查询参数、日志、前端代码或 Git 仓库中。建议通过调用程序自己的环境变量读取：

```env
WECOM_TRIGGER_URL=http://127.0.0.1:8787
WECOM_TRIGGER_TOKEN=替换为TRIGGER_API_TOKEN
```

## 4. 健康检查

### 请求

```http
GET /health
```

健康检查不要求 Token。

### 响应示例

```json
{
  "ok": true,
  "version": "1.9.0",
  "wecom_connected": true,
  "connected_bot_count": 2,
  "default_bot_key": "default",
  "bots": [
    {"key": "default", "name": "通用助手", "connected": true, "default": true},
    {"key": "sales", "name": "销售助手", "connected": true, "default": false}
  ],
  "trigger_api_enabled": true,
  "trigger_admin_enabled": true
}
```

只有 `wecom_connected=true` 时才具备实际推送条件。建议调用程序启动后先检查一次；发送遇到 `503` 时稍后重试。

## 5. 单目标推送

### 接口

```text
POST /api/trigger
```

### 公共请求字段

| 字段 | 类型 | 必填 | 说明 |
|---|---:|:---:|---|
| `request_id` | string | 否 | 幂等键，1～128 个字符；省略时由桥接程序生成 |
| `bot_key` | string | 否 | 发送机器人；省略时使用默认机器人，多机器人调用建议明确填写 |
| `userid` | string | 条件必填 | 单聊用户 ID，与 `chatid` 二选一 |
| `chatid` | string | 条件必填 | 群聊 ID，与 `userid` 二选一 |
| `target_type` | string | 条件必填 | 通用写法，可填 `user` 或 `group` |
| `target_id` | string | 条件必填 | 与 `target_type` 配套使用 |
| `message_type` | string | 是 | 消息类型，见下一节 |

目标有两种等价写法。

推荐的明确字段：

```json
{
  "userid": "userid-001"
}
```

通用字段：

```json
{
  "target_type": "user",
  "target_id": "userid-001"
}
```

不要在同一次请求中同时提供 `userid` 和 `chatid`。

## 6. 消息类型

支持以下 `message_type`：

| 类型 | 必要字段 | 说明 |
|---|---|---|
| `text` | `content` | 普通文字，当前通过企微 Markdown 消息发送 |
| `markdown` | `content` | Markdown 内容 |
| `ai` | `content` 或 `prompt` | 先调用 Open WebUI 模型、知识库和工具，再发送结果 |
| `image` | `media_base64` 或 `media_url` | 图片文件或允许域名中的 HTTPS 图片 |
| `file` | `media_base64` | 文件 |
| `voice` | `media_base64` | 企微支持的语音文件 |
| `video` | `media_base64` | 视频，可附带标题和说明 |
| `template_card` | `template_card` | 企业微信模板卡片对象 |

### 6.1 文本或 Markdown

```json
{
  "request_id": "inventory-warning-001",
  "userid": "userid-001",
  "message_type": "markdown",
  "content": "## 库存告警\n物料 A 已低于安全库存。"
}
```

### 6.2 AI 生成后推送

```json
{
  "request_id": "daily-report-20260827",
  "userid": "userid-001",
  "message_type": "ai",
  "content": "查询今天的业务数据，生成简洁日报并标出异常。"
}
```

`ai` 模式会使用桥接程序现有的 Open WebUI 模型、知识库、工具和该目标的会话上下文。生成时间可能较长，调用方的 HTTP 超时时间建议不低于桥接程序的 `REQUEST_TIMEOUT_SECONDS`。

### 6.3 Base64 图片

```json
{
  "request_id": "image-notice-001",
  "userid": "userid-001",
  "message_type": "image",
  "filename": "notice.png",
  "media_base64": "iVBORw0KGgoAAA..."
}
```

`media_base64` 可以是纯 Base64，也可以是 Data URL：

```text
data:image/png;base64,iVBORw0KGgoAAA...
```

### 6.4 图片 URL

```json
{
  "request_id": "image-url-001",
  "userid": "userid-001",
  "message_type": "image",
  "media_url": "https://example.com/notice.png",
  "filename": "notice.png"
}
```

图片 URL 的域名必须被 `.env` 中的 `IMAGE_DOWNLOAD_DOMAINS` 允许。URL 方式目前只适用于 `image`。

### 6.5 文件

```json
{
  "request_id": "report-file-001",
  "userid": "userid-001",
  "message_type": "file",
  "filename": "report.xlsx",
  "media_base64": "UEsDBBQAAAA..."
}
```

### 6.6 视频

```json
{
  "request_id": "video-001",
  "userid": "userid-001",
  "message_type": "video",
  "filename": "demo.mp4",
  "media_base64": "AAAAHGZ0eXB...",
  "title": "演示视频",
  "description": "系统操作演示"
}
```

### 6.7 模板卡片

```json
{
  "request_id": "card-001",
  "userid": "userid-001",
  "message_type": "template_card",
  "template_card": {
    "card_type": "text_notice",
    "main_title": {
      "title": "业务提醒",
      "desc": "请及时处理"
    }
  }
}
```

`template_card` 内部格式应符合企业微信智能机器人模板卡片协议。

## 7. 批量推送

### 接口

```text
POST /api/trigger/batch
```

### 请求示例

```json
{
  "request_id": "batch-warning-20260827-001",
  "bot_key": "sales",
  "target_type": "user",
  "target_ids": [
    "userid-001",
    "userid-002",
    "userid-003"
  ],
  "message_type": "text",
  "content": "这是一条批量业务通知。"
}
```

批量接口规则：

- `target_type` 必须是 `user` 或 `group`。
- `bot_key` 对整批目标生效，所有目标由同一个机器人发送。
- `target_ids` 必须是数组。
- 空 ID 和重复 ID 会被忽略。
- 每个目标仍须通过白名单检查。
- 默认每批最多 500 个目标，并发数为 3，可通过 `.env` 调整。
- 某个目标失败不会中断其他目标。

### 响应示例

```json
{
  "request_id": "batch-warning-20260827-001",
  "ok": false,
  "bot_key": "sales",
  "bot_name": "销售助手",
  "total": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    {
      "ok": true,
      "target_type": "user",
      "target_id": "userid-001",
      "delivered_as": "markdown",
      "image_count": 0
    },
    {
      "ok": false,
      "target_id": "userid-003",
      "error": "目标用户 userid-003 不在 ALLOWED_USER_IDS 白名单中。"
    }
  ]
}
```

批量接口即使部分目标失败也会返回 HTTP `200`，调用方必须同时检查响应中的 `ok`、`failed` 和 `results`。

## 8. 成功与错误响应

### 单目标成功

```json
{
  "ok": true,
  "request_id": "event-20260827-0001",
  "bot_key": "default",
  "bot_name": "通用助手",
  "target_type": "user",
  "target_id": "userid-001",
  "delivered_as": "markdown",
  "image_count": 0
}
```

### 失败

```json
{
  "ok": false,
  "error": "触发器 Token 无效。"
}
```

### 常见 HTTP 状态码

| 状态码 | 含义 | 调用方处理建议 |
|---:|---|---|
| `200` | 请求已处理 | 继续检查 JSON 中的 `ok` |
| `400` | 参数、JSON、Base64 或目标格式错误 | 修正请求，不要原样重试 |
| `401` | Token 缺失或错误 | 检查调用程序环境变量 |
| `403` | 用户或群聊不在白名单 | 修改桥接程序白名单后重启 |
| `404` | 接口路径不存在 | 检查 URL 和桥接版本 |
| `405` | 请求方法错误 | 使用指定的 GET/POST 方法 |
| `413` | 请求体、媒体或表格超过限制 | 压缩文件或调整限制 |
| `415` | JSON 接口 Content-Type 错误 | 使用 `application/json` |
| `503` | 企业微信长连接未就绪 | 延迟后重试，并检查 `/health` |
| `500` | 桥接程序或下游服务异常 | 记录 `request_id` 和错误内容后排查 |

## 9. request_id 与重试

`request_id` 用于防止调用方因网络超时而重复发送。

推荐规则：

1. 每个新的业务事件生成一个新的 UUID。
2. 同一个事件因为网络超时而重试时，沿用原 `request_id`。
3. 新事件即使内容相同，也使用新的 `request_id`。
4. 不要长期使用固定字符串，例如 `test` 或 `warning`。

相同 `request_id` 且请求内容相同时，响应可能包含：

```json
{
  "duplicate": true
}
```

这表示桥接程序返回了之前的成功结果，没有再次推送。

## 10. 调用示例

### 10.1 Node.js 20+

```javascript
const triggerUrl = process.env.WECOM_TRIGGER_URL ?? "http://127.0.0.1:8787";
const triggerToken = process.env.WECOM_TRIGGER_TOKEN;

export async function pushToUserid(userid, content, botKey = "default", requestId = crypto.randomUUID()) {
  const response = await fetch(`${triggerUrl}/api/trigger`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${triggerToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      request_id: requestId,
      bot_key: botKey,
      userid,
      message_type: "text",
      content,
    }),
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error ?? `HTTP ${response.status}`);
  }
  return result;
}
```

### 10.2 Python

```python
import os
import uuid
import requests

TRIGGER_URL = os.getenv("WECOM_TRIGGER_URL", "http://127.0.0.1:8787")
TRIGGER_TOKEN = os.environ["WECOM_TRIGGER_TOKEN"]


def push_to_userid(userid: str, content: str, bot_key="default", request_id: str | None = None):
    response = requests.post(
        f"{TRIGGER_URL}/api/trigger",
        headers={"Authorization": f"Bearer {TRIGGER_TOKEN}"},
        json={
            "request_id": request_id or str(uuid.uuid4()),
            "bot_key": bot_key,
            "userid": userid,
            "message_type": "text",
            "content": content,
        },
        timeout=30,
    )
    result = response.json()
    response.raise_for_status()
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "企微消息发送失败"))
    return result
```

### 10.3 PowerShell 5.1+

```powershell
$triggerUrl = "http://127.0.0.1:8787"
$triggerToken = $env:WECOM_TRIGGER_TOKEN

$headers = @{
    Authorization = "Bearer $triggerToken"
}

$body = @{
    request_id  = [guid]::NewGuid().ToString()
    bot_key     = "default"
    userid      = "userid-001"
    message_type = "text"
    content     = "这是一条接口测试消息。"
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "$triggerUrl/api/trigger" `
    -Headers $headers `
    -ContentType "application/json; charset=utf-8" `
    -Body $body
```

## 11. 表格导入接口

浏览器管理页面使用以下接口解析 XLSX、CSV、TSV 或 TXT。普通业务程序集成通常不需要调用它。

```text
POST /api/trigger/import
Authorization: Bearer <TRIGGER_API_TOKEN>
Content-Type: application/octet-stream
X-File-Name: users.xlsx
X-Target-Type: user
```

请求体为原始文件二进制。`X-Target-Type` 可填 `user` 或 `group`。

响应示例：

```json
{
  "ok": true,
  "ids": ["userid-001", "userid-002"],
  "target_column": "userid",
  "row_count": 3,
  "duplicate_or_empty_count": 1
}
```

识别的表头包括 `userid`、`user_id`、`chatid`、`chat_id`、`target_id` 和 `id`。没有识别到表头时读取第一列。

## 12. 默认限制

```env
TRIGGER_MAX_BODY_BYTES=15728640
TRIGGER_MAX_MEDIA_BYTES=10485760
TRIGGER_BATCH_MAX_TARGETS=500
TRIGGER_BATCH_CONCURRENCY=3
TRIGGER_IMPORT_MAX_BYTES=5242880
```

- `TRIGGER_MAX_BODY_BYTES`：JSON 请求体上限。
- `TRIGGER_MAX_MEDIA_BYTES`：Base64 解码后单个媒体文件上限。
- `TRIGGER_BATCH_MAX_TARGETS`：单次批量目标数量上限。
- `TRIGGER_BATCH_CONCURRENCY`：批量发送并发数。
- `TRIGGER_IMPORT_MAX_BYTES`：上传表格大小上限。

## 13. 联调检查清单

- [ ] 桥接程序控制台显示企业微信机器人认证成功。
- [ ] `GET /health` 返回 `wecom_connected=true`。
- [ ] 调用程序能读取 `WECOM_TRIGGER_TOKEN` 环境变量。
- [ ] 请求使用 `Authorization: Bearer ...`。
- [ ] 目标 userid 已加入 `ALLOWED_USER_IDS`。
- [ ] 每个新业务事件使用新的 `request_id`。
- [ ] 调用程序同时检查 HTTP 状态码和 JSON `ok`。
- [ ] 日志不打印 Token、媒体 Base64 或其他密钥。
- [ ] 只监听 `127.0.0.1`，除非确实需要局域网调用。
