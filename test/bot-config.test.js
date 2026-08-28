import assert from "node:assert/strict";
import test from "node:test";

import { parseWeComBotConfigs } from "../bot-config.js";


test("keeps legacy single-bot configuration compatible", () => {
  const result = parseWeComBotConfigs({
    WECOM_BOT_ID: "legacy-id",
    WECOM_BOT_SECRET: "legacy-secret",
    ALLOWED_USER_IDS: "user-1,user-2",
  });

  assert.equal(result.legacyMode, true);
  assert.equal(result.defaultBotKey, "default");
  assert.equal(result.bots[0].botId, "legacy-id");
  assert.deepEqual([...result.bots[0].allowedUserIds], ["user-1", "user-2"]);
});


test("parses multiple bots with independent settings", () => {
  const result = parseWeComBotConfigs({
    WECOM_BOT_KEYS: "default,sales-bot",
    WECOM_DEFAULT_BOT_KEY: "sales-bot",
    WECOM_BOT_DEFAULT_ID: "default-id",
    WECOM_BOT_DEFAULT_SECRET: "default-secret",
    WECOM_BOT_DEFAULT_NAME: "通用助手",
    WECOM_BOT_SALES_BOT_ID: "sales-id",
    WECOM_BOT_SALES_BOT_SECRET: "sales-secret",
    WECOM_BOT_SALES_BOT_NAME: "销售助手",
    WECOM_BOT_SALES_BOT_ALLOWED_USER_IDS: "sales-1,sales-2",
    WECOM_BOT_SALES_BOT_ALLOW_GROUPS: "true",
    WECOM_BOT_SALES_BOT_ALLOWED_GROUP_IDS: "group-1",
  });

  assert.equal(result.legacyMode, false);
  assert.equal(result.defaultBotKey, "sales-bot");
  assert.equal(result.bots.length, 2);
  assert.equal(result.bots[1].name, "销售助手");
  assert.deepEqual([...result.bots[1].allowedUserIds], ["sales-1", "sales-2"]);
  assert.equal(result.bots[1].allowGroups, true);
});


test("per-bot whitelist falls back to global settings when omitted", () => {
  const result = parseWeComBotConfigs({
    WECOM_BOT_KEYS: "ops",
    WECOM_BOT_OPS_ID: "ops-id",
    WECOM_BOT_OPS_SECRET: "ops-secret",
    ALLOWED_USER_IDS: "global-user",
    ALLOW_GROUPS: "true",
    ALLOWED_GROUP_IDS: "global-group",
  });

  assert.deepEqual([...result.bots[0].allowedUserIds], ["global-user"]);
  assert.equal(result.bots[0].allowGroups, true);
  assert.deepEqual([...result.bots[0].allowedGroupIds], ["global-group"]);
});


test("rejects an unknown default bot", () => {
  assert.throws(
    () => parseWeComBotConfigs({
      WECOM_BOT_KEYS: "one",
      WECOM_DEFAULT_BOT_KEY: "missing",
      WECOM_BOT_ONE_ID: "one-id",
      WECOM_BOT_ONE_SECRET: "one-secret",
    }),
    /不在 WECOM_BOT_KEYS/,
  );
});
