import assert from "node:assert/strict";
import test from "node:test";

import { ConversationService } from "./conversation-service.js";

function createHarness({ agentError = null } = {}) {
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
    async runTurn() {
      if (agentError) throw agentError;
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
