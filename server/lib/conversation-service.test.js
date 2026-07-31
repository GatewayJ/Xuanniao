import assert from "node:assert/strict";
import test from "node:test";

import { ConversationConflictError } from "./conversation-model.js";
import { ConversationService } from "./conversation-service.js";

function createHarness({ agentError = null, completeAgentError = null, runTurn = null } = {}) {
  const messages = [{
    id: "root",
    role: "user",
    content: "root",
    nodeId: "root",
    parentId: null,
    meta: {}
  }];
  const thread = {
    id: "thread-1",
    selectedText: "root",
    anchor: { start: 0, end: 4 },
    messages
  };
  const store = {
    async get() {
      return thread;
    },
    async list() {
      return [thread];
    },
    async hasAssistantAfter(_threadId, userMessageId) {
      return messages.some((message) => (
        message.role === "assistant" && message.parentId === userMessageId
      ));
    },
    async updateMessage(_threadId, messageId, patch) {
      const message = messages.find((item) => item.id === messageId);
      if (!message) throw new Error(`message not found: ${messageId}`);
      Object.assign(message, patch);
      return message;
    },
    async removeAssistantAfter(_threadId, userMessageId) {
      const index = messages.findIndex((message) => (
        message.role === "assistant" && message.parentId === userMessageId
      ));
      if (index < 0) return null;
      return messages.splice(index, 1)[0];
    },
    async addMessage(_threadId, message) {
      const saved = {
        ...message,
        id: "question",
        nodeId: message.nodeId || "question",
        createdAt: "now"
      };
      messages.push(saved);
      return saved;
    },
    async insertNodeAfter() {
      throw new Error("unexpected insert");
    },
    async completeAgentTurn(_threadId, questionId, message) {
      if (completeAgentError) throw completeAgentError;
      const saved = {
        ...message,
        id: "assistant",
        nodeId: questionId,
        parentId: questionId,
        createdAt: "now"
      };
      messages.push(saved);
      return saved;
    }
  };
  const document = {
    async createAgentSnapshot() {
      return {
        document: { path: "/tmp/plan.md", content: "root", revision: "revision" },
        revision: "revision"
      };
    },
    async verifyAgentSnapshot() {
      return null;
    }
  };
  const agent = {
    async runTurn(input) {
      if (agentError) throw agentError;
      if (runTurn) return runTurn(input);
      return {
        content: "answer",
        stopReason: "completed",
        transport: "test",
        updates: [],
        session: null
      };
    }
  };
  return { service: new ConversationService({ threadStore: store, document, agent }), messages };
}

test("conversation service returns an explicit completed outcome", async () => {
  const { service } = createHarness();
  const result = await service.addQuestion("thread-1", {
    content: "question",
    parentMessageId: "root",
    askAgent: true
  });
  assert.equal(result.agentOutcome, "completed");
  assert.equal(result.assistantMessage.error, undefined);
});

test("conversation service persists agent failures with a failed outcome", async () => {
  const { service } = createHarness({ agentError: new Error("runtime unavailable") });
  const result = await service.addQuestion("thread-1", {
    content: "question",
    parentMessageId: "root",
    askAgent: true
  });
  assert.equal(result.agentOutcome, "failed");
  assert.equal(result.assistantMessage.error, true);
  assert.match(result.assistantMessage.content, /runtime unavailable/);
});

test("an explicit rerun answers a previously unanswered saved question", async () => {
  const { service, messages } = createHarness();
  const result = await service.updateQuestion("thread-1", "root", {
    content: "updated root",
    rerunAgent: true
  });

  assert.equal(result.agentOutcome, "completed");
  assert.equal(messages[0].content, "updated root");
  assert.equal(result.assistantMessage.parentId, "root");
  assert.equal(result.assistantMessage.content, "answer");
});

test("an explicit rerun joins an identical agent turn already in flight", async () => {
  let releaseTurn;
  let runCount = 0;
  const turnResult = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const { service, messages } = createHarness({
    runTurn: async () => {
      runCount += 1;
      return turnResult;
    }
  });

  const original = service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true
  });
  await Promise.resolve();
  const retry = service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true
  });
  releaseTurn({
    content: "answer",
    stopReason: "completed",
    transport: "test",
    updates: [],
    session: null
  });

  const [originalResult, retryResult] = await Promise.all([original, retry]);
  assert.equal(runCount, 1);
  assert.equal(originalResult.assistantMessage.id, retryResult.assistantMessage.id);
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
});

test("a stale agent result does not bypass the conversation conflict guard", async () => {
  const conflict = new ConversationConflictError(
    "conversation branch changed while the agent was working; retry the question"
  );
  const { service, messages } = createHarness({ completeAgentError: conflict });

  await assert.rejects(
    service.updateQuestion("thread-1", "root", {
      content: "updated root",
      rerunAgent: true
    }),
    (error) => error === conflict && error.statusCode === 409
  );
  assert.equal(messages.some((message) => message.role === "assistant"), false);
});
