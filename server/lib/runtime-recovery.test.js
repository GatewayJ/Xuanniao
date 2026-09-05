import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";
import { assertAgentRuntime } from "./agent-runtime.js";

function processStub() {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 12345, exitCode: null, signalCode: null, killed: false, signals: [],
    kill(signal = "SIGTERM") { this.killed = true; this.signals.push(signal); return true; },
    close() { this.exitCode = 0; this.emit("close", 0); }
  });
  return child;
}

const input = { question: "Continue", document: { path: "/tmp/current.md", content: "Current" }, thread: { id: "discussion", messages: [] } };

async function tick() { await new Promise((resolve) => setImmediate(resolve)); }

test("runtime composition requires the recovery reset interface", () => {
  const runtime = new CodexAppServerRuntime({ documentPath: input.document.path, cwd: "/tmp" });
  const adapter = Object.create(runtime);
  adapter.resetRecovery = undefined;
  assert.throws(() => assertAgentRuntime(adapter), /missing required method: resetRecovery/);
});

test("recovery requires confirmation and waits for process close before unlocking", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: input.document.path, cwd: "/tmp", interruptGraceMs: 100 });
  const child = processStub();
  runtime.process = child;
  await assert.rejects(runtime.resetRecovery(), { code: "AGENT_RECOVERY_CONFIRMATION_REQUIRED" });
  assert.equal(child.killed, false);
  let finished = false;
  const reset = runtime.resetRecovery({ confirmed: true }).then((result) => { finished = true; return result; });
  await tick();
  assert.equal(child.killed, true);
  assert.equal(finished, false);
  assert.equal(runtime.isBusy(), true);
  await assert.rejects(runtime.runTurn(input), { code: "AGENT_RUNTIME_RESETTING" });
  child.close();
  const result = await reset;
  assert.equal(result.previousProcess.pid, child.pid);
  assert.equal(runtime.isBusy(), false);
});

test("failed recovery retains the old process for a retry and keeps new work blocked", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: input.document.path, cwd: "/tmp", interruptGraceMs: 5 });
  const child = processStub();
  runtime.process = child;
  await assert.rejects(runtime.resetRecovery({ confirmed: true }), { code: "AGENT_RUNTIME_RESET_TIMEOUT" });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(runtime.isBusy(), true);
  await assert.rejects(runtime.runTurn(input), { code: "AGENT_RUNTIME_LOST" });
  child.close();
  assert.equal((await runtime.resetRecovery({ confirmed: true })).reset, true);
  assert.equal(runtime.isBusy(), false);
});

test("recovery still waits for an old child when dispose was called first", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: input.document.path, cwd: "/tmp", interruptGraceMs: 100 });
  const child = processStub();
  runtime.process = child;
  runtime.dispose();
  assert.equal(runtime.process, null);
  let settled = false;
  const reset = runtime.resetRecovery({ confirmed: true }).then((result) => { settled = true; return result; });
  await tick();
  assert.equal(settled, false);
  child.close();
  assert.equal((await reset).previousProcess.pid, child.pid);
  assert.equal(runtime.isBusy(), false);
});

test("acknowledged lost runs are cleared and a subsequent run initializes and completes normally", async () => {
  const runtime = new CodexAppServerRuntime({ documentPath: input.document.path, cwd: "/tmp", timeoutMs: 1000 });
  let initializations = 0;
  let nextTurn = 0;
  runtime.ensureInitialized = async () => {
    if (!runtime.initialized) initializations += 1;
    runtime.initialized = true;
  };
  runtime.modelCatalog = [];
  runtime.request = async (method) => {
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") return { thread: { id: "native-thread" } };
    if (method === "turn/start") return { turn: { id: "turn-" + (++nextTurn) } };
    throw new Error(method);
  };
  const first = runtime.runTurn(input);
  while (runtime.turns.size === 0) await tick();
  runtime.handleProcessExit(new Error("connection lost"));
  await assert.rejects(first, { code: "AGENT_RUNTIME_LOST" });
  assert.equal(runtime.isBusy(), true);
  runtime.dispose();
  assert.equal(runtime.isBusy(), true, "dispose alone must not acknowledge an unknown run");
  await runtime.resetRecovery({ confirmed: true });
  const second = runtime.runTurn(input);
  while (runtime.turns.size === 0) await tick();
  runtime.handleNotification({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  assert.equal((await second).status, "completed");
  assert.equal(initializations, 2);
  assert.equal(runtime.isBusy(), false);
  runtime.dispose();
});
