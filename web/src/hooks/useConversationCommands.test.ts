import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationSendRegistry,
  conversationSendKey,
  statusForOutcome
} from "./useConversationCommands.ts";

test("agent failures are not presented as successful answers", () => {
  assert.equal(statusForOutcome("completed", "Codex 已回答"), "Codex 已回答");
  assert.equal(statusForOutcome("not-requested", "评论已保存"), "评论已保存");
  assert.equal(statusForOutcome("failed", "Codex 已回答"), "Codex 请求失败，请查看错误回答");
});

test("send keys serialize questions targeting the same conversation position", () => {
  assert.equal(
    conversationSendKey({
      threadId: "thread-1",
      content: "one",
      draftKey: "draft-a",
      askAgent: true,
      parentMessageId: "node-1"
    }),
    conversationSendKey({
      threadId: "thread-1",
      content: "two",
      draftKey: "draft-b",
      askAgent: true,
      parentMessageId: "node-1"
    })
  );
});

test("send registry rejects a duplicate until its exact owner finishes", () => {
  const registry = new ConversationSendRegistry();
  const first = registry.begin("thread-1:node-1");
  assert.ok(first);
  assert.equal(registry.begin("thread-1:node-1"), null);

  registry.finish("thread-1:node-1", Symbol("stale"));
  assert.equal(registry.begin("thread-1:node-1"), null);

  registry.finish("thread-1:node-1", first);
  assert.ok(registry.begin("thread-1:node-1"));
});
