import { randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AiBot, { generateReqId } from "@wecom/aibot-node-sdk";
import dotenv from "dotenv";

import { parseTargetSpreadsheet } from "./spreadsheet-import.js";
import { resolveTriggerTarget, triggerRequestFingerprint } from "./trigger-utils.js";


const BRIDGE_VERSION = "1.8.0";
const projectDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(projectDir, ".env") });


function requiredEnv(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value || value.startsWith("填写")) {
    throw new Error(`缺少必要配置：${name}`);
  }
  return value;
}


function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}


function envInt(name, defaultValue, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? defaultValue : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}


function envList(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}


function envChoice(name, defaultValue, choices) {
  const value = (process.env[name] ?? defaultValue).trim().toLowerCase();
  if (!choices.includes(value)) {
    throw new Error(`${name} 必须是以下值之一：${choices.join(", ")}`);
  }
  return value;
}


const configuredToolIds = envList("OPENWEBUI_TOOL_IDS");


const config = {
  wecomBotId: requiredEnv("WECOM_BOT_ID"),
  wecomBotSecret: requiredEnv("WECOM_BOT_SECRET"),
  openWebUIUrl: requiredEnv("OPENWEBUI_URL").replace(/\/+$/, ""),
  openWebUIApiKey: requiredEnv("OPENWEBUI_API_KEY"),
  openWebUIModel: requiredEnv("OPENWEBUI_MODEL"),
  toolIds: configuredToolIds,
  imageToolId: (process.env.OPENWEBUI_IMAGE_TOOL_ID ?? "").trim()
    || configuredToolIds.find((toolId) => /(?:wan|image)/i.test(toolId))
    || "",
  allowedUserIds: new Set(envList("ALLOWED_USER_IDS")),
  allowGroups: envBool("ALLOW_GROUPS", false),
  allowedGroupIds: new Set(envList("ALLOWED_GROUP_IDS")),
  maxHistoryMessages: envInt("MAX_HISTORY_MESSAGES", 20, 0, 100),
  maxReplyChars: envInt("MAX_REPLY_CHARS", 12000, 1000, 50000),
  requestTimeoutMs: envInt("REQUEST_TIMEOUT_SECONDS", 600, 30, 1800) * 1000,
  deleteTempChats: envBool("DELETE_TEMP_CHATS", true),
  historyFile: path.resolve(projectDir, process.env.HISTORY_FILE || "history.json"),
  systemPrompt: (process.env.SYSTEM_PROMPT ?? "").trim(),
  features: {
    web_search: envBool("ENABLE_WEB_SEARCH", false),
    code_interpreter: envBool("ENABLE_CODE_INTERPRETER", false),
    image_generation: envBool("ENABLE_IMAGE_GENERATION", false),
    memory: envBool("ENABLE_MEMORY", false),
  },
  enableImageInput: envBool("ENABLE_IMAGE_INPUT", true),
  maxInputImageBytes: envInt(
    "MAX_INPUT_IMAGE_BYTES",
    10 * 1024 * 1024,
    1024,
    50 * 1024 * 1024,
  ),
  maxInputImages: envInt("MAX_INPUT_IMAGES", 4, 1, 10),
  inputImageDetail: envChoice("INPUT_IMAGE_DETAIL", "auto", ["auto", "low", "high"]),
  sendMarkdownImages: envBool("SEND_MARKDOWN_IMAGES", true),
  maxImageBytes: envInt("MAX_IMAGE_BYTES", 10 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  maxImagesPerReply: envInt("MAX_IMAGES_PER_REPLY", 4, 0, 10),
  imageDownloadDomains: envList("IMAGE_DOWNLOAD_DOMAINS").map((item) => item.toLowerCase()),
  triggerApiEnabled: envBool("TRIGGER_API_ENABLED", false),
  triggerApiHost: (process.env.TRIGGER_API_HOST ?? "127.0.0.1").trim(),
  triggerApiPort: envInt("TRIGGER_API_PORT", 8787, 1, 65535),
  triggerApiToken: (process.env.TRIGGER_API_TOKEN ?? "").trim(),
  triggerMaxBodyBytes: envInt("TRIGGER_MAX_BODY_BYTES", 15 * 1024 * 1024, 1024, 70 * 1024 * 1024),
  triggerMaxMediaBytes: envInt("TRIGGER_MAX_MEDIA_BYTES", 10 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  triggerAdminEnabled: envBool("TRIGGER_ADMIN_ENABLED", true),
  triggerBatchMaxTargets: envInt("TRIGGER_BATCH_MAX_TARGETS", 500, 1, 5000),
  triggerBatchConcurrency: envInt("TRIGGER_BATCH_CONCURRENCY", 3, 1, 20),
  triggerImportMaxBytes: envInt("TRIGGER_IMPORT_MAX_BYTES", 5 * 1024 * 1024, 1024, 20 * 1024 * 1024),
};


if (
  config.triggerApiEnabled
  && (
    config.triggerApiToken.length < 16
    || config.triggerApiToken.startsWith("填写")
  )
) {
  throw new Error("启用触发器接口时，TRIGGER_API_TOKEN 必须设置为至少 16 个字符的随机密钥。");
}


const histories = new Map();
const sessionQueues = new Map();
const processedMessageIds = new Set();
const processedMessageOrder = [];
const triggerRequests = new Map();
const triggerRequestOrder = [];


async function loadHistories() {
  try {
    const content = await fs.readFile(config.historyFile, "utf8");
    const parsed = JSON.parse(content);
    for (const [key, messages] of Object.entries(parsed)) {
      if (Array.isArray(messages)) histories.set(key, messages);
    }
    console.log(`已载入 ${histories.size} 个会话的本地历史。`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`读取历史文件失败，将使用空历史：${error.message}`);
    }
  }
}


async function saveHistories() {
  const tempFile = `${config.historyFile}.tmp`;
  const data = Object.fromEntries(histories.entries());
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempFile, config.historyFile);
}


function rememberMessageId(messageId) {
  if (!messageId) return true;
  if (processedMessageIds.has(messageId)) return false;

  processedMessageIds.add(messageId);
  processedMessageOrder.push(messageId);
  while (processedMessageOrder.length > 2000) {
    const oldest = processedMessageOrder.shift();
    processedMessageIds.delete(oldest);
  }
  return true;
}


function isUserAllowed(userId) {
  return config.allowedUserIds.has("*") || config.allowedUserIds.has(userId);
}


function isGroupAllowed(groupId) {
  if (!config.allowGroups) return false;
  return config.allowedGroupIds.has("*") || config.allowedGroupIds.has(groupId);
}


function sessionKeyFor(body) {
  if (body.chattype === "group") return `group:${body.chatid}`;
  return `user:${body.from?.userid ?? "unknown"}`;
}


function enqueueSession(sessionKey, task) {
  const previous = sessionQueues.get(sessionKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  sessionQueues.set(sessionKey, next);
  next.finally(() => {
    if (sessionQueues.get(sessionKey) === next) sessionQueues.delete(sessionKey);
  });
  return next;
}


async function requestJson(method, route, body = undefined, timeoutMs = config.requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.openWebUIUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.openWebUIApiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(`Open WebUI HTTP ${response.status}: ${detail.slice(0, 1500)}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Open WebUI 请求超时（${Math.round(timeoutMs / 1000)}秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}


function buildVisionContent(prompt, inputImages) {
  if (inputImages.length === 0) return prompt;

  return [
    { type: "text", text: prompt },
    ...inputImages.map((image) => ({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`,
        ...(config.inputImageDetail === "auto" ? {} : { detail: config.inputImageDetail }),
      },
    })),
  ];
}


function isImageGenerationRequest(prompt, inputImages = []) {
  if (inputImages.length > 0) return false;
  return /(生成|创建|制作|绘制|画|做|来一张|给我一张).{0,18}(图片|图像|插画|海报|照片|头像|logo)|(图片|图像|插画|海报|照片|头像|logo).{0,18}(生成|创建|制作|绘制|画)/i.test(prompt);
}


function buildCompletionMessages(history, prompt, inputImages = []) {
  const messages = [];
  const systemParts = [];
  const imageRequest = isImageGenerationRequest(prompt, inputImages);
  if (config.systemPrompt) systemParts.push(config.systemPrompt);
  if (imageRequest) {
    systemParts.push(
      "这是一项图片生成请求。必须实际调用当前可用的图像生成工具，并等待工具返回成功结果后再回答。"
      + "禁止仅用文字描述冒充图片，禁止在没有工具结果时声称图片已生成；工具失败时必须如实报告。"
      + "如果工具结果包含 WAN_ 开头的机器标记，最终回答必须逐行原样保留，不得修改、省略或重新编码。",
    );
  }
  if (systemParts.length > 0) messages.push({ role: "system", content: systemParts.join("\n\n") });
  // Previous assistant messages may contain expired or hallucinated signed
  // image URLs. Preserve recent user intent while excluding those answers.
  const effectiveHistory = imageRequest ? [] : history;
  messages.push(...effectiveHistory);
  const routedPrompt = imageRequest
    ? (
      "请立即调用 generate_wan_image 工具完成下面的图片生成任务。"
      + "必须以工具实际返回的结果为准，不要自行编造图片链接。\n\n"
      + `图片要求：${prompt.replace(/^@\S+\s*/u, "")}`
    )
    : prompt;
  messages.push({ role: "user", content: buildVisionContent(routedPrompt, inputImages) });
  return messages;
}


function extractAssistantText(assistantMessage) {
  if (typeof assistantMessage?.content === "string" && assistantMessage.content.trim()) {
    return assistantMessage.content.trim();
  }

  const textParts = [];
  for (const outputItem of assistantMessage?.output ?? []) {
    if (outputItem?.type !== "message" || outputItem?.role !== "assistant") continue;
    for (const part of outputItem.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
        textParts.push(part.text.trim());
      }
    }
  }
  return textParts.join("\n").trim();
}


async function runOpenWebUI(history, prompt, inputImages = []) {
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let chatId = null;

  try {
    const created = await requestJson("POST", "/api/v1/chats/new", {
      chat: {
        title: "WeCom API conversation",
        models: [config.openWebUIModel],
        history: {
          currentId: assistantMessageId,
          messages: {
            [userMessageId]: {
              id: userMessageId,
              role: "user",
              content: prompt,
              timestamp: now,
              models: [config.openWebUIModel],
              childrenIds: [assistantMessageId],
            },
            [assistantMessageId]: {
              id: assistantMessageId,
              role: "assistant",
              content: "",
              parentId: userMessageId,
              childrenIds: [],
              model: config.openWebUIModel,
              modelName: config.openWebUIModel,
              modelIdx: 0,
              done: false,
              timestamp: now + 1,
            },
          },
        },
      },
    });

    chatId = created?.id;
    if (!chatId) throw new Error("Open WebUI 创建聊天后没有返回 chat id。 ");

    const completionBody = {
      model: config.openWebUIModel,
      messages: buildCompletionMessages(history, prompt, inputImages),
      stream: true,
      chat_id: chatId,
      id: assistantMessageId,
      features: config.features,
      background_tasks: {
        title_generation: false,
        tags_generation: false,
        follow_up_generation: false,
      },
    };

    const imageRequest = isImageGenerationRequest(prompt, inputImages);
    if (imageRequest && config.imageToolId) {
      completionBody.tool_ids = [config.imageToolId];
      // Some OpenAI-compatible providers terminate without output when they
      // receive tool_choice="required". Supplying only the Wan tool plus the
      // explicit routed prompt keeps server-side execution compatible.
      console.log(
        `图片工具路由：仅挂载 ${config.imageToolId}，`
        + "使用阻塞模式调用 generate_wan_image，请等待生成完成。",
      );
    } else {
      if (config.toolIds.length > 0) completionBody.tool_ids = config.toolIds;
      // session_id enables Open WebUI's asynchronous native loop and built-in
      // tools. The image-only path intentionally omits it: workspace tools can
      // then run in the documented blocking variant without task-index races.
      completionBody.session_id = `wecom-${randomUUID()}`;
    }

    const completionStartedAt = Date.now();
    const completionResponse = await requestJson("POST", "/api/chat/completions", completionBody);
    if (imageRequest) {
      console.log(
        `图片工具调用已返回，耗时 ${Math.round((Date.now() - completionStartedAt) / 1000)} 秒，读取结果。`,
      );
    }

    const deadline = Date.now() + config.requestTimeoutMs;
    const acceptedTaskIds = Array.isArray(completionResponse?.task_ids)
      ? completionResponse.task_ids.filter(Boolean)
      : [];
    if (acceptedTaskIds.length > 0) {
      console.log(`Open WebUI 已接受 ${acceptedTaskIds.length} 个后台任务，等待完成。`);
      // Avoid the race where /api/tasks/chat is queried before the newly
      // accepted task has been registered in the per-chat task index.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    while (Date.now() < deadline) {
      const tasks = await requestJson("GET", `/api/tasks/chat/${encodeURIComponent(chatId)}`);
      if (!Array.isArray(tasks?.task_ids) || tasks.task_ids.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (Date.now() >= deadline) {
      throw new Error("等待 Open WebUI 模型任务完成时超时。 ");
    }

    // Task removal and chat persistence are separate writes. Poll the saved
    // assistant message briefly so a completed task cannot be mistaken for an
    // empty response.
    let savedChat = null;
    let assistantMessage = null;
    const persistenceDeadline = Math.min(deadline, Date.now() + 30000);
    while (Date.now() < persistenceDeadline) {
      savedChat = await requestJson("GET", `/api/v1/chats/${encodeURIComponent(chatId)}`);
      const messages = savedChat?.chat?.history?.messages;
      assistantMessage = messages?.[assistantMessageId];
      const hasContent = typeof assistantMessage?.content === "string"
        && assistantMessage.content.trim().length > 0;
      const hasOutput = Array.isArray(assistantMessage?.output)
        && assistantMessage.output.length > 0;
      const hasFiles = Array.isArray(assistantMessage?.files)
        && assistantMessage.files.length > 0;
      if (hasContent || hasOutput || hasFiles) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    const imageSources = collectAssistantImageSources(
      assistantMessage,
      assistantMessage?.content ?? "",
      [completionResponse],
    );
    const answer = extractAssistantText(assistantMessage)
      || (imageSources.length > 0 ? "图片已生成。" : "");

    if (!answer) {
      const output = assistantMessage?.output;
      throw new Error(
        "Open WebUI 没有生成正文或文件。"
        + `助手消息=${JSON.stringify(assistantMessage)?.slice(0, 1500)}；`
        + `启动响应=${JSON.stringify(completionResponse)?.slice(0, 1500)}；`
        + `output=${JSON.stringify(output)?.slice(0, 1500)}`,
      );
    }

    if (imageSources.length === 0 && Array.isArray(assistantMessage?.output)) {
      console.warn(`Open WebUI output 脱敏摘要：${outputSummaryForLog(assistantMessage.output)}`);
    }
    const wanDiagnostics = [...answer.matchAll(/WAN_(?:TOOL_VERSION|LOCAL_CACHE|DB_PERSIST):[^\r\n]*/g)]
      .map((match) => match[0]);
    const persistedFileCount = Array.isArray(assistantMessage?.files)
      ? assistantMessage.files.length
      : 0;
    const diagnosticText = wanDiagnostics.length > 0
      ? wanDiagnostics.join("；")
      : persistedFileCount > 0
        ? `files=${persistedFileCount}，图片已持久化（模型未转述机器标记）`
        : "未收到，且 files=0（本轮可能没有执行图片工具）";
    console.log(`Wan 工具诊断：${diagnosticText}`);
    const replyImages = await buildReplyImages(answer, imageSources);
    const displayAnswer = cleanMachineImageMarkers(answer)
      || (replyImages.length > 0 ? "图片已生成。" : answer);
    console.log(
      `Open WebUI 图片结构：files=${Array.isArray(assistantMessage?.files) ? assistantMessage.files.length : 0}, `
      + `output=${Array.isArray(assistantMessage?.output) ? assistantMessage.output.length : 0}, `
      + `候选=${imageSources.length}, 下载成功=${replyImages.length}`,
    );
    if (imageSources.length > 0) {
      console.log(`图片候选摘要：${imageSources.map(imageSourceSummary).join(", ")}`);
    }
    return { answer: displayAnswer, replyImages };
  } finally {
    if (chatId && config.deleteTempChats) {
      try {
        await requestJson("DELETE", `/api/v1/chats/${encodeURIComponent(chatId)}`, undefined, 30000);
      } catch (error) {
        console.warn(`删除临时 Open WebUI 聊天失败：${error.message}`);
      }
    }
  }
}


function markdownImageUrls(markdown) {
  const urls = [];
  // Accept both image Markdown and ordinary download links emitted by tools.
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    if (!urls.includes(match[1])) urls.push(match[1]);
  }
  return urls;
}


function machineImageUrls(text) {
  const urls = [];
  if (typeof text !== "string") return urls;
  const pattern = /WAN_IMAGE_URL_B64:([A-Za-z0-9_-]+={0,2})/g;
  for (const match of text.matchAll(pattern)) {
    try {
      const decoded = Buffer.from(match[1], "base64url").toString("utf8").trim();
      if (
        (
          decoded.startsWith("https://")
          || decoded.startsWith("http://")
          || decoded.startsWith("/api/v1/files/")
          || decoded.startsWith("api/v1/files/")
        )
        && !urls.includes(decoded)
      ) {
        urls.push(decoded);
      }
    } catch {
      // Ignore malformed machine markers and continue scanning ordinary URLs.
    }
  }
  return urls;
}


function cleanMachineImageMarkers(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/WAN_IMAGE_URL_B64:[A-Za-z0-9_-]+={0,2}/g, "")
    .replace(/^\s*WAN_(?:TOOL_VERSION|LOCAL_CACHE|DB_PERSIST):[^\r\n]*(?:\r?\n|$)/gmu, "")
    .replace(/^\s*系统集成要求：.*WAN_.*(?:\r?\n|$)/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


function collectAssistantImageSources(assistantMessage, answer, extraValues = []) {
  const sources = [];
  const seen = new Set();
  const add = (source) => {
    if (typeof source !== "string") return;
    const clean = source
      .trim()
      .replace(/^<|>$/g, "")
      .replace(/&amp;/gi, "&")
      .replace(/&#0*38;/gi, "&")
      .replace(/&#x0*26;/gi, "&")
      .replace(/\\([&?=])/g, "$1")
      // Wan tool output appends labels such as "：图片" or "：图片下载"
      // directly after signed URLs. Any such suffix invalidates the signature.
      .replace(/(?:：|%EF%BC%9A).*$/iu, "")
      .replace(/[，。；、]+$/u, "");
    if (isOpenWebUIUiAsset(clean)) return;
    if (!clean || seen.has(clean)) return;
    if (
      !clean.startsWith("data:image/")
      && !clean.startsWith("https://")
      && !clean.startsWith("http://")
      && !clean.startsWith("/api/v1/files/")
      && !clean.startsWith("api/v1/files/")
    ) return;
    seen.add(clean);
    sources.push(clean);
  };

  const visit = (value, imageContext = false, depth = 0) => {
    if (depth > 10 || value === null || value === undefined) return;
    if (typeof value === "string") {
      // Decode the exact URL emitted by the Wan tool before the language model
      // can alter any character in its signed query string.
      for (const source of machineImageUrls(value)) add(source);
      for (const source of markdownImageUrls(value)) add(source);
      for (const match of value.matchAll(/\/?api\/v1\/files\/[A-Za-z0-9_-]+\/content/g)) add(match[0]);
      for (const match of value.matchAll(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g)) add(match[0]);
      // Tool outputs are often Python repr strings rather than valid JSON.
      // Collect all absolute URL candidates here; downloadImage applies the
      // domain allowlist and verifies that the response is actually an image.
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>\\()[\]{}：，。；、]+/g)) {
        add(match[0].replace(/[),.;}\]]+$/, ""));
      }

      const trimmed = value.trim();
      for (const line of value.split(/\r?\n/)) {
        const payload = line.trim().replace(/^data:\s*/, "");
        if (!payload.startsWith("{") && !payload.startsWith("[")) continue;
        try {
          visit(JSON.parse(payload), imageContext, depth + 1);
        } catch {
          // Ignore non-JSON streaming lines.
        }
      }
      if ((trimmed.startsWith("{") && trimmed.endsWith("}"))
        || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          visit(JSON.parse(trimmed), imageContext, depth + 1);
        } catch {
          // Tool output is not always valid JSON; URL scans above still apply.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, imageContext, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const type = String(value.type ?? value.msgtype ?? value.content_type ?? "").toLowerCase();
    const objectIsImage = imageContext || type.includes("image");
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      const childImageContext = objectIsImage
        || ["image", "images", "image_url", "image_urls", "thumbnail", "src"].includes(normalizedKey);
      if (["b64_json", "bytesbase64encoded"].includes(normalizedKey) && typeof child === "string") {
        add(`data:image/png;base64,${child}`);
      }
      if (["url", "src"].includes(normalizedKey) && childImageContext) add(child);
      visit(child, childImageContext, depth + 1);
    }
  };

  for (const source of markdownImageUrls(answer || "")) add(source);
  visit(assistantMessage?.files ?? [], false);
  visit(assistantMessage?.output ?? [], false);
  for (const value of extraValues) visit(value, false);
  return sources.slice(0, 50);
}


function isOpenWebUIUiAsset(source) {
  if (typeof source !== "string" || source.startsWith("data:image/")) return false;
  try {
    const parsed = new URL(source, `${config.openWebUIUrl}/`);
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    if (pathname.startsWith("/static/")) return true;
    return /(?:^|\/)(?:favicon|apple-touch-icon|logo|profile-image|model-icon)(?:[._/-]|$)/i.test(pathname);
  } catch {
    return false;
  }
}


function imageSourceSummary(source) {
  if (typeof source !== "string") return "unknown";
  if (source.startsWith("data:image/")) return `data-image(${source.length} chars)`;
  try {
    const parsed = new URL(source, `${config.openWebUIUrl}/`);
    return `${parsed.hostname || "local"}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}


function outputSummaryForLog(output) {
  try {
    return JSON.stringify(output, (key, value) => {
      if (/(password|secret|token|api[_-]?key|authorization)/i.test(key)) return "[REDACTED]";
      if (typeof value === "string" && value.startsWith("data:image/")) {
        return `[BASE64_IMAGE ${value.length} chars]`;
      }
      if (typeof value === "string" && value.length > 1200) {
        return `${value.slice(0, 1200)}...[TRUNCATED ${value.length} chars]`;
      }
      return value;
    }).slice(0, 6000);
  } catch {
    return "[无法序列化 output]";
  }
}


function imageDomainAllowed(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return config.imageDownloadDomains.some((entry) => {
    const normalized = entry.toLowerCase().replace(/\.$/, "");
    if (normalized === "*") return true;
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === normalized;
  });
}


async function downloadImage(url) {
  if (url.startsWith("data:image/")) {
    const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/i.exec(url);
    if (!match) throw new Error("无效的 Base64 图片数据。 ");
    const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (buffer.length > config.maxImageBytes) {
      throw new Error(`图片超过 ${config.maxImageBytes} 字节限制。`);
    }
    const detected = detectInputImageMimeType(buffer);
    if (!detected) throw new Error("Base64 内容不是支持的图片格式。 ");
    return { buffer, contentType: detected };
  }

  const openWebUIOrigin = new URL(config.openWebUIUrl).origin;
  const parsed = new URL(url, `${config.openWebUIUrl}/`);
  const isOpenWebUIFile = parsed.origin === openWebUIOrigin;
  if (!isOpenWebUIFile && parsed.protocol !== "https:") {
    throw new Error("外部图片只允许使用 HTTPS。 ");
  }
  if (!isOpenWebUIFile && !imageDomainAllowed(parsed.hostname)) {
    throw new Error(`图片域名不在白名单：${parsed.hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: "error",
      headers: isOpenWebUIFile
        ? { Authorization: `Bearer ${config.openWebUIApiKey}` }
        : undefined,
    });
    if (!response.ok) {
      const errorBody = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 1200);
      throw new Error(`图片下载 HTTP ${response.status}${errorBody ? `：${errorBody}` : ""}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.maxImageBytes) {
        await reader.cancel();
        throw new Error(`图片超过 ${config.maxImageBytes} 字节限制。`);
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
    const detectedType = detectInputImageMimeType(buffer);
    if (!normalizedType.startsWith("image/") && !detectedType) {
      throw new Error(`响应不是图片：${contentType}`);
    }
    return { buffer, contentType: detectedType ?? normalizedType };
  } finally {
    clearTimeout(timer);
  }
}


function imageExtension(contentType, buffer) {
  const detected = detectInputImageMimeType(buffer) ?? contentType;
  return {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  }[detected] ?? "jpg";
}


async function buildReplyImages(answer, imageSources = []) {
  if (!config.sendMarkdownImages || config.maxImagesPerReply === 0) return [];

  const items = [];
  const sources = [...new Set([...imageSources, ...markdownImageUrls(answer)])].slice(0, 50);
  for (const url of sources) {
    if (items.length >= config.maxImagesPerReply) break;
    try {
      const { buffer, contentType } = await downloadImage(url);
      items.push({
        buffer,
        filename: `generated-${items.length + 1}.${imageExtension(contentType, buffer)}`,
      });
    } catch (error) {
      console.warn(`未能转发图片 ${url}：${error.message}`);
    }
  }
  return items;
}


async function sendReplyImages(targetId, targetLabel, replyImages) {
  let failures = 0;
  let sent = 0;
  for (const image of replyImages) {
    try {
      const uploaded = await wsClient.uploadMedia(image.buffer, {
        type: "image",
        filename: image.filename,
      });
      if (!uploaded?.media_id) throw new Error("企微上传图片后没有返回 media_id");
      await wsClient.sendMediaMessage(targetId, "image", uploaded.media_id);
      sent += 1;
    } catch (error) {
      failures += 1;
      console.warn(`向${targetLabel} ${targetId} 发送图片失败：${error.message}`);
    }
  }

  if (sent > 0) console.log(`已向${targetLabel} ${targetId} 发送 ${sent} 张图片素材。`);

  if (failures > 0) {
    try {
      await wsClient.sendMessage(targetId, {
        msgtype: "markdown",
        markdown: {
          content: `有 ${failures} 张生成图片未能作为企微素材发送，请查看上一条回答中的图片链接。`,
        },
      });
    } catch (error) {
      console.warn(`向${targetLabel} ${targetId} 发送图片失败提示也失败：${error.message}`);
    }
  }
}


class TriggerHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "TriggerHttpError";
    this.statusCode = statusCode;
  }
}


function safeTokenEqual(received, expected) {
  const receivedBuffer = Buffer.from(received ?? "", "utf8");
  const expectedBuffer = Buffer.from(expected ?? "", "utf8");
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}


function triggerTokenFromRequest(request) {
  const authorization = request.headers.authorization ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  const header = request.headers["x-trigger-token"];
  return Array.isArray(header) ? header[0] : (header ?? "").trim();
}


function writeTriggerJson(response, statusCode, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(data);
}


const adminAssets = new Map([
  ["/admin", { file: "admin.html", contentType: "text/html; charset=utf-8" }],
  ["/admin/", { file: "admin.html", contentType: "text/html; charset=utf-8" }],
  ["/admin/app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/admin/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
]);


async function serveAdminAsset(pathname, response) {
  const asset = adminAssets.get(pathname);
  if (!asset) return false;
  if (!config.triggerAdminEnabled) {
    writeTriggerJson(response, 404, { ok: false, error: "管理页面未启用。" });
    return true;
  }
  const data = await fs.readFile(path.join(projectDir, "public", asset.file));
  response.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(data);
  return true;
}


async function readRequestBuffer(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new TriggerHttpError(413, `请求体超过 ${maxBytes} 字节限制。`);
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new TriggerHttpError(400, "请求体不能为空。 ");
  return Buffer.concat(chunks);
}


async function readTriggerJson(request) {
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new TriggerHttpError(415, "Content-Type 必须是 application/json。 ");
  }

  try {
    const parsed = JSON.parse((await readRequestBuffer(request, config.triggerMaxBodyBytes)).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON 顶层必须是对象");
    }
    return parsed;
  } catch (error) {
    throw new TriggerHttpError(400, `JSON 格式错误：${error.message}`);
  }
}


function validateTriggerTarget(payload) {
  let targetType;
  let targetId;
  try {
    ({ targetType, targetId } = resolveTriggerTarget(payload));
  } catch (error) {
    throw new TriggerHttpError(400, error.message);
  }
  if (!targetId || targetId.length > 256 || /[\r\n]/.test(targetId)) {
    throw new TriggerHttpError(400, "target_id 不能为空，且必须是有效的企微 userid 或群 chatid。 ");
  }
  if (targetType === "user" && !isUserAllowed(targetId)) {
    throw new TriggerHttpError(403, `目标用户 ${targetId} 不在 ALLOWED_USER_IDS 白名单中。`);
  }
  if (targetType === "group" && !isGroupAllowed(targetId)) {
    throw new TriggerHttpError(403, `目标群聊 ${targetId} 未在 ALLOWED_GROUP_IDS 中授权。`);
  }
  return { targetType, targetId };
}


function decodeTriggerMedia(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TriggerHttpError(400, "媒体消息必须提供 media_base64。 ");
  }

  let encoded = value.trim();
  const dataUrlMatch = encoded.match(/^data:[^;,]+;base64,(.*)$/s);
  if (dataUrlMatch) encoded = dataUrlMatch[1];
  encoded = encoded.replace(/\s+/g, "");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new TriggerHttpError(400, "media_base64 不是有效的 Base64 数据。 ");
  }

  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0) throw new TriggerHttpError(400, "媒体内容不能为空。 ");
  if (buffer.length > config.triggerMaxMediaBytes) {
    throw new TriggerHttpError(413, `媒体超过 ${config.triggerMaxMediaBytes} 字节限制。`);
  }
  return buffer;
}


function triggerFilename(payload, messageType) {
  const defaults = {
    image: "trigger-image.png",
    file: "trigger-file.bin",
    voice: "trigger-voice.amr",
    video: "trigger-video.mp4",
  };
  const requested = path.basename(String(payload.filename ?? defaults[messageType]).trim());
  const safe = requested.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return safe || defaults[messageType];
}


async function executeTrigger(payload) {
  const { targetType, targetId } = validateTriggerTarget(payload);
  const messageType = String(payload.message_type ?? "").trim().toLowerCase();
  const targetLabel = targetType === "group" ? "群聊" : "单聊用户";
  const sessionKey = `${targetType === "group" ? "group" : "user"}:${targetId}`;
  const supportedTypes = [
    "text",
    "markdown",
    "image",
    "file",
    "voice",
    "video",
    "template_card",
    "ai",
  ];
  if (!supportedTypes.includes(messageType)) {
    throw new TriggerHttpError(
      400,
      `message_type 必须是以下值之一：${supportedTypes.join(", ")}。`,
    );
  }
  if (!wsClient.isConnected) {
    throw new TriggerHttpError(503, "企业微信长连接尚未认证或当前已断开。 ");
  }

  const delivery = await enqueueSession(sessionKey, async () => {
    if (messageType === "text" || messageType === "markdown") {
      const content = String(payload.content ?? "").trim();
      if (!content) throw new TriggerHttpError(400, "文本消息的 content 不能为空。 ");
      await wsClient.sendMessage(targetId, {
        msgtype: "markdown",
        markdown: { content: truncateReply(content) },
      });
      return { delivered_as: "markdown", image_count: 0 };
    }

    if (messageType === "template_card") {
      if (
        !payload.template_card
        || typeof payload.template_card !== "object"
        || Array.isArray(payload.template_card)
      ) {
        throw new TriggerHttpError(400, "template_card 消息必须提供 template_card 对象。 ");
      }
      await wsClient.sendMessage(targetId, {
        msgtype: "template_card",
        template_card: payload.template_card,
      });
      return { delivered_as: "template_card", image_count: 0 };
    }

    if (["image", "file", "voice", "video"].includes(messageType)) {
      let buffer;
      let filename = triggerFilename(payload, messageType);
      if (messageType === "image" && typeof payload.media_url === "string") {
        const downloaded = await downloadImage(payload.media_url.trim());
        buffer = downloaded.buffer;
        if (!payload.filename) filename = `trigger-image.${imageExtension(downloaded.contentType, buffer)}`;
      } else {
        buffer = decodeTriggerMedia(payload.media_base64);
      }
      if (buffer.length > config.triggerMaxMediaBytes) {
        throw new TriggerHttpError(413, `媒体超过 ${config.triggerMaxMediaBytes} 字节限制。`);
      }
      const uploaded = await wsClient.uploadMedia(buffer, { type: messageType, filename });
      if (!uploaded?.media_id) throw new Error("企微上传媒体后没有返回 media_id。 ");
      await wsClient.sendMediaMessage(
        targetId,
        messageType,
        uploaded.media_id,
        messageType === "video"
          ? {
            title: String(payload.title ?? "").trim(),
            description: String(payload.description ?? "").trim(),
          }
          : undefined,
      );
      return { delivered_as: messageType, filename, image_count: messageType === "image" ? 1 : 0 };
    }

    const prompt = String(payload.content ?? payload.prompt ?? "").trim();
    if (!prompt) throw new TriggerHttpError(400, "AI 消息的 content 或 prompt 不能为空。 ");
    const history = histories.get(sessionKey) ?? [];
    const { answer, replyImages } = await runOpenWebUI(history, prompt, []);
    histories.set(sessionKey, trimHistory([
      ...history,
      { role: "user", content: `[主动触发任务]\n${prompt}` },
      { role: "assistant", content: answer },
    ]));
    await saveHistories();
    await wsClient.sendMessage(targetId, {
      msgtype: "markdown",
      markdown: { content: truncateReply(answer) },
    });
    if (replyImages.length > 0) {
      await sendReplyImages(targetId, targetLabel, replyImages);
    }
    return { delivered_as: "ai", answer, image_count: replyImages.length };
  });
  return { target_type: targetType, target_id: targetId, ...delivery };
}


async function runTriggerOnce(requestId, fingerprint, task) {
  const cacheKey = `${requestId}:${fingerprint}`;
  if (triggerRequests.has(cacheKey)) {
    const result = await triggerRequests.get(cacheKey);
    return { ...result, duplicate: true };
  }

  const promise = task();
  triggerRequests.set(cacheKey, promise);
  triggerRequestOrder.push(cacheKey);
  while (triggerRequestOrder.length > 2000) {
    const oldest = triggerRequestOrder.shift();
    if (oldest !== cacheKey) triggerRequests.delete(oldest);
  }
  try {
    return await promise;
  } catch (error) {
    triggerRequests.delete(cacheKey);
    throw error;
  }
}


function triggerRequestId(payload) {
  const requestId = String(payload.request_id ?? randomUUID()).trim();
  if (!requestId || requestId.length > 128 || /[\r\n]/.test(requestId)) {
    throw new TriggerHttpError(400, "request_id 必须是 1 到 128 个字符。 ");
  }
  return requestId;
}


function validateBatchTargets(payload) {
  const targetType = String(payload.target_type ?? "").trim().toLowerCase();
  if (!["user", "group"].includes(targetType)) {
    throw new TriggerHttpError(400, "批量发送必须提供 target_type（user 或 group）。");
  }
  const rawTargets = payload.target_ids ?? payload.ids;
  if (!Array.isArray(rawTargets)) {
    throw new TriggerHttpError(400, "批量发送必须提供 target_ids 数组。 ");
  }
  const targetIds = [...new Set(rawTargets.map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (targetIds.length === 0) throw new TriggerHttpError(400, "target_ids 不能为空。 ");
  if (targetIds.length > config.triggerBatchMaxTargets) {
    throw new TriggerHttpError(400, `单次最多发送 ${config.triggerBatchMaxTargets} 个目标。`);
  }
  if (targetIds.some((id) => id.length > 256 || /[\r\n]/.test(id))) {
    throw new TriggerHttpError(400, "target_ids 中包含无效 ID。 ");
  }
  return { targetType, targetIds };
}


async function executeTriggerBatch(payload, requestId) {
  const { targetType, targetIds } = validateBatchTargets(payload);
  const basePayload = { ...payload };
  for (const key of [
    "request_id", "target_ids", "ids", "target_id", "userid", "user_id", "chatid", "chat_id",
  ]) delete basePayload[key];

  const results = new Array(targetIds.length);
  let cursor = 0;
  async function worker() {
    while (cursor < targetIds.length) {
      const index = cursor;
      cursor += 1;
      const targetId = targetIds[index];
      const itemPayload = { ...basePayload, target_type: targetType, target_id: targetId };
      const itemRequestId = `${requestId}:${index}`;
      try {
        const fingerprint = triggerRequestFingerprint(itemPayload);
        const result = await runTriggerOnce(
          itemRequestId,
          fingerprint,
          () => executeTrigger(itemPayload),
        );
        results[index] = { ok: true, target_id: targetId, ...result };
      } catch (error) {
        results[index] = { ok: false, target_id: targetId, error: error.message };
      }
    }
  }

  const workerCount = Math.min(config.triggerBatchConcurrency, targetIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const succeeded = results.filter((item) => item.ok).length;
  return {
    ok: succeeded === results.length,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}


function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : String(value ?? "");
}


async function handleTargetImport(request, response) {
  let filename;
  try {
    filename = decodeURIComponent(requestHeader(request, "x-file-name"));
  } catch {
    throw new TriggerHttpError(400, "X-File-Name 编码无效。 ");
  }
  const targetType = requestHeader(request, "x-target-type").trim().toLowerCase();
  if (!["user", "group"].includes(targetType)) {
    throw new TriggerHttpError(400, "X-Target-Type 必须是 user 或 group。 ");
  }
  try {
    const buffer = await readRequestBuffer(request, config.triggerImportMaxBytes);
    const result = parseTargetSpreadsheet(
      buffer,
      filename,
      targetType,
      config.triggerBatchMaxTargets,
    );
    writeTriggerJson(response, 200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof TriggerHttpError) throw error;
    throw new TriggerHttpError(400, `表格导入失败：${error.message}`);
  }
}


async function handleTriggerRequest(request, response) {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && await serveAdminAsset(url.pathname, response)) {
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      writeTriggerJson(response, 200, {
        ok: true,
        version: BRIDGE_VERSION,
        wecom_connected: Boolean(wsClient.isConnected),
        trigger_api_enabled: config.triggerApiEnabled,
        trigger_admin_enabled: config.triggerAdminEnabled,
      });
      return;
    }
    const apiPaths = new Set([
      "/api/trigger",
      "/api/trigger/batch",
      "/api/trigger/import",
    ]);
    if (!apiPaths.has(url.pathname)) {
      writeTriggerJson(response, 404, { ok: false, error: "接口不存在。" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      writeTriggerJson(response, 405, { ok: false, error: "只允许 POST 请求。" });
      return;
    }
    if (!safeTokenEqual(triggerTokenFromRequest(request), config.triggerApiToken)) {
      writeTriggerJson(response, 401, { ok: false, error: "触发器 Token 无效。" });
      return;
    }

    if (url.pathname === "/api/trigger/import") {
      await handleTargetImport(request, response);
      return;
    }

    const payload = await readTriggerJson(request);
    const requestId = triggerRequestId(payload);
    if (url.pathname === "/api/trigger/batch") {
      const result = await executeTriggerBatch(payload, requestId);
      console.log(
        `主动批量触发完成：request_id=${requestId}, total=${result.total}, `
        + `succeeded=${result.succeeded}, failed=${result.failed}`,
      );
      writeTriggerJson(response, 200, { request_id: requestId, ...result });
      return;
    }

    const fingerprint = triggerRequestFingerprint(payload);
    const result = await runTriggerOnce(requestId, fingerprint, () => executeTrigger(payload));
    console.log(
      `主动触发发送成功：request_id=${requestId}, target_type=${result.target_type}, `
      + `target_id=${result.target_id}, message_type=${payload.message_type}`,
    );
    writeTriggerJson(response, 200, { ok: true, request_id: requestId, ...result });
  } catch (error) {
    const statusCode = error instanceof TriggerHttpError ? error.statusCode : 500;
    console.error(`主动触发发送失败：${error.message}`);
    writeTriggerJson(response, statusCode, { ok: false, error: error.message });
  }
}


let triggerServer = null;


function startTriggerApi() {
  if (!config.triggerApiEnabled) {
    console.log("主动消息触发器接口未启用。 ");
    return;
  }
  triggerServer = createServer((request, response) => {
    void handleTriggerRequest(request, response);
  });
  triggerServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  triggerServer.on("error", (error) => {
    console.error(`主动消息触发器接口启动失败：${error.message}`);
  });
  triggerServer.listen(config.triggerApiPort, config.triggerApiHost, () => {
    console.log(
      `主动消息触发器接口：http://${config.triggerApiHost}:${config.triggerApiPort}/api/trigger`,
    );
    if (config.triggerAdminEnabled) {
      console.log(
        `触发器管理页面：http://${config.triggerApiHost}:${config.triggerApiPort}/admin`,
      );
    }
    if (!["127.0.0.1", "::1", "localhost"].includes(config.triggerApiHost.toLowerCase())) {
      console.warn("触发器接口正在监听非本机地址，请同时配置防火墙来源限制并妥善保存 Token。 ");
    }
  });
}


function trimHistory(history) {
  if (config.maxHistoryMessages === 0) return [];
  return history.slice(-config.maxHistoryMessages);
}


function truncateReply(answer) {
  if (answer.length <= config.maxReplyChars) return answer;
  return `${answer.slice(0, config.maxReplyChars)}\n\n[回答过长，已截断]`;
}


function detectInputImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return "image/gif";
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}


function collectInputImageRefs(body) {
  const refs = [];
  const seen = new Set();
  const add = (image) => {
    const url = image?.url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    refs.push({ url, aeskey: image?.aeskey });
  };

  add(body.image);
  for (const item of body.mixed?.msg_item ?? []) {
    if (item?.msgtype === "image") add(item.image);
  }

  if (body.quote?.msgtype === "image") add(body.quote.image);
  if (body.quote?.msgtype === "mixed") {
    for (const item of body.quote.mixed?.msg_item ?? []) {
      if (item?.msgtype === "image") add(item.image);
    }
  }

  return refs;
}


function extractTextPrompt(body) {
  if (body.msgtype === "text") return (body.text?.content ?? "").trim();
  if (body.msgtype === "mixed") {
    return (body.mixed?.msg_item ?? [])
      .filter((item) => item?.msgtype === "text")
      .map((item) => item.text?.content ?? "")
      .join("\n")
      .trim();
  }
  return "";
}


async function downloadInputImages(imageRefs) {
  if (!config.enableImageInput) {
    throw new Error("服务器未启用图片输入，请设置 ENABLE_IMAGE_INPUT=true 后重启。 ");
  }
  if (imageRefs.length > config.maxInputImages) {
    throw new Error(`一次最多接收 ${config.maxInputImages} 张图片。`);
  }

  const images = [];
  for (const imageRef of imageRefs) {
    const downloaded = await wsClient.downloadFile(imageRef.url, imageRef.aeskey);
    const buffer = Buffer.isBuffer(downloaded?.buffer)
      ? downloaded.buffer
      : Buffer.from(downloaded?.buffer ?? []);
    const filename = path.basename(downloaded?.filename || "image");

    if (buffer.length === 0) throw new Error(`企微图片下载结果为空：${filename}`);
    if (buffer.length > config.maxInputImageBytes) {
      const limitMb = (config.maxInputImageBytes / 1024 / 1024).toFixed(1);
      throw new Error(`图片 ${filename} 超过 ${limitMb} MB 限制。`);
    }

    const mimeType = detectInputImageMimeType(buffer);
    if (!mimeType) {
      throw new Error(`不支持图片 ${filename} 的格式，仅支持 JPEG、PNG、GIF 和 WebP。`);
    }
    images.push({ buffer, mimeType });
  }
  return images;
}


function historyPromptFor(prompt, imageCount) {
  if (imageCount === 0) return prompt;
  return `[本轮用户发送了 ${imageCount} 张图片；图片数据未保存到本地历史]\n${prompt}`;
}


await loadHistories();

const wsClient = new AiBot.WSClient({
  botId: config.wecomBotId,
  secret: config.wecomBotSecret,
  maxReconnectAttempts: -1,
  logger: {
    debug: () => undefined,
    info: (message, ...args) => console.log(message, ...args),
    warn: (message, ...args) => console.warn(message, ...args),
    error: (message, ...args) => console.error(message, ...args),
  },
});


wsClient.on("authenticated", () => {
  console.log(`企业微信机器人认证成功，桥接服务已就绪。版本：${BRIDGE_VERSION}`);
});


wsClient.on("disconnected", (reason) => {
  console.warn(`企业微信连接断开：${reason}`);
});


wsClient.on("reconnecting", (attempt) => {
  console.warn(`企业微信正在进行第 ${attempt} 次重连。`);
});


wsClient.on("error", (error) => {
  console.error("企业微信 SDK 错误：", error);
});


wsClient.on("event.enter_chat", async (frame) => {
  try {
    await wsClient.replyWelcome(frame, {
      msgtype: "text",
      text: {
        content: "您好，我是企业内部 AI 助手。发送 /help 查看命令。",
      },
    });
  } catch (error) {
    console.error(`发送欢迎语失败：${error.message}`);
  }
});


async function handleIncomingMessage(frame) {
  const body = frame.body ?? {};
  const imageRefs = collectInputImageRefs(body);
  const textPrompt = extractTextPrompt(body);
  const prompt = textPrompt || (
    imageRefs.length === 1
      ? "请描述并分析这张图片。"
      : "请综合描述并分析这些图片。"
  );
  const userId = body.from?.userid ?? "unknown";
  const groupId = body.chatid ?? "";
  const streamId = generateReqId("openwebui");

  if (!rememberMessageId(body.msgid)) {
    console.warn(`忽略重复消息：${body.msgid}`);
    return;
  }

  console.log(
    `收到消息：userid=${userId}, type=${body.msgtype}, images=${imageRefs.length}, `
    + `chattype=${body.chattype}, chatid=${groupId || "-"}`,
  );

  if (!textPrompt && imageRefs.length === 0) {
    await wsClient.replyStream(frame, streamId, "目前支持文本、图片以及图文混排消息。", true);
    return;
  }

  if (!isUserAllowed(userId)) {
    await wsClient.replyStream(
      frame,
      streamId,
      `当前用户未授权。您的企业微信 UserID：${userId}`,
      true,
    );
    return;
  }

  if (body.chattype === "group" && !isGroupAllowed(groupId)) {
    await wsClient.replyStream(
      frame,
      streamId,
      `当前群聊未授权。群聊 chatid：${groupId || "unknown"}`,
      true,
    );
    return;
  }

  const sessionKey = sessionKeyFor(body);

  if (imageRefs.length === 0 && prompt === "/whoami") {
    await wsClient.replyStream(
      frame,
      streamId,
      `UserID：${userId}\n会话类型：${body.chattype}\nChatID：${groupId || "无"}`,
      true,
    );
    return;
  }

  if (imageRefs.length === 0 && prompt === "/help") {
    await wsClient.replyStream(
      frame,
      streamId,
      [
        "可用命令：",
        "- /help：显示帮助",
        "- /whoami：显示当前 UserID 和 ChatID",
         "- /reset：清空当前企微会话的短期上下文",
         "- /status：显示桥接配置状态（不显示密钥）",
         "- 可直接发送图片、图文混排消息，或引用图片后提问",
      ].join("\n"),
      true,
    );
    return;
  }

  if (imageRefs.length === 0 && prompt === "/reset") {
    histories.delete(sessionKey);
    await saveHistories();
    await wsClient.replyStream(frame, streamId, "当前会话上下文已清空。", true);
    return;
  }

  if (imageRefs.length === 0 && prompt === "/status") {
    await wsClient.replyStream(
      frame,
      streamId,
      [
         "桥接服务运行正常。",
         `桥接版本：${BRIDGE_VERSION}`,
        `Open WebUI：${config.openWebUIUrl}`,
        `模型：${config.openWebUIModel}`,
         `工作区工具：${config.toolIds.length ? config.toolIds.join(", ") : "未配置"}`,
         `图片专用工具：${config.imageToolId || "未配置"}`,
         `历史消息上限：${config.maxHistoryMessages}`,
         `图片输入：${config.enableImageInput ? "已启用" : "未启用"}`,
         `单次图片上限：${config.maxInputImages} 张，每张 ${Math.round(config.maxInputImageBytes / 1024 / 1024)} MB`,
      ].join("\n"),
      true,
    );
    return;
  }

  await wsClient.replyStream(
    frame,
    streamId,
    imageRefs.length > 0 ? "正在接收图片并调用视觉模型，请稍候……" : "正在调用内部 AI，请稍候……",
    false,
  );

  let inputImages = [];
  if (imageRefs.length > 0) {
    try {
      // 企微图片下载 URL 只有短时效，必须在进入会话队列前完成下载。
      inputImages = await downloadInputImages(imageRefs);
    } catch (error) {
      console.error("接收企微图片失败：", error);
      await wsClient.replyStream(frame, streamId, `图片接收失败：${error.message}`, true);
      return;
    }
  }

  void enqueueSession(sessionKey, async () => {
    try {
      const history = histories.get(sessionKey) ?? [];
      const { answer, replyImages } = await runOpenWebUI(history, prompt, inputImages);
      const updatedHistory = trimHistory([
        ...history,
        { role: "user", content: historyPromptFor(prompt, inputImages.length) },
        { role: "assistant", content: answer },
      ]);
      histories.set(sessionKey, updatedHistory);
      await saveHistories();

      const isGroupChat = body.chattype === "group";
      const imageTargetId = isGroupChat ? groupId : userId;
      const imageTargetLabel = isGroupChat ? "群聊" : "单聊用户";
      const useMediaSend = replyImages.length > 0;
      console.log(
        `回复图片诊断：chattype=${body.chattype || "unknown"}, `
        + `检测到=${replyImages.length}, 发送方式=${useMediaSend ? "active-media" : "none"}`,
      );
      if (replyImages.length === 0) {
        console.warn("Open WebUI 消息中没有检测到可下载的图片。 ");
      }
      await wsClient.replyStream(
        frame,
        streamId,
        truncateReply(answer),
        true,
      );
      if (useMediaSend) {
        if (!imageTargetId) throw new Error(`${imageTargetLabel}缺少发送目标 ID。`);
        await sendReplyImages(imageTargetId, imageTargetLabel, replyImages);
      }
    } catch (error) {
      console.error("处理消息失败：", error);
      await wsClient.replyStream(
        frame,
        streamId,
        `处理失败：${error.message}`,
        true,
      );
    }
  });
}


wsClient.on("message.text", (frame) => void handleIncomingMessage(frame));
wsClient.on("message.image", (frame) => void handleIncomingMessage(frame));
wsClient.on("message.mixed", (frame) => void handleIncomingMessage(frame));


async function shutdown(signal) {
  console.log(`收到 ${signal}，正在退出……`);
  try {
    await saveHistories();
  } catch (error) {
    console.error(`保存历史失败：${error.message}`);
  }
  if (triggerServer) triggerServer.close();
  wsClient.disconnect();
  process.exit(0);
}


process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startTriggerApi();
wsClient.connect();
