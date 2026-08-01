import assert from "node:assert/strict";
import test from "node:test";

import {
  activeAgentRunMessage,
  agentRunForMessage,
  applyAgentRunSnapshot,
  applyAgentRunUpdate,
  coalesceAgentRunUpdates,
  pendingAgentRunMeta,
  restorePendingAgentRun,
  resumableAgentRuns
} from "./agent-run";
import type { Message, Thread } from "./types";

function fixture(): Thread[] {
  return [{
    id: "thread-1",
    title: "test",
    selectedText: "test",
    anchor: { start: 0, end: 4, lineStart: 1, lineEnd: 1, blockId: null },
    messages: [{
      id: "pending-agent-1",
      role: "assistant",
      content: "",
      meta: pendingAgentRunMeta("run_12345678", "2026-08-01T10:00:00.000Z"),
      createdAt: "2026-08-01T10:00:00.000Z"
    }],
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z"
  }];
}

test("live agent run updates merge command output by item", () => {
  let threads = applyAgentRunUpdate(fixture(), "thread-1", "run_12345678", {
    type: "commandExecution",
    itemId: "item-1",
    status: "inProgress",
    command: "npm test"
  });
  threads = applyAgentRunUpdate(threads, "thread-1", "run_12345678", {
    type: "commandExecution",
    itemId: "item-1",
    outputDelta: "passed\n"
  });
  threads = applyAgentRunUpdate(threads, "thread-1", "run_12345678", {
    type: "commandExecution",
    itemId: "item-1",
    status: "completed",
    exitCode: 0
  });

  const run = agentRunForMessage(threads[0].messages[0]);
  assert.equal(run?.events.length, 1);
  assert.equal(run?.events[0].command, "npm test");
  assert.equal(run?.events[0].output, "passed\n");
  assert.equal(run?.events[0].status, "completed");
});

test("snapshot replaces the live run while preserving its terminal state", () => {
  const threads = applyAgentRunSnapshot(fixture(), "thread-1", "run_12345678", {
    id: "run_12345678",
    status: "completed",
    startedAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:00:03.000Z",
    durationMs: 3_000,
    error: null,
    events: [{ type: "webSearch", itemId: "search-1", query: "Codex API", status: "completed" }]
  });
  assert.equal(agentRunForMessage(threads[0].messages[0])?.status, "completed");
});

test("persisted assistant metadata is presented as a completed run", () => {
  const message: Message = {
    id: "assistant-1",
    role: "assistant",
    content: "done",
    createdAt: "2026-08-01T10:00:00.000Z",
    meta: { durationMs: 2_500, updates: [{ type: "plan", itemId: "turn-plan" }] }
  };
  assert.equal(agentRunForMessage(message)?.durationMs, 2_500);
});

test("persisted unanswered questions can restore their active agent run", () => {
  const threads = fixture();
  threads[0].messages = [{
    id: "question-1",
    role: "user",
    content: "keep working",
    nodeId: "question-1",
    parentId: null,
    meta: { agentRunId: "run_12345678" },
    createdAt: "2026-08-01T10:00:00.000Z"
  }];
  const [candidate] = resumableAgentRuns(threads);
  const restored = restorePendingAgentRun(threads, candidate, {
    id: "run_12345678",
    status: "running",
    startedAt: "2026-08-01T10:00:01.000Z",
    completedAt: null,
    durationMs: null,
    error: null,
    events: [{ type: "commandExecution", itemId: "command-1", outputDelta: "working" }]
  });

  assert.deepEqual(candidate, {
    threadId: "thread-1",
    userMessageId: "question-1",
    runId: "run_12345678"
  });
  assert.equal(restored[0].messages.length, 2);
  assert.equal(restored[0].messages[1].parentId, "question-1");
  assert.equal(agentRunForMessage(restored[0].messages[1])?.status, "running");
});

test("answered questions are not considered resumable", () => {
  const threads = fixture();
  threads[0].messages = [{
    id: "question-1",
    role: "user",
    content: "done?",
    meta: { agentRunId: "run_12345678" },
    createdAt: "2026-08-01T10:00:00.000Z"
  }, {
    id: "assistant-1",
    role: "assistant",
    content: "done",
    parentId: "question-1",
    createdAt: "2026-08-01T10:00:01.000Z"
  }];

  assert.deepEqual(resumableAgentRuns(threads), []);
});

test("agent run updates keep identical item ids isolated by subagent thread", () => {
  const threads = fixture();
  threads[0].messages = [{
    id: "pending-agent-run",
    role: "assistant",
    content: "",
    meta: pendingAgentRunMeta("run_12345678", "2026-08-01T10:00:00.000Z"),
    createdAt: "2026-08-01T10:00:00.000Z"
  }];

  let updated = applyAgentRunUpdate(threads, "thread-1", "run_12345678", {
    type: "commandExecution",
    scope: "subagent",
    agentThreadId: "agent-one",
    itemId: "command-1",
    outputDelta: "one"
  });
  updated = applyAgentRunUpdate(updated, "thread-1", "run_12345678", {
    type: "commandExecution",
    scope: "subagent",
    agentThreadId: "agent-two",
    itemId: "command-1",
    outputDelta: "two"
  });

  const events = agentRunForMessage(updated[0].messages[0])?.events || [];
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => [event.agentThreadId, event.output]), [
    ["agent-one", "one"],
    ["agent-two", "two"]
  ]);
});

test("long live runs retain plan, diff, and subagent progress", () => {
  const events = coalesceAgentRunUpdates([
    { type: "plan", itemId: "turn-plan", plan: [{ step: "实现", status: "inProgress" }] },
    { type: "diff", itemId: "turn-diff", filesChanged: 2, additions: 10, deletions: 1 },
    {
      type: "subagent",
      scope: "subagent",
      itemId: "subagent:agent-1",
      agentThreadId: "agent-1",
      agentStatus: "running"
    },
    ...Array.from({ length: 120 }, (_, index) => ({
      type: "commandExecution",
      itemId: `command-${index}`,
      command: `command ${index}`
    }))
  ]);

  assert.equal(events.length, 120);
  assert.deepEqual(events.slice(0, 3).map((event) => event.type), ["plan", "diff", "subagent"]);
  assert.equal(events.at(-1)?.itemId, "command-119");
});

test("floating progress is selected only from the current node's active messages", () => {
  const running = pendingAssistant("run_selected1");
  const completed: Message = {
    id: "assistant-completed",
    role: "assistant",
    content: "done",
    meta: {
      agentRun: {
        id: "run_other001",
        status: "completed",
        startedAt: "2026-08-02T00:00:00.000Z",
        completedAt: "2026-08-02T00:00:01.000Z",
        durationMs: 1_000,
        error: null,
        events: []
      }
    },
    createdAt: "2026-08-02T00:00:00.000Z"
  };

  assert.equal(activeAgentRunMessage([completed]), null);
  assert.equal(activeAgentRunMessage([completed, running])?.id, running.id);
  assert.equal(activeAgentRunMessage([]), null);
});

function pendingAssistant(runId: string): Message {
  return {
    id: `pending-agent-${runId}`,
    role: "assistant",
    content: "",
    meta: pendingAgentRunMeta(runId, "2026-08-02T00:00:00.000Z"),
    createdAt: "2026-08-02T00:00:00.000Z"
  };
}
