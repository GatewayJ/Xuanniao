import assert from "node:assert/strict";
import test from "node:test";

import { threadNodeDraftKey } from "./thread-drafts.ts";

test("isolates drafts by thread and conversation node", () => {
  assert.notEqual(threadNodeDraftKey("thread-a", "node-1"), threadNodeDraftKey("thread-a", "node-2"));
  assert.notEqual(threadNodeDraftKey("thread-a", "node-1"), threadNodeDraftKey("thread-b", "node-1"));
  assert.notEqual(threadNodeDraftKey("thread-a", null), threadNodeDraftKey("thread-a", "node-1"));
});
