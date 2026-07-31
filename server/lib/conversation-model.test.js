import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationRuleError,
  appendConversationMessage,
  normalizeConversationMetaPatch,
  planConversationQuestion
} from "./conversation-model.js";

function rootThread() {
  return {
    id: "thread-1",
    messages: [{
      id: "root",
      role: "user",
      content: "root",
      nodeId: "root",
      parentId: null,
      agentSession: { adapter: "codex-app-server", sessionId: "root-session" }
    }]
  };
}

test("question planning appends directly to the parent and validates selections", () => {
  const thread = rootThread();
  const planned = planConversationQuestion(thread, {
    content: "follow up",
    parentMessageId: "root",
    branchSelection: {
      sourceMessageId: "root",
      text: "root"
    }
  });

  assert.equal(planned.message.parentId, "root");
  assert.deepEqual(planned.message.meta.branchSelection, {
    sourceMessageId: "root",
    text: "root"
  });
});

test("planning metadata is validated by the domain model", () => {
  assert.deepEqual(normalizeConversationMetaPatch({ nodeKind: "decision" }), {
    nodeKind: "decision"
  });
  assert.throws(
    () => normalizeConversationMetaPatch({ nodeKind: "unsupported" }),
    (error) => error instanceof ConversationRuleError && error.statusCode === 400
  );
});

test("question planning rejects obsolete placement controls at the domain boundary", () => {
  for (const legacyPlacement of [
    { adoptExistingChildren: false },
    { adoptExistingChildren: true },
    { insertBeforeNodeId: null },
    { insertBeforeNodeId: "child" }
  ]) {
    assert.throws(
      () => planConversationQuestion(rootThread(), {
        content: "invalid",
        parentMessageId: "root",
        ...legacyPlacement
      }),
      (error) => error instanceof ConversationRuleError && error.statusCode === 400
    );
  }
});

test("continuing a node invalidates descendant sessions", () => {
  const thread = rootThread();
  thread.messages.push({
    id: "child",
    role: "user",
    content: "child",
    nodeId: "child",
    parentId: "root",
    agentSession: { adapter: "codex-app-server", sessionId: "child-session" }
  });

  appendConversationMessage(
    thread,
    { role: "user", content: "continue", nodeId: "root", parentId: null },
    { id: "continued", now: "2026-07-29T00:00:00.000Z" }
  );

  assert.equal(thread.messages.find((message) => message.id === "child").agentSession, null);
});
