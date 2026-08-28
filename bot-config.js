function clean(value) {
  return String(value ?? "").trim();
}


function list(value) {
  return clean(value).split(",").map((item) => item.trim()).filter(Boolean);
}


function bool(value, defaultValue = false) {
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}


function required(env, name) {
  const value = clean(env[name]);
  if (!value || value.startsWith("填写")) throw new Error(`缺少必要配置：${name}`);
  return value;
}


function validateKey(value) {
  const key = clean(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) {
    throw new Error(`机器人 key“${value}”无效，只能使用 1～32 位小写字母、数字、下划线或短横线。`);
  }
  return key;
}


function scopedList(env, scopedName, fallbackName) {
  return new Set(list(env[scopedName] === undefined ? env[fallbackName] : env[scopedName]));
}


function scopedBool(env, scopedName, fallbackName, defaultValue = false) {
  return bool(env[scopedName] === undefined ? env[fallbackName] : env[scopedName], defaultValue);
}


export function parseWeComBotConfigs(env = process.env) {
  const configuredKeys = list(env.WECOM_BOT_KEYS);
  if (configuredKeys.length === 0) {
    return {
      defaultBotKey: "default",
      bots: [{
        key: "default",
        name: clean(env.WECOM_BOT_NAME) || "默认机器人",
        botId: required(env, "WECOM_BOT_ID"),
        secret: required(env, "WECOM_BOT_SECRET"),
        allowedUserIds: new Set(list(env.ALLOWED_USER_IDS)),
        allowGroups: bool(env.ALLOW_GROUPS, false),
        allowedGroupIds: new Set(list(env.ALLOWED_GROUP_IDS)),
      }],
      legacyMode: true,
    };
  }

  const keys = configuredKeys.map(validateKey);
  if (new Set(keys).size !== keys.length) throw new Error("WECOM_BOT_KEYS 中存在重复 key。 ");
  const suffixes = keys.map((key) => key.toUpperCase().replace(/-/g, "_"));
  if (new Set(suffixes).size !== suffixes.length) {
    throw new Error("WECOM_BOT_KEYS 中的 key 转换为环境变量名后发生冲突。 ");
  }

  const bots = keys.map((key, index) => {
    const suffix = suffixes[index];
    const prefix = `WECOM_BOT_${suffix}`;
    return {
      key,
      name: clean(env[`${prefix}_NAME`]) || key,
      botId: required(env, `${prefix}_ID`),
      secret: required(env, `${prefix}_SECRET`),
      allowedUserIds: scopedList(env, `${prefix}_ALLOWED_USER_IDS`, "ALLOWED_USER_IDS"),
      allowGroups: scopedBool(env, `${prefix}_ALLOW_GROUPS`, "ALLOW_GROUPS", false),
      allowedGroupIds: scopedList(env, `${prefix}_ALLOWED_GROUP_IDS`, "ALLOWED_GROUP_IDS"),
    };
  });

  const defaultBotKey = validateKey(env.WECOM_DEFAULT_BOT_KEY || keys[0]);
  if (!keys.includes(defaultBotKey)) {
    throw new Error(`WECOM_DEFAULT_BOT_KEY=${defaultBotKey} 不在 WECOM_BOT_KEYS 中。`);
  }
  return { defaultBotKey, bots, legacyMode: false };
}
