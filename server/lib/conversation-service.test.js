import assert from "node:assert/strict";
import test from "node:test";

import { ConversationConflictError } from "./conversation-model.js";
import { ConversationService } from "./conversation-service.js";
import { AgentRunBroker } from "./agent-run-broker.js";

function createHarness({
  agentError = null,
  completeAgentError = null,
  runTurn = null,
  agentRuns = null,
  documentEdits = false,
  addMessageBarrier = null
} = {}) {
  let completeAgentCalls = 0;
  const completeAgentRevisions = [];
  const documentEditCalls = [];
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
      message.content = patch.content;
      if (Object.hasOwn(patch, "agentRunId")) {
        message.meta = { ...(message.meta || {}) };
        if (patch.agentRunId) message.meta.agentRunId = patch.agentRunId;
        else delete message.meta.agentRunId;
      }
      return message;
    },
    async prepareQuestionRerun(_threadId, messageId, patch) {
      const message = await this.updateMessage(_threadId, messageId, patch);
      const removedAssistant = await this.removeAssistantAfter(_threadId, messageId);
      return { message, removedAssistant };
    },
    async setAgentRunId(_threadId, messageId, agentRunId) {
      const message = messages.find((item) => item.id === messageId);
      if (!message) throw new Error(`message not found: ${messageId}`);
      message.meta = { ...(message.meta || {}) };
      if (agentRunId) message.meta.agentRunId = agentRunId;
      else delete message.meta.agentRunId;
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
    async applyDocumentEdits(input) {
      documentEditCalls.push(input);
      const saved = {
        ...input.agentTurn.message,
        id: "assistant",
        nodeId: input.agentTurn.userMessageId,
        parentId: input.agentTurn.userMessageId,
        createdAt: "now"
      };
      messages.push(saved);
      return {
        document: { path: "/tmp/plan.md", content: input.edits[0].newText, revision: "updated" },
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
      agentRuns,
      documentEdits
    }),
    messages,
    completeAgentCalls: () => completeAgentCalls,
    completeAgentRevisions,
    documentEditCalls
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

test("conversation service streams agent updates and persists their duration", async () => {
  const agentRuns = new AgentRunBroker();
  const events = [];
  agentRuns.reserve("run_12345678");
  const unsubscribe = agentRuns.subscribe("run_12345678", (event) => events.push(event));
  const { service } = createHarness({
    agentRuns,
    runTurn: async ({ onUpdate }) => {
      onUpdate({
        type: "commandExecution",
        itemId: "command-1",
        command: "npm test",
        status: "completed"
      });
      return {
        content: "answer",
        stopReason: "completed",
        transport: "test",
        updates: [{ type: "commandExecution", itemId: "command-1", status: "completed" }],
        durationMs: 2_500,
        model: "gpt-test",
        reasoningEffort: "high",
        session: null
      };
    }
  });

  const result = await service.addQuestion("thread-1", {
    content: "question",
    parentMessageId: "root",
    askAgent: true,
    agentRunId: "run_12345678"
  });

  assert.equal(events.some((event) => event.type === "update"), true);
  assert.equal(events.at(-1).type, "complete");
  assert.equal(result.userMessage.meta.agentRunId, "run_12345678");
  assert.equal(result.assistantMessage.meta.durationMs, 2_500);
  assert.equal(result.assistantMessage.meta.model, "gpt-test");
  assert.equal(result.assistantMessage.meta.reasoningEffort, "high");
  unsubscribe();
  agentRuns.dispose();
});

test("rerunning a saved question persists the new agent run id", async () => {
  const { service, messages } = createHarness();
  await service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true,
    agentRunId: "rerun_12345678"
  });

  assert.equal(messages[0].meta.agentRunId, "rerun_12345678");
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
  let markTurnStarted;
  let runCount = 0;
  const turnResult = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const turnStarted = new Promise((resolve) => {
    markTurnStarted = resolve;
  });
  const { service, messages } = createHarness({
    runTurn: async () => {
      runCount += 1;
      markTurnStarted();
      return turnResult;
    }
  });

  const original = service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true,
    agentRunId: "original_run_12345678"
  });
  await turnStarted;
  const retry = service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true
  });
  await Promise.resolve();
  assert.equal(messages[0].meta.agentRunId, "original_run_12345678");
  releaseTurn({
    content: "answer",
    stopReason: "completed",
    transport: "test",
    updates: [],
    session: null
  });

  const [originalResult, retryResult] = await Promise.all([original, retry]);
  assert.equal(runCount, 1);
  assert.equal(messages[0].meta.agentRunId, "original_run_12345678");
  assert.equal(originalResult.assistantMessage.id, retryResult.assistantMessage.id);
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
});

test("a late subscriber receives retained plan, diff, and subagent progress", async () => {
  let releaseTurn;
  let markTurnStarted;
  const turnResult = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const turnStarted = new Promise((resolve) => {
    markTurnStarted = resolve;
  });
  const agentRuns = new AgentRunBroker();
  agentRuns.reserve("late_run_12345678");
  const { service } = createHarness({
    agentRuns,
    runTurn: async ({ onUpdate }) => {
      onUpdate({ type: "plan", itemId: "turn-plan", plan: [{ step: "Implement", status: "inProgress" }] });
      onUpdate({ type: "diff", itemId: "turn-diff", filesChanged: 1, additions: 3, deletions: 1 });
      onUpdate({
        type: "subagent",
        itemId: "subagent:worker",
        scope: "subagent",
        agentThreadId: "worker",
        agentStatus: "running"
      });
      for (let index = 0; index < 140; index += 1) {
        onUpdate({ type: "commandExecution", itemId: `command-${index}`, status: "completed" });
      }
      markTurnStarted();
      return turnResult;
    }
  });

  const original = service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true
  });
  await turnStarted;
  const retry = service.updateQuestion("thread-1", "root", {
    content: "root",
    rerunAgent: true,
    agentRunId: "late_run_12345678"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = agentRuns.snapshot("late_run_12345678");
  assert.ok(snapshot.events.some((event) => event.type === "plan"));
  assert.ok(snapshot.events.some((event) => event.type === "diff"));
  assert.ok(snapshot.events.some((event) => event.type === "subagent"));
  assert.ok(snapshot.events.some((event) => event.itemId === "command-139"));

  releaseTurn({
    content: "answer",
    stopReason: "completed",
    transport: "test",
    updates: [],
    session: null
  });
  await Promise.all([original, retry]);
  agentRuns.dispose();
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

test("document edits are independent from the discussion root selection", async () => {
  let turnInput = null;
  const { service, completeAgentCalls, documentEditCalls } = createHarness({
    documentEdits: true,
    runTurn: async (input) => {
      turnInput = input;
      return {
        content: [
          "<XUANNIAO_DOCUMENT_EDITS>",
          "<XUANNIAO_DOCUMENT_EDIT>",
          "<XUANNIAO_OLD_TEXT>",
          "mermaid diagram",
          "</XUANNIAO_OLD_TEXT>",
          "<XUANNIAO_NEW_TEXT>",
          "updated diagram",
          "</XUANNIAO_NEW_TEXT>",
          "</XUANNIAO_DOCUMENT_EDIT>",
          "</XUANNIAO_DOCUMENT_EDITS>"
        ].join("\n"),
        stopReason: "completed",
        transport: "test",
        updates: [],
        session: null
      };
    }
  });

  const result = await service.addQuestion("thread-1", {
    content: "直接修复文档中的 Mermaid 图",
    parentMessageId: "root",
    askAgent: true
  });

  assert.equal(result.agentOutcome, "completed");
  assert.equal(result.document.content, "updated diagram");
  assert.equal(completeAgentCalls(), 0);
  assert.equal(turnInput.mode, "edit-document");
  assert.equal(turnInput.thread.selectedText, "root");
  assert.equal(documentEditCalls.length, 1);
  assert.deepEqual(documentEditCalls[0].edits, [{
    oldText: "mermaid diagram",
    newText: "updated diagram"
  }]);
  assert.equal(documentEditCalls[0].agentTurn.message.meta.appliedEdit, true);
  assert.match(documentEditCalls[0].agentTurn.expectedBranchRevision, /^[a-f0-9]{64}$/);
});

test("document edits reject a partially malformed multi-edit protocol", async () => {
  const { service, completeAgentCalls, documentEditCalls } = createHarness({
    documentEdits: true,
    runTurn: async () => ({
      content: [
        "<XUANNIAO_DOCUMENT_EDITS>",
        "<XUANNIAO_DOCUMENT_EDIT>",
        "<XUANNIAO_OLD_TEXT>first</XUANNIAO_OLD_TEXT>",
        "<XUANNIAO_NEW_TEXT>updated first</XUANNIAO_NEW_TEXT>",
        "</XUANNIAO_DOCUMENT_EDIT>",
        "<XUANNIAO_DOCUMENT_EDIT>",
        "<XUANNIAO_OLD_TEXT>second</XUANNIAO_OLD_TEXT>",
        "<XUANNIAO_NEW_TEXT>updated second</XUANNIAO_NEW_TEXT>",
        "</XUANNIAO_DOCUMENT_EDITS>"
      ].join("\n"),
      stopReason: "completed",
      transport: "test",
      updates: [],
      session: null
    })
  });

  const result = await service.addQuestion("thread-1", {
    content: "直接修改文档",
    parentMessageId: "root",
    askAgent: true
  });

  assert.equal(result.agentOutcome, "failed");
  assert.equal(result.assistantMessage.error, true);
  assert.equal(completeAgentCalls(), 1);
  assert.equal(documentEditCalls.length, 0);
});

test("reviewing an existing update remains a discussion instead of a document edit", async () => {
  let turnMode = null;
  const { service } = createHarness({
    documentEdits: true,
    runTurn: async (input) => {
      turnMode = input.mode;
      return {
        content: "reviewed",
        stopReason: "completed",
        transport: "test",
        updates: [],
        session: null
      };
    }
  });

  const result = await service.addQuestion("thread-1", {
    content: "Review the update",
    parentMessageId: "root",
    askAgent: true
  });

  assert.equal(result.agentOutcome, "completed");
  assert.equal(turnMode, "chat");
});

test("questions that mention edit verbs remain discussions", async () => {
  const questions = [
    "解释一下为什么删除这段会出错",
    "修改这一段会有什么影响？",
    "How should I fix this?",
    "请修改设置页面的权限选项",
    "Please fix the settings page"
  ];

  for (const content of questions) {
    let turnMode = null;
    const { service } = createHarness({
      documentEdits: true,
      runTurn: async (input) => {
        turnMode = input.mode;
        return {
          content: "explained",
          stopReason: "completed",
          transport: "test",
          updates: [],
          session: null
        };
      }
    });

    const result = await service.addQuestion("thread-1", {
      content,
      parentMessageId: "root",
      askAgent: true
    });

    assert.equal(result.agentOutcome, "completed", content);
    assert.equal(turnMode, "chat", content);
  }
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
