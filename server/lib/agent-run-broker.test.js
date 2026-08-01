import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunBroker, interruptedAgentRunSnapshot, normalizeAgentRunId } from "./agent-run-broker.js";

test("agent run broker replays snapshots and streams bounded updates", () => {
  let now = Date.parse("2026-08-01T10:00:00.000Z");
  const broker = new AgentRunBroker({ maxEvents: 2, now: () => now });
  const messages = [];
  broker.reserve("run_12345678");
  const unsubscribe = broker.subscribe("run_12345678", (message) => messages.push(message));

  broker.start("run_12345678", { threadId: "thread-1" });
  broker.publish("run_12345678", { type: "commandExecution", status: "inProgress" });
  now += 1_000;
  broker.publish("run_12345678", { type: "commandExecution", status: "completed" });
  broker.publish("run_12345678", { type: "webSearch", status: "completed" });
  now += 2_000;
  const completed = broker.complete("run_12345678");

  assert.equal(messages[0].type, "snapshot");
  assert.equal(messages.filter((message) => message.type === "update").length, 3);
  assert.equal(completed.status, "completed");
  assert.equal(completed.durationMs, 3_000);
  assert.deepEqual(completed.events.map((event) => event.seq), [2, 3]);
  assert.equal(completed.context.threadId, "thread-1");
  unsubscribe();
  broker.dispose();
});

test("agent run snapshots retain the latest plan, diff, and subagent lifecycle", () => {
  const broker = new AgentRunBroker({ maxEvents: 4 });
  broker.reserve("run_featured1");
  broker.publish("run_featured1", { type: "plan", itemId: "plan", plan: [{ step: "实现", status: "inProgress" }] });
  broker.publish("run_featured1", { type: "diff", itemId: "diff", filesChanged: 2 });
  broker.publish("run_featured1", { type: "subagent", scope: "subagent", agentThreadId: "agent-1", agentStatus: "running" });
  for (let index = 0; index < 8; index += 1) {
    broker.publish("run_featured1", { type: "commandExecution", itemId: `command-${index}` });
  }

  const snapshot = broker.snapshot("run_featured1");

  assert.deepEqual(snapshot.events.map((event) => event.type), ["plan", "diff", "subagent", "commandExecution"]);
  assert.equal(snapshot.events.at(-1).itemId, "command-7");
  broker.dispose();
});

test("agent run ids are optional but validated when present", () => {
  assert.equal(normalizeAgentRunId(null), null);
  assert.equal(normalizeAgentRunId("valid_run-123"), "valid_run-123");
  assert.throws(() => normalizeAgentRunId("bad id"), /agentRunId/);
});

test("disposing the broker closes active subscribers", () => {
  const broker = new AgentRunBroker();
  const messages = [];
  broker.reserve("run_12345678");
  broker.subscribe("run_12345678", (message) => messages.push(message));

  broker.dispose();

  assert.equal(messages.at(-1).type, "shutdown");
  assert.equal(broker.runs.size, 0);
});

test("agent run subscriptions require an explicit reservation", () => {
  const broker = new AgentRunBroker();

  assert.throws(
    () => broker.subscribe("run_12345678", () => {}),
    (error) => error.code === "AGENT_RUN_NOT_FOUND" && error.statusCode === 404
  );
  assert.equal(broker.runs.size, 0);
});

test("agent run capacity remains a hard limit while active runs are subscribed", () => {
  const broker = new AgentRunBroker({ maxRuns: 1 });
  broker.reserve("run_11111111");
  broker.subscribe("run_11111111", () => {});

  assert.throws(
    () => broker.reserve("run_22222222"),
    (error) => error.code === "AGENT_RUN_CAPACITY_EXCEEDED" && error.statusCode === 503
  );
  assert.deepEqual([...broker.runs.keys()], ["run_11111111"]);
  broker.dispose();
});

test("an unanswered persisted question exposes an interrupted run after restart", () => {
  const snapshot = interruptedAgentRunSnapshot("run_12345678", [{
    id: "thread-1",
    messages: [{
      id: "question-1",
      role: "user",
      content: "continue",
      meta: { agentRunId: "run_12345678" },
      createdAt: "2026-08-01T10:00:00.000Z"
    }]
  }], () => Date.parse("2026-08-01T10:00:03.000Z"));

  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.durationMs, 3_000);
  assert.equal(snapshot.context.interrupted, true);
  assert.match(snapshot.error, /请重试当前节点/);
});

test("completed questions are not mistaken for interrupted runs", () => {
  const snapshot = interruptedAgentRunSnapshot("run_12345678", [{
    id: "thread-1",
    messages: [{
      id: "question-1",
      role: "user",
      content: "continue",
      meta: { agentRunId: "run_12345678" }
    }, {
      id: "assistant-1",
      role: "assistant",
      content: "done",
      parentId: "question-1"
    }]
  }]);

  assert.equal(snapshot, null);
});
