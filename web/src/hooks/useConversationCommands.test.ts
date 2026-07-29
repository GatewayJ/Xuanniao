import assert from "node:assert/strict";
import test from "node:test";

import { statusForOutcome } from "./useConversationCommands.ts";

test("agent failures are not presented as successful answers", () => {
  assert.equal(statusForOutcome("completed", "Codex 已回答"), "Codex 已回答");
  assert.equal(statusForOutcome("not-requested", "评论已保存"), "评论已保存");
  assert.equal(statusForOutcome("failed", "Codex 已回答"), "Codex 请求失败，请查看错误回答");
});
