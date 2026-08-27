import { createHash } from "node:crypto";


function cleanId(value) {
  return String(value ?? "").trim();
}


function firstNonEmpty(...values) {
  return values.map(cleanId).find(Boolean) ?? "";
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
