import assert from "node:assert/strict";
import test from "node:test";

import { resolveTriggerTarget, triggerRequestFingerprint } from "../trigger-utils.js";


test("userid overrides a stale generic target_id", () => {
  assert.deepEqual(
    resolveTriggerTarget({ target_type: "user", target_id: "old-user", userid: "new-user" }),
    { targetType: "user", targetId: "new-user" },
  );
});


test("chatid overrides a stale generic target_id", () => {
  assert.deepEqual(
    resolveTriggerTarget({ target_type: "group", target_id: "old-group", chatid: "new-group" }),
    { targetType: "group", targetId: "new-group" },
  );
});


test("generic target fields remain supported", () => {
  assert.deepEqual(
    resolveTriggerTarget({ target_type: "user", target_id: "user-1" }),
    { targetType: "user", targetId: "user-1" },
  );
});


test("typed target overrides a stale generic target_type", () => {
  assert.deepEqual(
    resolveTriggerTarget({ target_type: "group", target_id: "old-group", userid: "new-user" }),
    { targetType: "user", targetId: "new-user" },
  );
});


test("fingerprint ignores request_id but changes with target content", () => {
  const first = triggerRequestFingerprint({
    request_id: "fixed-id",
    message_type: "text",
    userid: "user-1",
    content: "hello",
  });
  const retry = triggerRequestFingerprint({
    content: "hello",
    userid: "user-1",
    message_type: "text",
    request_id: "another-id",
  });
  const changedTarget = triggerRequestFingerprint({
    request_id: "fixed-id",
    message_type: "text",
    userid: "user-2",
    content: "hello",
  });

  assert.equal(first, retry);
  assert.notEqual(first, changedTarget);
});
