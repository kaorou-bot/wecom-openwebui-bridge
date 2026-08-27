const elements = {
  form: document.querySelector("#trigger-form"),
  token: document.querySelector("#token"),
  targetType: document.querySelector("#target-type"),
  targetIds: document.querySelector("#target-ids"),
  targetFile: document.querySelector("#target-file"),
  targetCount: document.querySelector("#target-count"),
  messageType: document.querySelector("#message-type"),
  requestId: document.querySelector("#request-id"),
  content: document.querySelector("#content"),
  contentField: document.querySelector("#content-field"),
  mediaFields: document.querySelector("#media-fields"),
  mediaFile: document.querySelector("#media-file"),
  mediaUrl: document.querySelector("#media-url"),
  mediaUrlField: document.querySelector("#media-url-field"),
  videoFields: document.querySelector("#video-fields"),
  videoTitle: document.querySelector("#video-title"),
  videoDescription: document.querySelector("#video-description"),
  sendButton: document.querySelector("#send-button"),
  clearButton: document.querySelector("#clear-button"),
  progress: document.querySelector("#progress"),
  results: document.querySelector("#results"),
  summary: document.querySelector("#summary"),
  health: document.querySelector("#health"),
};


function uniqueIds(text) {
  const headers = new Set(["id", "userid", "user_id", "chatid", "chat_id", "target_id"]);
  return [...new Set(String(text ?? "")
    .split(/[\s,，;；]+/)
    .map((value) => value.trim())
    .filter((value) => value && !headers.has(value.toLowerCase())))];
}


function newRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}


function updateCount() {
  elements.targetCount.textContent = `${uniqueIds(elements.targetIds.value).length} 个有效目标`;
}


function authHeaders(extra = {}) {
  const token = elements.token.value.trim();
  if (!token) throw new Error("请填写触发器 Token。");
  return { Authorization: `Bearer ${token}`, ...extra };
}


async function apiError(response) {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error) message = body.error;
  } catch {}
  return new Error(message);
}


async function checkHealth() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    elements.health.className = `status ${data.wecom_connected ? "ok" : "pending"}`;
    elements.health.textContent = data.wecom_connected ? `企微已连接 · v${data.version}` : `企微未连接 · v${data.version}`;
  } catch {
    elements.health.className = "status error";
    elements.health.textContent = "服务状态未知";
  }
}


function setMessageFields() {
  const type = elements.messageType.value;
  const isMedia = ["image", "file", "voice", "video"].includes(type);
  elements.mediaFields.classList.toggle("hidden", !isMedia);
  elements.contentField.classList.toggle("hidden", isMedia);
  elements.mediaUrlField.classList.toggle("hidden", type !== "image");
  elements.videoFields.classList.toggle("hidden", type !== "video");
  if (type === "template_card") elements.contentField.firstChild.textContent = "模板卡片 JSON";
  else elements.contentField.firstChild.textContent = "消息内容 / AI 提示词";
}


function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取媒体文件失败。"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}


async function importTargets() {
  const file = elements.targetFile.files?.[0];
  if (!file) return;
  elements.progress.textContent = `正在读取 ${file.name}…`;
  try {
    const response = await fetch("/api/trigger/import", {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        "X-Target-Type": elements.targetType.value,
      }),
      body: file,
    });
    if (!response.ok) throw await apiError(response);
    const data = await response.json();
    const merged = [...new Set([...uniqueIds(elements.targetIds.value), ...data.ids])];
    elements.targetIds.value = merged.join("\n");
    updateCount();
    elements.progress.textContent = `已从“${data.target_column}”导入 ${data.ids.length} 个 ID。`;
  } catch (error) {
    elements.progress.textContent = `导入失败：${error.message}`;
  } finally {
    elements.targetFile.value = "";
  }
}


async function buildPayload() {
  const ids = uniqueIds(elements.targetIds.value);
  if (ids.length === 0) throw new Error("请至少填写一个目标 ID。");
  const messageType = elements.messageType.value;
  const payload = {
    request_id: elements.requestId.value.trim() || newRequestId(),
    target_type: elements.targetType.value,
    target_ids: ids,
    message_type: messageType,
  };
  if (["text", "markdown", "ai"].includes(messageType)) {
    payload.content = elements.content.value.trim();
    if (!payload.content) throw new Error("消息内容不能为空。");
  } else if (messageType === "template_card") {
    try { payload.template_card = JSON.parse(elements.content.value); }
    catch { throw new Error("模板卡片必须是有效的 JSON 对象。"); }
  } else {
    const mediaFile = elements.mediaFile.files?.[0];
    const mediaUrl = elements.mediaUrl.value.trim();
    if (messageType === "image" && mediaUrl) payload.media_url = mediaUrl;
    else if (mediaFile) {
      payload.media_base64 = await fileToBase64(mediaFile);
      payload.filename = mediaFile.name;
    } else throw new Error(messageType === "image" ? "请选择图片文件或填写图片地址。" : "请选择媒体文件。");
    if (messageType === "video") {
      payload.title = elements.videoTitle.value.trim();
      payload.description = elements.videoDescription.value.trim();
    }
  }
  return payload;
}


function renderResults(data) {
  elements.results.textContent = "";
  for (const item of data.results ?? []) {
    const row = document.createElement("tr");
    const target = document.createElement("td");
    target.textContent = item.target_id;
    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${item.ok ? "ok" : "error"}`;
    badge.textContent = item.ok ? "成功" : "失败";
    status.append(badge);
    const mode = document.createElement("td");
    mode.textContent = item.delivered_as ?? "—";
    const detail = document.createElement("td");
    detail.textContent = item.error ?? (item.duplicate ? "幂等命中，未重复发送" : "已发送");
    row.append(target, status, mode, detail);
    elements.results.append(row);
  }
  elements.summary.textContent = `共 ${data.total} 个：成功 ${data.succeeded}，失败 ${data.failed}`;
}


async function sendBatch(event) {
  event.preventDefault();
  elements.sendButton.disabled = true;
  elements.progress.textContent = "正在发送…";
  try {
    const payload = await buildPayload();
    const response = await fetch("/api/trigger/batch", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw await apiError(response);
    const data = await response.json();
    renderResults(data);
    elements.progress.textContent = data.failed ? "批量发送完成，部分目标失败。" : "批量发送完成。";
  } catch (error) {
    elements.progress.textContent = `发送失败：${error.message}`;
  } finally {
    elements.sendButton.disabled = false;
  }
}


elements.targetIds.addEventListener("input", updateCount);
elements.targetFile.addEventListener("change", importTargets);
elements.messageType.addEventListener("change", setMessageFields);
elements.form.addEventListener("submit", sendBatch);
elements.clearButton.addEventListener("click", () => {
  elements.results.innerHTML = '<tr class="empty"><td colspan="4">发送后将在此显示逐条结果</td></tr>';
  elements.summary.textContent = "尚未发送";
  elements.progress.textContent = "";
});

updateCount();
setMessageFields();
checkHealth();
