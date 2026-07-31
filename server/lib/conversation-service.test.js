import assert from "node:assert/strict";
import test from "node:test";

import { ConversationConflictError } from "./conversation-model.js";
import { ConversationService } from "./conversation-service.js";

function createHarness({
  agentError = null,
  completeAgentError = null,
  runTurn = null,
  controlledReplacement = false,
  addMessageBarrier = null
} = {}) {
  let completeAgentCalls = 0;
  const completeAgentRevisions = [];
  const replacementCalls = [];
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
      if (addMessageBarrier) await addMessageBarrier;
      const saved = {
        ...message,
        id: "question",
        nodeId: message.nodeId || "question",
        createdAt: "now"
      };
      messages.push(saved);
      return saved;
    },
    async completeAgentTurn(_threadId, questionId, message, _agentSession, expectedBranchRevision) {
      completeAgentCalls += 1;
      completeAgentRevisions.push(expectedBranchRevision);
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
    },
    async delete() {},
    async deleteMessage(_threadId, messageId) {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) throw new Error(`message not found: ${messageId}`);
      return messages.splice(index, 1)[0];
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
    },
    async applySelectionReplacement(input) {
      replacementCalls.push(input);
      const saved = {
        ...input.agentTurn.message,
        id: "assistant",
        nodeId: input.agentTurn.userMessageId,
        parentId: input.agentTurn.userMessageId,
        createdAt: "now"
      };
      messages.push(saved);
      return {
        document: { path: "/tmp/plan.md", content: input.replacement, revision: "updated" },
        assistantMessage: saved,
        threads: [thread]
      };
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
  return {
    service: new ConversationService({
      threadStore: store,
      document,
      agent,
      controlledReplacement
    }),
    messages,
    completeAgentCalls: () => completeAgentCalls,
    completeAgentRevisions,
    replacementCalls
  };
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
  const { service, completeAgentRevisions } = createHarness({
    agentError: new Error("runtime unavailable")
  });
  const result = await service.addQuestion("thread-1", {
    content: "question",
    parentMessageId: "root",
    askAgent: true
  });
  assert.equal(result.agentOutcome, "failed");
  assert.equal(result.assistantMessage.error, true);
  assert.match(result.assistantMessage.content, /runtime unavailable/);
  assert.match(completeAgentRevisions[0], /^[a-f0-9]{64}$/);
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

test("conversation persistence errors are not misreported as agent failures", async () => {
  const persistenceError = new Error("thread storage unavailable");
  const { service, messages, completeAgentCalls } = createHarness({
    completeAgentError: persistenceError
  });

  await assert.rejects(
    service.updateQuestion("thread-1", "root", {
      content: "updated root",
      rerunAgent: true
    }),
    (error) => error === persistenceError
  );
  assert.equal(completeAgentCalls(), 1);
  assert.equal(messages.some((message) => message.role === "assistant"), false);
});

test("controlled replacement delegates document and answer persistence to one commit", async () => {
  const { service, completeAgentCalls, replacementCalls } = createHarness({
    controlledReplacement: true,
    runTurn: async () => ({
      content: "```xuanniao-replacement\nupdated\n```",
      stopReason: "completed",
      transport: "test",
      updates: [],
      session: null
    })
  });

  const result = await service.addQuestion("thread-1", {
    content: "修改这一段",
    parentMessageId: "root",
    askAgent: true
  });

  assert.equal(result.agentOutcome, "completed");
  assert.equal(result.document.content, "updated");
  assert.equal(completeAgentCalls(), 0);
  assert.equal(replacementCalls.length, 1);
  assert.equal(replacementCalls[0].agentTurn.message.meta.appliedEdit, true);
  assert.match(replacementCalls[0].agentTurn.expectedBranchRevision, /^[a-f0-9]{64}$/);
});

test("threads and messages cannot be deleted while an agent reply is active", async () => {
  let releaseTurn;
  let markTurnStarted;
  const turnResult = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const turnStarted = new Promise((resolve) => {
    markTurnStarted = resolve;
  });
  const { service } = createHarness({
    runTurn: async () => {
      markTurnStarted();
      return turnResult;
    }
  });
  const reply = service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true
  });
  await turnStarted;

  await assert.rejects(
    service.deleteThread("thread-1"),
    (error) => error instanceof ConversationConflictError && error.statusCode === 409
  );
  await assert.rejects(
    service.deleteMessage("thread-1", "root"),
    (error) => error instanceof ConversationConflictError && error.statusCode === 409
  );

  releaseTurn({
    content: "answer",
    stopReason: "completed",
    transport: "test",
    updates: [],
    session: null
  });
  await reply;
});

test("thread deletion is rejected from the start of question persistence", async () => {
  let releaseAdd;
  const addBarrier = new Promise((resolve) => {
    releaseAdd = resolve;
  });
  const { service } = createHarness({ addMessageBarrier: addBarrier });
  const adding = service.addQuestion("thread-1", {
    content: "question",
    parentMessageId: "root",
    askAgent: false
  });

  await assert.rejects(
    service.deleteThread("thread-1"),
    (error) => error instanceof ConversationConflictError && error.statusCode === 409
  );

  releaseAdd();
  await adding;
  await assert.doesNotReject(service.deleteThread("thread-1"));
});
