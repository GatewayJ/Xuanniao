import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationRuleError,
  appendConversationMessage,
  normalizeConversationMetaPatch,
  planConversationQuestion,
  planConversationRevision,
  prepareConversationAgentTurn
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

test("new questions cannot append another turn inside an existing tree node", () => {
  assert.throws(
    () => planConversationQuestion(rootThread(), {
      content: "continue inside root",
      nodeId: "root"
    }),
    (error) => (
      error instanceof ConversationRuleError
      && error.statusCode === 400
      && /new conversation node/.test(error.message)
    )
  );
});

test("editing a historical node plans an immutable sibling leaf", () => {
  const thread = rootThread();
  thread.messages.push(
    {
      id: "child",
      role: "user",
      content: "original child",
      nodeId: "child",
      parentId: "root",
      meta: { nodeKind: "decision" }
    },
    {
      id: "grandchild",
      role: "user",
      content: "existing descendant",
      nodeId: "grandchild",
      parentId: "child",
      meta: {}
    }
  );

  const planned = planConversationRevision(thread, "child", {
    content: "revised child",
    askAgent: true
  });

  assert.equal(planned.message.nodeId, null);
  assert.equal(planned.message.parentId, "root");
  assert.deepEqual(planned.message.meta, {
    revisesMessageId: "child",
    nodeKind: "decision"
  });
  assert.equal(thread.messages.find((message) => message.id === "child").content, "original child");
  assert.equal(thread.messages.find((message) => message.id === "grandchild").parentId, "child");
});

test("a linear child claims the parent branch session while a sibling must fork", () => {
  const thread = rootThread();
  thread.messages[0].agentSession = {
    adapter: "codex-app-server",
    sessionId: "branch-session",
    turnId: "root-turn",
    documentHash: "hash"
  };
  thread.messages.push({
    id: "child",
    role: "user",
    content: "child",
    nodeId: "child",
    parentId: "root",
    agentSession: null
  });

  assert.equal(prepareConversationAgentTurn(thread, "child"), true);
  assert.equal(thread.messages[1].agentSession, null);
  assert.equal(thread.messages[1].agentSessionClaim.sessionId, "branch-session");

  thread.messages.push({
    id: "sibling",
    role: "user",
    content: "sibling",
    nodeId: "sibling",
    parentId: "root",
    agentSession: null
  });
  assert.equal(prepareConversationAgentTurn(thread, "sibling"), false);
  assert.equal(thread.messages[2].agentSession, null);
  assert.equal(thread.messages[2].agentSessionClaim, undefined);
});

test("an interrupted claim is not inherited as a completed parent checkpoint", () => {
  const thread = rootThread();
  thread.messages[0].agentSession = {
    adapter: "codex-app-server",
    sessionId: "branch-session",
    turnId: "root-turn",
    documentHash: "hash"
  };
  thread.messages.push({
    id: "interrupted",
    role: "user",
    content: "never reached Codex",
    nodeId: "interrupted",
    parentId: "root",
    agentSession: null
  });
  prepareConversationAgentTurn(thread, "interrupted");
  thread.messages.push({
    id: "grandchild",
    role: "user",
    content: "must rebuild full history",
    nodeId: "grandchild",
    parentId: "interrupted",
    agentSession: null
  });

  assert.equal(prepareConversationAgentTurn(thread, "grandchild"), false);
  assert.equal(thread.messages[2].agentSession, null);
  assert.equal(thread.messages[2].agentSessionClaim, undefined);
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
