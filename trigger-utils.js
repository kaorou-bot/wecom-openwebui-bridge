import { createHash } from "node:crypto";


function cleanId(value) {
  return String(value ?? "").trim();
}


function firstNonEmpty(...values) {
  return values.map(cleanId).find(Boolean) ?? "";
}


export function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const details = [];
    if (error.errcode !== undefined) details.push(`errcode=${error.errcode}`);
    if (error.errmsg) details.push(`errmsg=${error.errmsg}`);
    if (error.hint) details.push(`hint=${error.hint}`);
    if (details.length > 0) return `企微接口错误：${details.join(", ")}`;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to the stable generic message below.
    }
  }
  const message = String(error ?? "").trim();
  return message && message !== "[object Object]" ? message : "未知错误";
}


export function enqueueKeyedTask(queueMap, key, task) {
  const previous = queueMap.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queueMap.set(key, next);

  const cleanup = () => {
    if (queueMap.get(key) === next) queueMap.delete(key);
  };
  // Promise.prototype.finally() creates another rejecting promise. If nobody
  // awaits that derived promise, a handled task failure becomes an unhandled
  // rejection. Using both then branches keeps cleanup rejection-safe.
  void next.then(cleanup, cleanup);
  return next;
}


export function resolveTriggerTarget(payload) {
  const userId = firstNonEmpty(payload.userid, payload.user_id);
  const chatId = firstNonEmpty(payload.chatid, payload.chat_id);
  const genericId = cleanId(payload.target_id);

  if (userId && chatId) {
    throw new Error("userid 和 chatid 只能提供一个。 ");
  }

  const inferredType = userId ? "user" : chatId ? "group" : "";
  // A typed field is a complete target selection and therefore also wins over
  // a stale target_type retained by a generic target picker.
  const targetType = (inferredType || cleanId(payload.target_type)).toLowerCase();
  if (!["user", "group"].includes(targetType)) {
    throw new Error(
      "请提供 userid、chatid，或同时提供 target_type（user/group）和 target_id。 ",
    );
  }

  // Typed fields represent the user's current selection. Some clients keep an
  // earlier target_id in a hidden field, so the typed value must take priority.
  const targetId = userId || chatId || genericId;
  return { targetType, targetId };
}


function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}


export function triggerRequestFingerprint(payload) {
  const requestContent = { ...payload };
  delete requestContent.request_id;
  return createHash("sha256").update(stableJson(requestContent), "utf8").digest("hex");
}
