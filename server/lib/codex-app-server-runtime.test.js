import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_DEVELOPER_INSTRUCTIONS } from "./agent-context.js";
import { CodexAppServerRuntime, summarizeUnifiedDiff } from "./codex-app-server-runtime.js";

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
    this.failMethods = new Set();
  }

  async ensureInitialized() {}

  async request(method, params) {
    this.calls.push({ method, params });
    if (this.failMethods.has(method)) {
      throw new Error(`${method} failed`);
    }
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

class ControlledRuntime extends StubRuntime {
  constructor() {
    super();
    this.modelCatalog = [];
    this.interruptGraceMs = 100;
    this.writes = [];
  }

  writeMessage(message) { this.writes.push(message); }

  async request(method, params) {
    if (method === "turn/interrupt" || method === "thread/read") {
      this.calls.push({ method, params });
      return {};
    }
    const result = await super.request(method, params);
    if (method === "thread/start") {
      result.approvalPolicy = params.approvalPolicy;
      result.sandbox = { type: params.sandbox === "read-only" ? "readOnly" : "dangerFullAccess" };
    }
    return result;
  }

  waitForTurn(...args) { return CodexAppServerRuntime.prototype.waitForTurn.call(this, ...args); }
}

function turnInput(extra = {}) {
  return { question: "Inspect the implementation", document, thread: { id: "discussion", messages: [] }, ...extra };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected runtime transition did not occur");
}

function complete(runtime, threadId = "thread-1", turnId = "turn-1", status = "interrupted") {
  runtime.handleNotification({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
}

test("stop waits for native completion, cancels approvals and is idempotent", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const updates = [];
  const answer = runtime.runTurn(turnInput({ runId: "run-stop", onUpdate: (update) => updates.push(update) }));
  assert.equal(runtime.isBusy("discussion"), true);
  await eventually(() => runtime.turns.size === 1);
  runtime.handleServerRequest({ id: 10, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "stale", command: "write file" } });
  assert.equal(runtime.listPermissionRequests().length, 1);
  let resolved = false;
  const stopped = runtime.stop({ runId: "run-stop" }).then((result) => { resolved = true; return result; });
  const repeated = runtime.interrupt("discussion");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "RPC acknowledgement must not release the run");
  assert.equal(runtime.isBusy(), true);
  assert.deepEqual(runtime.writes, [{ id: 10, result: { decision: "cancel" } }]);
  runtime.handleServerRequest({ id: 11, method: "item/permissions/requestApproval", params: { threadId: "thread-1", permissions: { fileSystem: { write: ["/tmp"] } } } });
  assert.deepEqual(runtime.writes.at(-1).result, { permissions: {}, scope: "turn" });
  assert.equal(runtime.listPermissionRequests().length, 0);
  complete(runtime);
  const result = await stopped;
  assert.equal(result.status, "interrupted");
  assert.equal(result.terminal, true);
  assert.deepEqual(await repeated, result);
  assert.deepEqual(await runtime.stop({ runId: "run-stop" }), result);
  assert.equal(runtime.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  await assert.rejects(answer, { code: "AGENT_INTERRUPTED", stopReason: "interrupted" });
  assert.equal(runtime.isBusy(), false);
  assert.deepEqual(updates.filter((update) => update.type === "run").map((update) => update.status), ["starting", "running", "stopping", "interrupted"]);
});

test("stop before initialization finishes never submits a native turn", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  let initialize;
  runtime.ensureInitialized = () => new Promise((resolve) => { initialize = resolve; });
  const answer = runtime.runTurn(turnInput());
  await eventually(() => initialize);
  assert.equal((await runtime.stop()).status, "interrupted");
  await assert.rejects(answer, { code: "AGENT_INTERRUPTED" });
  initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.calls, []);
  assert.equal(runtime.isBusy(), false);
});

test("stop during turn/start uses early notifications without waiting for its response", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const request = runtime.request.bind(runtime);
  let returnStart;
  runtime.request = (method, params) => {
    if (method !== "turn/start") return request(method, params);
    return new Promise((resolve) => { returnStart = resolve; });
  };
  const answer = runtime.runTurn(turnInput());
  await eventually(() => returnStart);
  const stopped = runtime.stop();
  runtime.handleServerRequest({ id: 21, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "early" } });
  runtime.handleNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "early", status: "inProgress" } } });
  complete(runtime, "thread-1", "early");
  assert.equal((await stopped).status, "interrupted");
  await assert.rejects(answer, (error) => error.code === "AGENT_INTERRUPTED" && error.result.turnId === "early");
  assert.deepEqual(runtime.calls.find((call) => call.method === "turn/interrupt").params, { threadId: "thread-1", turnId: "early" });
  assert.equal(runtime.listPermissionRequests().length, 0);
  returnStart({ turn: { id: "early" } });
});

test("stop timeout reports unknown and retains ownership until a real terminal event", async (t) => {
  const runtime = new ControlledRuntime();
  runtime.interruptGraceMs = 10;
  t.after(() => runtime.dispose());
  const answer = runtime.runTurn(turnInput({ runId: "slow-stop" }));
  await eventually(() => runtime.turns.size === 1);
  await assert.rejects(runtime.stop(), (error) => {
    assert.equal(error.code, "AGENT_STOP_TIMEOUT");
    assert.equal(error.result.status, "unknown");
    assert.equal(error.result.terminal, false);
    return true;
  });
  assert.equal(runtime.isBusy(), true);
  await assert.rejects(runtime.stop(), { code: "AGENT_STOP_TIMEOUT" });
  assert.equal(runtime.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  complete(runtime);
  await assert.rejects(answer, { code: "AGENT_INTERRUPTED" });
  assert.equal((await runtime.stop({ runId: "slow-stop" })).status, "interrupted");
  assert.equal(runtime.isBusy(), false);
});

test("completion racing with stop retains completed status and partial output", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const answer = runtime.runTurn(turnInput());
  await eventually(() => runtime.turns.size === 1);
  runtime.handleNotification({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "Already done" } });
  const stopped = runtime.stop();
  complete(runtime, "thread-1", "turn-1", "completed");
  assert.equal((await stopped).status, "completed");
  assert.equal((await answer).content, "Already done");
});

test("stop drains nested and late children after the root terminal event", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const answer = runtime.runTurn(turnInput());
  await eventually(() => runtime.turns.size === 1);
  runtime.handleNotification({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "thread-1", status: { type: "active" } } } });
  runtime.handleNotification({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
  const stopped = runtime.stop();
  complete(runtime);
  assert.equal(runtime.isBusy(), true);
  runtime.handleNotification({ method: "thread/started", params: { thread: { id: "grandchild", parentThreadId: "child", status: { type: "active" } } } });
  runtime.handleNotification({ method: "turn/started", params: { threadId: "grandchild", turn: { id: "grandchild-turn" } } });
  runtime.handleServerRequest({ id: 31, method: "execCommandApproval", params: { conversationId: "grandchild", turnId: "old" } });
  assert.deepEqual(runtime.writes.at(-1).result, { decision: "abort" });
  complete(runtime, "child", "child-turn");
  assert.equal(runtime.isBusy(), true);
  complete(runtime, "grandchild", "grandchild-turn");
  assert.equal((await stopped).status, "interrupted");
  await assert.rejects(answer, (error) => {
    assert.equal(error.code, "AGENT_INTERRUPTED");
    assert.equal(error.updates.filter((update) => update.type === "subagent" && update.agentStatus === "interrupted").length, 2);
    return true;
  });
  assert.deepEqual(runtime.calls.filter((call) => call.method === "turn/interrupt").map((call) => call.params.turnId).sort(), ["child-turn", "grandchild-turn", "turn-1"]);
});

test("targeted stop does not interrupt unrelated concurrent sessions", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const first = runtime.runTurn(turnInput({ runId: "first" }));
  const second = runtime.runTurn(turnInput({ runId: "second", thread: { id: "other", messages: [] } }));
  await eventually(() => runtime.turns.size === 2);
  await assert.rejects(runtime.stop(), { code: "AGENT_STOP_AMBIGUOUS" });
  const stopped = runtime.stop({ runId: "first" });
  const target = runtime.status().runs.find((run) => run.runId === "first");
  complete(runtime, target.sessionId, target.turnId);
  await stopped;
  await assert.rejects(first, { code: "AGENT_INTERRUPTED" });
  assert.equal(runtime.isBusy("other"), true);
  const remaining = runtime.status().runs[0];
  complete(runtime, remaining.sessionId, remaining.turnId, "completed");
  await second;
  assert.equal(runtime.calls.filter((call) => call.method === "turn/interrupt").length, 1);
});

test("lost process reports unknown with provenance and blocks accidental retries", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  runtime.process = { pid: 12345, killed: false, kill() { this.killed = true; } };
  runtime.processInfo = { pid: 12345, startedAt: "2026-09-05T00:00:00Z" };
  const answer = runtime.runTurn(turnInput({ runId: "lost" }));
  await eventually(() => runtime.turns.size === 1);
  runtime.handleNotification({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "Result before exit" } });
  runtime.handleNotification({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "command-1", type: "commandExecution", command: "long-running-work", processId: "native-process-1" } } });
  const stopped = runtime.stop();
  runtime.handleProcessExit(new Error("process closed"));
  await assert.rejects(stopped, { code: "AGENT_RUNTIME_LOST" });
  await assert.rejects(answer, (error) => {
    assert.equal(error.code, "AGENT_RUNTIME_LOST");
    assert.equal(error.result.status, "unknown");
    assert.equal(error.result.process.pid, 12345);
    assert.equal(error.result.process.servicePid, process.pid);
    assert.equal(error.result.runId, "lost");
    assert.equal(error.content, "Result before exit");
    assert.equal(error.updates.find((update) => update.type === "commandExecution").processId, "native-process-1");
    assert.ok(error.result.process.exitedAt);
    return true;
  });
  assert.equal(runtime.isBusy(), true);
  await assert.rejects(runtime.runTurn(turnInput()), { code: "AGENT_RUNTIME_LOST" });
  assert.ok(runtime.status().process.exitedAt);
});

test("proposal uses confirmed native read-only policy in a fresh session without changing normal sessions", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  runtime.configure({ permissionMode: "full-access" });
  const normal = runtime.runTurn(turnInput());
  await eventually(() => runtime.turns.size === 1);
  complete(runtime, "thread-1", "turn-1", "completed");
  const normalSession = (await normal).session;
  runtime.calls = [];
  const proposal = runtime.runTurn(turnInput({ mode: "proposal", thread: { id: "discussion", agentSession: normalSession, parentAgentSession: normalSession, selectedText: "quoted source", references: [], messages: [] } }));
  await eventually(() => runtime.turns.size === 1);
  const start = runtime.calls.find((call) => call.method === "thread/start");
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.approvalsReviewer, "user");
  assert.equal(runtime.calls.some((call) => ["thread/resume", "thread/fork"].includes(call.method)), false);
  const turn = runtime.calls.find((call) => call.method === "turn/start");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.params.approvalPolicy, "never");
  for (const [id, method] of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval"].entries()) {
    runtime.handleServerRequest({ id, method, params: { threadId: "thread-2", turnId: "turn-2" } });
  }
  assert.equal(runtime.writes.length, 5);
  assert.equal(runtime.listPermissionRequests().length, 0);
  assert.equal(runtime.status().permissionMode, "full-access");
  complete(runtime, "thread-2", "turn-2", "completed");
  const proposalSession = (await proposal).session;
  assert.equal(proposalSession.mode, "proposal");
  assert.notEqual(proposalSession.sessionId, normalSession.sessionId);
  runtime.calls = [];
  const next = runtime.runTurn(turnInput({ thread: { id: "discussion", agentSession: normalSession, messages: [] } }));
  await eventually(() => runtime.turns.size === 1);
  assert.equal(runtime.calls.find((call) => call.method === "turn/start").params.threadId, normalSession.sessionId);
  assert.equal(runtime.calls.find((call) => call.method === "turn/start").params.sandboxPolicy, undefined);
  complete(runtime, normalSession.sessionId, "turn-3", "completed");
  await next;
});

test("proposal fails closed when native thread settings do not confirm isolation", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const request = runtime.request.bind(runtime);
  runtime.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "thread/start") result.sandbox = { type: "workspaceWrite" };
    return result;
  };
  await assert.rejects(runtime.runTurn(turnInput({ mode: "proposal" })), { code: "AGENT_PROPOSAL_SANDBOX_UNCONFIRMED" });
  assert.equal(runtime.calls.some((call) => call.method === "turn/start"), false);
  assert.equal(runtime.isBusy(), false);
});

test("proposal sessions cannot be resumed or forked into an ordinary run", async () => {
  const runtime = new StubRuntime();
  const proposalSession = { adapter: "codex-app-server", sessionId: "proposal", mode: "proposal" };
  await runtime.runTurn(turnInput({ thread: { id: "discussion", agentSession: proposalSession, parentAgentSession: proposalSession, messages: [] } }));
  assert.equal(runtime.calls[0].method, "thread/start");
  assert.equal(runtime.calls[0].params.sandbox, "workspace-write");
});

test("default proposal keeps the current document read-only and forwards the parent's proposal context", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const proposal = { target: { start: 8, end: 16 }, source: { title: "Source conclusion", documentPath: document.path, content: "Keep API compatibility", messageId: "internal-source-id", revision: "internal-version" }, previous: "Prior draft" };
  const answer = runtime.runTurn(turnInput({ mode: "proposal", question: "Only update this paragraph", thread: { id: "discussion", proposal, references: [structuredClone(proposal.source)], messages: [] } }));
  await eventually(() => runtime.turns.size === 1);
  assert.equal(runtime.status().permissionMode, "request-approval");
  const threadStart = runtime.calls.find((call) => call.method === "thread/start");
  assert.equal(threadStart.params.sandbox, "read-only");
  assert.equal(threadStart.params.approvalPolicy, "never");
  const turnStart = runtime.calls.find((call) => call.method === "turn/start");
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turnStart.params.cwd, runtime.cwd);
  const prompt = turnStart.params.input[0].text;
  const markedDocument = document.content.slice(0, 8) + "<XUANNIAO_EDIT_TARGET>" + document.content.slice(8, 16) + "</XUANNIAO_EDIT_TARGET>" + document.content.slice(16);
  for (const content of [document.path, markedDocument, proposal.source.content, proposal.previous, "Only update this paragraph", "<XUANNIAO_PROPOSAL>"]) assert.ok(prompt.includes(content));
  assert.equal(prompt.split(proposal.source.content).length - 1, 1);
  assert.doesNotMatch(prompt, /internal-source-id|internal-version|UTF-16/);
  runtime.handleNotification({ method: "thread/started", params: { thread: { id: "proposal-child", parentThreadId: "thread-1", status: { type: "active" } } } });
  runtime.handleServerRequest({ id: 41, method: "item/fileChange/requestApproval", params: { threadId: "proposal-child", turnId: "child-turn", grantRoot: document.path } });
  assert.deepEqual(runtime.writes.at(-1).result, { decision: "cancel" });
  assert.equal(runtime.listPermissionRequests().length, 0);
  complete(runtime, "proposal-child", "child-turn", "completed");
  complete(runtime, "thread-1", "turn-1", "completed");
  assert.equal((await answer).mode, "proposal");
  assert.equal(document.content, "# Plan\n\nDetails.");
});

test("failed native turn after stop preserves failure and collected output", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const answer = runtime.runTurn(turnInput());
  await eventually(() => runtime.turns.size === 1);
  runtime.handleNotification({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "Partial result" } });
  const stopped = runtime.stop();
  complete(runtime, "thread-1", "turn-1", "failed");
  assert.equal((await stopped).status, "failed");
  await assert.rejects(answer, { code: "AGENT_TURN_FAILED", content: "Partial result" });
});

test("stop discovers an active child turn id and does not mistake a child error for termination", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const request = runtime.request.bind(runtime);
  runtime.request = async (method, params) => {
    if (method === "thread/read") return { thread: { status: { type: "active" }, turns: [{ id: "hidden-turn", status: "inProgress" }] } };
    return request(method, params);
  };
  const answer = runtime.runTurn(turnInput());
  await eventually(() => runtime.turns.size === 1);
  runtime.handleNotification({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "thread-1", status: { type: "active" } } } });
  const stopped = runtime.stop();
  await eventually(() => runtime.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "hidden-turn"));
  runtime.handleNotification({ method: "error", params: { threadId: "child", turnId: "hidden-turn", willRetry: false, error: { message: "tool failed" } } });
  complete(runtime);
  assert.equal(runtime.isBusy(), true);
  complete(runtime, "child", "hidden-turn");
  await stopped;
  await assert.rejects(answer, { code: "AGENT_INTERRUPTED" });
});

test("stop without early notifications interrupts once turn/start returns", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const request = runtime.request.bind(runtime);
  let startReply;
  runtime.request = (method, params) => method === "turn/start"
    ? new Promise((resolve) => { startReply = resolve; })
    : request(method, params);
  const answer = runtime.runTurn(turnInput());
  await eventually(() => startReply);
  runtime.handleServerRequest({ id: 52, method: "item/fileChange/requestApproval", params: { threadId: "thread-1" } });
  assert.equal(runtime.listPermissionRequests().length, 1);
  const stopped = runtime.stop();
  assert.deepEqual(runtime.writes.at(-1), { id: 52, result: { decision: "cancel" } });
  startReply({ turn: { id: "delayed-turn" } });
  await eventually(() => runtime.calls.some((call) => call.method === "turn/interrupt"));
  complete(runtime, "thread-1", "delayed-turn");
  assert.equal((await stopped).status, "interrupted");
  await assert.rejects(answer, { code: "AGENT_INTERRUPTED" });
});

test("native root completion drains remaining children before releasing the runtime", async (t) => {
  const runtime = new ControlledRuntime();
  t.after(() => runtime.dispose());
  const answer = runtime.runTurn(turnInput());
  await eventually(() => runtime.turns.size === 1);
  runtime.handleNotification({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "thread-1", status: { type: "active" } } } });
  runtime.handleNotification({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
  complete(runtime, "thread-1", "turn-1", "completed");
  assert.equal(runtime.isBusy(), true);
  assert.deepEqual(runtime.calls.filter((call) => call.method === "turn/interrupt").map((call) => call.params.turnId), ["child-turn"]);
  const stopped = runtime.stop();
  complete(runtime, "child", "child-turn");
  assert.equal((await stopped).status, "completed");
  assert.equal((await answer).stopReason, "completed");
});

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
  assert.equal(runtime.calls.find(({ method }) => method === "thread/start").params.developerInstructions, AGENT_DEVELOPER_INSTRUCTIONS);
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

test("document creation follows the selected full-access permission mode", async () => {
  const runtime = new StubRuntime();
  runtime.configure({ permissionMode: "full-access" });
  await runtime.runTurn({
    question: "Create an issue analysis document",
    document: { path: "/tmp", title: "New document", content: "" },
    thread: {
      id: "document-creation-run_12345678",
      sessionKey: "document-creation-run_12345678",
      agentSession: null,
      parentAgentSession: null,
      selectedText: "",
      anchor: {},
      messages: []
    },
    mode: "create-document"
  });

  const threadStart = runtime.calls.find(({ method }) => method === "thread/start");
  const turnStart = runtime.calls.find(({ method }) => method === "turn/start");
  assert.equal(threadStart.params.sandbox, "danger-full-access");
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(threadStart.params.approvalsReviewer, "user");
  assert.match(turnStart.params.input[0].text, /Do not create or modify any file/i);
});

test("native child branches rely on Codex to fork the exact parent history", async () => {
  const runtime = new StubRuntime();
  runtime.documentSnapshots.set("parent-thread", "a newer document snapshot");
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

  assert.equal(session.sessionId, "fork-1");
  assert.equal(session.historyMode, "inherited");
  assert.deepEqual(runtime.calls[0], {
    method: "thread/fork",
    params: {
      threadId: "parent-thread",
      lastTurnId: "parent-turn",
      cwd: "/tmp",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      developerInstructions: AGENT_DEVELOPER_INSTRUCTIONS
    }
  });
  assert.equal(runtime.documentSnapshots.get(session.sessionId), undefined);
});

test("native resumed threads refresh Xuanniao developer instructions", async () => {
  const runtime = new StubRuntime();
  await runtime.ensureThread({
    id: "xuanniao-thread",
    agentSession: {
      adapter: "codex-app-server",
      sessionId: "stored-thread",
      turnId: "stored-turn",
      documentHash: "stored-hash"
    },
    parentAgentSession: null
  });

  const resumed = runtime.calls.find(({ method }) => method === "thread/resume");
  assert.equal(resumed.params.developerInstructions, AGENT_DEVELOPER_INSTRUCTIONS);
});

test("native resumed turns supplement local messages missing from the Codex thread", async () => {
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

test("native resume failure starts a new thread and rebuilds history", async () => {
  const runtime = new StubRuntime();
  runtime.failMethods.add("thread/resume");
  const thread = {
    id: "xuanniao-thread",
    sessionKey: "xuanniao-thread:root",
    agentSession: {
      adapter: "codex-app-server",
      sessionId: "missing-thread",
      turnId: "stored-turn",
      documentHash: "stored-hash"
    },
    parentAgentSession: null,
    selectedText: "Details.",
    anchor: {},
    messages: [{ role: "user", content: "Old Xuanniao history" }]
  };

  const updates = [];
  const answer = await runtime.runTurn({ question: "Retry in a new thread", document, thread, onUpdate: (update) => {
    if (update.type !== "contextRecovery") return;
    assert.equal(runtime.calls.some((call) => call.method === "turn/start"), false);
    updates.push(update);
  } });
  assert.equal(answer.contextRecovery, "rebuilt");
  assert.equal(updates[0].type, "contextRecovery");
  assert.deepEqual(runtime.calls.slice(0, 2).map(({ method }) => method), ["thread/resume", "thread/start"]);
  const prompt = runtime.calls.find(({ method }) => method === "turn/start").params.input[0].text;
  assert.match(prompt, /<XUANNIAO_BRANCH_HISTORY>/);
  assert.match(prompt, /Old Xuanniao history/);
});

test("native fork failure starts a new thread and rebuilds history", async () => {
  const runtime = new StubRuntime();
  runtime.failMethods.add("thread/fork");
  const thread = {
    id: "xuanniao-thread",
    sessionKey: "xuanniao-thread:child",
    agentSession: null,
    parentAgentSession: {
      adapter: "codex-app-server",
      sessionId: "missing-parent",
      turnId: "parent-turn",
      documentHash: "parent-hash"
    },
    selectedText: "Details.",
    anchor: {},
    messages: [{ role: "assistant", content: "Old parent answer" }]
  };

  await runtime.runTurn({ question: "Start this branch", document, thread });
  assert.deepEqual(runtime.calls.slice(0, 2).map(({ method }) => method), ["thread/fork", "thread/start"]);
  const prompt = runtime.calls.find(({ method }) => method === "turn/start").params.input[0].text;
  assert.match(prompt, /<XUANNIAO_BRANCH_HISTORY>/);
  assert.match(prompt, /Old parent answer/);
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

test("native runtime maps every permission mode to Codex thread settings", async () => {
  const cases = [
    ["request-approval", "on-request", "user", "workspace-write"],
    ["auto-review", "on-request", "auto_review", "workspace-write"],
    ["full-access", "never", "user", "danger-full-access"],
    ["custom", null, null, null]
  ];

  for (const [permissionMode, approvalPolicy, approvalsReviewer, sandbox] of cases) {
    const runtime = new StubRuntime();
    runtime.configure({ permissionMode });
    await runtime.createThread({ id: `thread-${permissionMode}` });
    const params = runtime.calls.find(({ method }) => method === "thread/start").params;
    assert.equal(params.approvalPolicy, approvalPolicy);
    assert.equal(params.approvalsReviewer, approvalsReviewer);
    assert.equal(params.sandbox, sandbox);
  }
});

test("changing permission mode starts a fresh semantic session on the next turn", async () => {
  const runtime = new StubRuntime();
  const thread = {
    id: "permission-thread",
    sessionKey: "permission-thread:root",
    agentSession: null,
    parentAgentSession: null,
    selectedText: "Details.",
    anchor: {},
    messages: []
  };
  const first = await runtime.runTurn({ question: "First", document, thread });

  runtime.calls = [];
  runtime.configure({ permissionMode: "auto-review" });
  const second = await runtime.runTurn({
    question: "Second",
    document,
    thread: { ...thread, agentSession: first.session }
  });

  assert.notEqual(second.session.sessionId, first.session.sessionId);
  const threadStart = runtime.calls.find(({ method }) => method === "thread/start");
  assert.equal(threadStart.params.approvalsReviewer, "auto_review");
  assert.equal(threadStart.params.sandbox, "workspace-write");
});

test("unified diff summaries count aggregate files and changed lines", () => {
  assert.deepEqual(summarizeUnifiedDiff([
    "diff --git a/src/one.js b/src/one.js",
    "--- a/src/one.js",
    "+++ b/src/one.js",
    "@@ -1 +1,2 @@",
    "-old",
    "+new",
    "+more",
    "diff --git a/src/two.js b/src/two.js",
    "similarity index 100%",
    "rename from src/two.js",
    "rename to src/renamed.js"
  ].join("\n")), {
    filesChanged: 2,
    additions: 2,
    deletions: 1
  });

  assert.deepEqual(summarizeUnifiedDiff([
    "diff --git a/image.png b/image.png",
    "Binary files a/image.png and b/image.png differ"
  ].join("\n")), {
    filesChanged: 1,
    additions: 0,
    deletions: 0
  });

  assert.deepEqual(summarizeUnifiedDiff([
    "diff --git a/src/operators.txt b/src/operators.txt",
    "--- a/src/operators.txt",
    "+++ b/src/operators.txt",
    "@@ -1 +1 @@",
    "--- removed-content",
    "+++ added-content"
  ].join("\n")), {
    filesChanged: 1,
    additions: 1,
    deletions: 1
  });
});

test("late child threads are not adopted by the next root turn", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: "/tmp/plan.md", cwd: "/tmp", timeoutMs: 1_000 });
  runtime.loadedThreads.add("thread-root");
  runtime.threadOwners.set("thread-root", "xuanniao-thread");

  const first = runtime.waitForTurn("thread-root", "turn-1");
  runtime.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-root", turn: { id: "turn-1", status: "completed" } }
  });
  await first;

  runtime.handleNotification({
    method: "thread/started",
    params: {
      thread: {
        id: "late-child",
        parentThreadId: "thread-root",
        preview: "stale task",
        status: { type: "active", activeFlags: [] }
      }
    }
  });

  const liveUpdates = [];
  const second = runtime.waitForTurn("thread-root", "turn-2", {
    onUpdate: (update) => liveUpdates.push(update)
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-root", turn: { id: "turn-2", status: "completed" } }
  });
  const result = await second;

  assert.equal(runtime.pendingSubagentThreads.size, 0);
  assert.equal(result.updates.some((update) => update.agentThreadId === "late-child"), false);
  assert.equal(liveUpdates.some((update) => update.agentThreadId === "late-child"), false);
});

test("child threads arriving while a root turn starts are replayed into that turn", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: "/tmp/plan.md", cwd: "/tmp", timeoutMs: 1_000 });
  runtime.loadedThreads.add("thread-root");
  runtime.threadOwners.set("thread-root", "xuanniao-thread");
  runtime.prepareRootTurnStart("thread-root");
  runtime.handleNotification({
    method: "thread/started",
    params: {
      thread: {
        id: "early-child",
        parentThreadId: "thread-root",
        preview: "current task",
        status: { type: "active", activeFlags: [] }
      }
    }
  });

  const completed = runtime.waitForTurn("thread-root", "turn-current");
  runtime.startingRootThreads.delete("thread-root");
  runtime.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-root", turn: { id: "turn-current", status: "completed" } }
  });
  const result = await completed;

  assert.equal(result.updates.some((update) => update.agentThreadId === "early-child"), true);
});

test("native event stream normalizes plans, diffs, nested subagents, and child approvals", async () => {
  const runtime = new CodexAppServerRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    timeoutMs: 1_000
  });
  const liveUpdates = [];
  runtime.threadOwners.set("thread-1", "xuanniao-thread");
  const completed = runtime.waitForTurn("thread-1", "turn-1", {
    onUpdate: (update) => liveUpdates.push(update)
  });

  runtime.handleNotification({
    method: "turn/plan/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" }
      ]
    }
  });
  runtime.handleNotification({
    method: "turn/diff/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      diff: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new"
    }
  });

  runtime.handleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "spawn-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["agent-1"],
        prompt: "Inspect the implementation",
        model: "gpt-worker",
        reasoningEffort: "medium",
        agentsStates: { "agent-1": { status: "running", message: null } }
      }
    }
  });
  runtime.handleNotification({
    method: "thread/started",
    params: {
      thread: {
        id: "agent-1",
        parentThreadId: "thread-1",
        agentNickname: "explorer",
        agentRole: "explorer",
        preview: "Inspect the implementation",
        status: { type: "active", activeFlags: [] }
      }
    }
  });

  runtime.handleNotification({
    method: "item/completed",
    params: {
      threadId: "agent-2",
      turnId: "agent-turn-2",
      item: {
        id: "child-command",
        type: "commandExecution",
        status: "completed",
        command: "npm test",
        aggregatedOutput: "passed",
        exitCode: 0
      }
    }
  });
  runtime.handleNotification({
    method: "thread/started",
    params: {
      thread: {
        id: "agent-2",
        parentThreadId: "agent-1",
        agentNickname: "tester",
        agentRole: "worker",
        preview: "Run tests",
        status: { type: "active", activeFlags: [] }
      }
    }
  });

  const writes = [];
  runtime.process = {
    killed: false,
    stdin: { writable: true, write: (line) => writes.push(JSON.parse(line)) }
  };
  runtime.handleServerRequest({
    id: 73,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "agent-1",
      turnId: "agent-turn-1",
      itemId: "approval-command",
      command: "npm test"
    }
  });
  const [approval] = runtime.listPermissionRequests();
  assert.equal(approval.threadId, "xuanniao-thread");
  assert.equal(approval.sourceThreadId, "agent-1");
  assert.equal(approval.sourceAgentName, "explorer");
  runtime.resolvePermissionRequest(approval.id, { optionId: "accept" });
  assert.deepEqual(writes.at(-1), { id: 73, result: { decision: "accept" } });

  runtime.handleNotification({
    method: "item/completed",
    params: {
      threadId: "agent-1",
      turnId: "agent-turn-1",
      item: {
        id: "agent-answer",
        type: "agentMessage",
        status: "completed",
        text: "Inspection complete"
      }
    }
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "agent-1",
      turn: { id: "agent-turn-1", status: "completed" }
    }
  });
  runtime.handleNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: "Done." }
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });

  const result = await completed;
  assert.equal(result.content, "Done.");
  assert.deepEqual(result.updates.find((update) => update.type === "diff"), {
    type: "diff",
    status: "inProgress",
    itemId: "turn-diff",
    filesChanged: 1,
    additions: 1,
    deletions: 1
  });
  assert.equal(result.updates.find((update) => update.type === "plan")?.status, "inProgress");
  assert.equal(result.updates.find((update) => update.agentThreadId === "agent-1" && update.type === "subagent")?.result, "Inspection complete");
  assert.match(result.updates.find((update) => update.agentThreadId === "agent-1" && update.type === "subagent")?.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.updates.find((update) => update.agentThreadId === "agent-2" && update.type === "commandExecution")?.output, "passed");
  assert.ok(liveUpdates.some((update) => update.agentThreadId === "agent-2" && update.type === "commandExecution"));
});

test("subagent approvals arriving before thread ownership are adopted by the root run", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: "/tmp/plan.md", cwd: "/tmp", timeoutMs: 1_000 });
  runtime.threadOwners.set("thread-root", "xuanniao-thread");
  const writes = [];
  runtime.process = {
    killed: false,
    stdin: { writable: true, write: (line) => writes.push(JSON.parse(line)) }
  };
  const completed = runtime.waitForTurn("thread-root", "turn-root");

  runtime.handleServerRequest({
    id: 81,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "agent-early",
      turnId: "turn-agent-early",
      itemId: "approval-early",
      command: "npm test"
    }
  });
  assert.equal(runtime.listPermissionRequests()[0].threadId, "agent-early");

  runtime.handleNotification({
    method: "thread/started",
    params: {
      thread: {
        id: "agent-early",
        parentThreadId: "thread-root",
        agentNickname: "early-worker",
        status: { type: "active", activeFlags: [] }
      }
    }
  });

  const [approval] = runtime.listPermissionRequests();
  assert.equal(approval.threadId, "xuanniao-thread");
  assert.equal(approval.sourceThreadId, "agent-early");
  assert.equal(approval.sourceAgentName, "early-worker");
  assert.equal(runtime.turns.get("turn-root").timer, null);
  runtime.resolvePermissionRequest(approval.id, { optionId: "accept" });
  assert.ok(runtime.turns.get("turn-root").timer);
  assert.deepEqual(writes.at(-1), { id: 81, result: { decision: "accept" } });

  runtime.handleNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-root", turnId: "turn-root", itemId: "answer", delta: "Done" }
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-root", turn: { id: "turn-root", status: "completed" } }
  });
  await completed;
});

test("legacy collaboration items normalize to subagent lifecycle updates", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: "/tmp/plan.md", cwd: "/tmp" });
  const completed = runtime.waitForTurn("thread-legacy", "turn-legacy");
  runtime.handleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-legacy",
      turnId: "turn-legacy",
      item: {
        id: "legacy-spawn",
        type: "collabToolCall",
        tool: "spawn_agent",
        status: "completed",
        senderThreadId: "thread-legacy",
        receiverThreadId: "legacy-agent",
        prompt: "Legacy task",
        agentStatus: "running"
      }
    }
  });
  runtime.handleNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-legacy", turnId: "turn-legacy", itemId: "answer", delta: "Done" }
  });
  runtime.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-legacy", turn: { id: "turn-legacy", status: "completed" } }
  });

  const result = await completed;
  const subagent = result.updates.find((update) => update.agentThreadId === "legacy-agent");
  assert.equal(subagent.type, "subagent");
  assert.equal(subagent.task, "Legacy task");
  assert.equal(subagent.agentStatus, "interrupted");
  assert.equal(subagent.status, "failed");
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
