import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";

class StubRuntime extends CodexAppServerRuntime {
  constructor() {
    super({
      documentPath: "/tmp/plan.md",
      cwd: "/tmp",
      commandLine: "codex app-server",
      timeoutMs: 1_000
    });
    this.calls = [];
    this.nextThread = 0;
    this.nextTurn = 0;
  }

  async ensureInitialized() {}

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      this.nextThread += 1;
      return {
        thread: { id: `thread-${this.nextThread}` },
        model: "gpt-default",
        reasoningEffort: "medium"
      };
    }
    if (method === "thread/fork") {
      this.nextThread += 1;
      return {
        thread: { id: `fork-${this.nextThread}` },
        model: "gpt-default",
        reasoningEffort: "medium"
      };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: params.threadId },
        model: "gpt-default",
        reasoningEffort: "medium"
      };
    }
    if (method === "turn/start") {
      this.nextTurn += 1;
      return { turn: { id: `turn-${this.nextTurn}` } };
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  async waitForTurn(_threadId, turnId) {
    return {
      content: `answer from ${turnId}`,
      turn: { id: turnId, status: "completed" },
      updates: [{ type: "agentMessage", status: "completed" }]
    };
  }
}

const document = {
  path: "/tmp/plan.md",
  title: "plan.md",
  content: "# Plan\n\nDetails."
};

test("native runtime persists a semantic session and avoids unchanged context replay", async () => {
  const runtime = new StubRuntime();
  const baseThread = {
    id: "xuanniao-thread",
    sessionKey: "xuanniao-thread:root",
    agentSession: null,
    parentAgentSession: null,
    selectedText: "Details.",
    anchor: {},
    messages: []
  };

  const first = await runtime.runTurn({
    question: "Review this",
    document,
    thread: baseThread
  });
  const persisted = first.session;
  assert.equal(first.transport, "codex-app-server");
  assert.equal(persisted.adapter, "codex-app-server");
  assert.equal(persisted.sessionId, "thread-1");
  assert.equal(persisted.turnId, "turn-1");
  const firstTurn = runtime.calls.find(({ method }) => method === "turn/start");
  const firstPrompt = firstTurn.params.input[0].text;
  assert.equal(firstTurn.params.model, "gpt-default");
  assert.equal(firstTurn.params.effort, "medium");
  assert.equal(first.model, "gpt-default");
  assert.equal(first.reasoningEffort, "medium");
  assert.match(firstPrompt, /<XUANNIAO_DOCUMENT>/);

  runtime.calls = [];
  await runtime.runTurn({
    question: "Continue",
    document,
    thread: { ...baseThread, agentSession: persisted }
  });
  const resumedPrompt = runtime.calls.find(({ method }) => method === "turn/start").params.input[0].text;
  assert.doesNotMatch(resumedPrompt, /<XUANNIAO_DOCUMENT>/);
  assert.doesNotMatch(resumedPrompt, /<XUANNIAO_BRANCH_HISTORY>/);
});

test("native child branches fork from the exact parent turn", async () => {
  const runtime = new StubRuntime();
  const session = await runtime.ensureThread({
    id: "xuanniao-thread",
    agentSession: null,
    parentAgentSession: {
      adapter: "codex-app-server",
      sessionId: "parent-thread",
      turnId: "parent-turn",
      documentHash: "parent-hash"
    }
  });

  assert.equal(session.historyMode, "forked");
  assert.deepEqual(runtime.calls[0], {
    method: "thread/fork",
    params: {
      threadId: "parent-thread",
      lastTurnId: "parent-turn",
      cwd: "/tmp",
      sandbox: "danger-full-access"
    }
  });
});

test("native resumed turns inject local-only messages missing from agent history", async () => {
  const runtime = new StubRuntime();
  runtime.loadedThreads.add("stored-thread");
  const thread = {
    id: "xuanniao-thread",
    sessionKey: "xuanniao-thread:root",
    agentSession: {
      adapter: "codex-app-server",
      sessionId: "stored-thread",
      turnId: "stored-turn",
      documentHash: "different-hash"
    },
    parentAgentSession: null,
    selectedText: "Details.",
    anchor: {},
    messages: [],
    unsyncedCurrentNodeMessages: [{ role: "user", content: "Local-only note" }]
  };

  await runtime.runTurn({ question: "Continue", document, thread });
  const prompt = runtime.calls.find(({ method }) => method === "turn/start").params.input[0].text;
  assert.match(prompt, /<XUANNIAO_BRANCH_HISTORY>/);
  assert.match(prompt, /Local-only note/);
});

test("native runtime lists paginated models and applies settings to the next turn", async () => {
  const runtime = new StubRuntime();
  const modelResponses = [
    {
      data: [{
        id: "gpt-fast",
        model: "gpt-fast",
        displayName: "Fast",
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }]
      }],
      nextCursor: "page-2"
    },
    {
      data: [{
        id: "gpt-deep",
        model: "gpt-deep",
        displayName: "Deep",
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }]
      }],
      nextCursor: null
    }
  ];
  const baseRequest = runtime.request.bind(runtime);
  runtime.request = async (method, params) => {
    if (method === "model/list") {
      runtime.calls.push({ method, params });
      return modelResponses.shift();
    }
    return baseRequest(method, params);
  };

  const models = await runtime.listModels();
  assert.deepEqual(models.map((model) => model.model), ["gpt-fast", "gpt-deep"]);
  assert.deepEqual(runtime.calls.filter(({ method }) => method === "model/list").map(({ params }) => params), [
    { limit: 100, includeHidden: false },
    { cursor: "page-2", limit: 100, includeHidden: false }
  ]);

  runtime.configure({ model: "gpt-deep", reasoningEffort: "high" });
  const configuredTurn = await runtime.runTurn({
    question: "Think deeply",
    document,
    thread: {
      id: "settings-thread",
      sessionKey: "settings-thread:root",
      agentSession: null,
      parentAgentSession: null,
      selectedText: "Details.",
      anchor: {},
      messages: []
    }
  });
  const turnStart = runtime.calls.find(({ method }) => method === "turn/start");
  assert.equal(turnStart.params.model, "gpt-deep");
  assert.equal(turnStart.params.effort, "high");
  assert.equal(configuredTurn.model, "gpt-deep");
  assert.equal(configuredTurn.reasoningEffort, "high");

  runtime.calls = [];
  runtime.configure();
  const defaultTurn = await runtime.runTurn({
    question: "Use defaults again",
    document,
    thread: {
      id: "settings-thread",
      sessionKey: "settings-thread:root",
      agentSession: configuredTurn.session,
      parentAgentSession: null,
      selectedText: "Details.",
      anchor: {},
      messages: []
    }
  });
  const defaultTurnStart = runtime.calls.find(({ method }) => method === "turn/start");
  assert.equal(defaultTurnStart.params.model, "gpt-fast");
  assert.equal(defaultTurnStart.params.effort, "low");
  assert.equal(defaultTurn.model, "gpt-fast");
  assert.equal(defaultTurn.reasoningEffort, "low");
});

test("native approvals remain pending until the user resolves them", () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp"
  });
  const writes = [];
  runtime.process = {
    killed: false,
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line))
    }
  };
  runtime.threadOwners.set("codex-thread", "xuanniao-thread");

  runtime.handleServerRequest({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "codex-thread",
      turnId: "turn-1",
      itemId: "item-1",
      command: "npm test"
    }
  });

  const [request] = runtime.listPermissionRequests();
  assert.equal(request.threadId, "xuanniao-thread");
  assert.equal(request.title, "Allow command: npm test");
  assert.equal(writes.length, 0);
  runtime.resolvePermissionRequest(request.id, { optionId: "accept" });
  assert.deepEqual(writes, [{ id: 41, result: { decision: "accept" } }]);
});

test("native legacy approvals use legacy response decisions", () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp"
  });
  const writes = [];
  runtime.process = {
    killed: false,
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line))
    }
  };

  runtime.handleServerRequest({
    id: 42,
    method: "execCommandApproval",
    params: {
      conversationId: "codex-thread",
      callId: "call-1",
      command: ["npm", "test"]
    }
  });

  const [request] = runtime.listPermissionRequests();
  assert.equal(request.title, "Allow command: npm test");
  assert.equal(request.sessionId, "codex-thread");
  assert.equal(request.toolCallId, "call-1");
  runtime.resolvePermissionRequest(request.id, { optionId: "acceptForSession" });
  assert.deepEqual(writes, [{ id: 42, result: { decision: "approved_for_session" } }]);
});

test("native turn timeout interrupts the remote turn before releasing it", async () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    timeoutMs: 10,
    interruptGraceMs: 100
  });
  const writes = [];
  runtime.process = {
    killed: false,
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line))
    },
    kill() {
      this.killed = true;
    }
  };

  const completed = runtime.waitForTurn("thread-1", "turn-timeout");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(writes[0], {
    id: 1,
    method: "turn/interrupt",
    params: {
      threadId: "thread-1",
      turnId: "turn-timeout"
    }
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-timeout", status: "interrupted" }
    }
  });
  await assert.rejects(completed, /timed out and was interrupted/);
  assert.equal(runtime.turns.size, 0);
  assert.equal(runtime.earlyTurnEvents.size, 0);
  runtime.dispose();
});

test("native turn inactivity timeout is refreshed by Codex activity", async () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    timeoutMs: 50,
    interruptGraceMs: 100
  });
  const writes = [];
  runtime.process = {
    killed: false,
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line))
    },
    kill() {
      this.killed = true;
    }
  };

  const completed = runtime.waitForTurn("thread-1", "turn-active");
  await new Promise((resolve) => setTimeout(resolve, 30));
  runtime.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-active",
      delta: "Still working"
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(writes, []);
  runtime.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-active", status: "completed" }
    }
  });

  const result = await completed;
  assert.equal(result.content, "Still working");
  runtime.dispose();
});

test("native turn inactivity timeout pauses for an approval with a stale turn id", async () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    timeoutMs: 20,
    interruptGraceMs: 100
  });
  const writes = [];
  runtime.process = {
    killed: false,
    stdin: {
      writable: true,
      write: (line) => writes.push(JSON.parse(line))
    },
    kill() {
      this.killed = true;
    }
  };

  const completed = runtime.waitForTurn("thread-approval", "turn-approval");
  runtime.handleServerRequest({
    id: 42,
    method: "execCommandApproval",
    params: {
      conversationId: "thread-approval",
      turnId: "stale-turn-id",
      callId: "call-1",
      command: ["npm", "test"]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(writes, []);

  const [request] = runtime.listPermissionRequests();
  runtime.resolvePermissionRequest(request.id, { optionId: "accept" });
  runtime.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-approval",
      turn: { id: "turn-approval", status: "completed" }
    }
  });

  await completed;
  assert.deepEqual(writes, [{ id: 42, result: { decision: "approved" } }]);
  runtime.dispose();
});

test("native runtime restarts after an interrupted turn never reaches a terminal state", async () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    timeoutMs: 5,
    interruptGraceMs: 5
  });
  const processStub = {
    killed: false,
    stdin: {
      writable: true,
      write() {}
    },
    kill() {
      this.killed = true;
    }
  };
  runtime.process = processStub;
  runtime.initialized = true;

  await assert.rejects(runtime.waitForTurn("thread-1", "stuck-turn"), /timed out and was interrupted/);
  assert.equal(processStub.killed, true);
  assert.equal(runtime.initialized, false);
  runtime.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "stuck-turn", status: "interrupted" }
    }
  });
  assert.equal(runtime.earlyTurnEvents.size, 0);
  runtime.dispose();
});

test("native event stream preserves final messages and tool lifecycle updates", async () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    timeoutMs: 1_000
  });
  const liveUpdates = [];
  const completed = runtime.waitForTurn("thread-1", "turn-1", {
    onUpdate: (update) => liveUpdates.push(update)
  });
  runtime.handleNotification({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        status: "inProgress",
        command: "npm test"
      }
    }
  });
  runtime.handleNotification({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      delta: "all tests passed\n"
    }
  });
  runtime.handleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        status: "completed",
        command: "npm test",
        aggregatedOutput: "all tests passed\n",
        exitCode: 0
      }
    }
  });
  runtime.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      delta: "Done."
    }
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    }
  });

  const result = await completed;
  assert.equal(result.content, "Done.");
  assert.deepEqual(result.updates[0], {
    type: "commandExecution",
    status: "completed",
    itemId: "command-1",
    command: "npm test",
    cwd: "",
    output: "all tests passed\n",
    exitCode: 0
  });
  assert.equal(liveUpdates.length, 3);
  assert.equal(liveUpdates[1].outputDelta, "all tests passed\n");
});

test("native event stream batches adjacent command output deltas", async () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    timeoutMs: 1_000
  });
  const liveUpdates = [];
  const completed = runtime.waitForTurn("thread-1", "turn-batched-output", {
    onUpdate: (update) => liveUpdates.push(update)
  });

  for (const delta of ["first ", "second ", "third"]) {
    runtime.handleNotification({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-batched-output",
        itemId: "command-1",
        delta
      }
    });
  }
  runtime.handleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-batched-output",
      item: {
        id: "command-1",
        type: "commandExecution",
        status: "completed",
        command: "printf output",
        aggregatedOutput: "first second third",
        exitCode: 0
      }
    }
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-batched-output", status: "completed" }
    }
  });

  await completed;
  const outputUpdates = liveUpdates.filter((update) => update.outputDelta);
  assert.equal(outputUpdates.length, 1);
  assert.equal(outputUpdates[0].outputDelta, "first second third");
});
