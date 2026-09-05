import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityGate } from "./activity-gate.js";
import { AgentRunBroker } from "./agent-run-broker.js";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";
import { DocumentCreationService } from "./document-creation-service.js";
import { DocumentWorkspace } from "./document-workspace.js";
import { OutcomeStore } from "./outcome-store.js";
import { ThreadStore } from "./thread-store.js";
import { WorkspaceOutcomes } from "./workspace-outcomes.js";

test("document creation journals its original request before a snapshot-stage stop", async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const resume = deferred();
  const snapshot = f.document.createAgentSnapshot.bind(f.document);
  f.document.createAgentSnapshot = async () => { entered.resolve(); await resume.promise; return snapshot(); };
  const request = { instruction: "  Create an implementation plan\nwith risks  ", directory: "notes", fileName: "plan" };
  const creating = f.create(request, "snapshot-stop-run");
  const interrupted = assert.rejects(creating, { code: "AGENT_INTERRUPTED" });
  await entered.promise;
  const persisted = JSON.parse(await readFile(f.store.filePath, "utf8")).records[0];
  assert.deepEqual(persisted.creationRequest, request);
  assert.equal(persisted.origin, "document-creation");
  assert.equal(persisted.status, "running");
  assert.equal(f.agent.calls.length, 0);
  const stopping = f.outcomes.stop({ operationId: f.gate.active.id });
  await new Promise((resolve) => setImmediate(resolve));
  resume.resolve();
  await interrupted;
  await stopping;
  assert.equal(f.agent.calls.length, 0, "no native session or turn was submitted after stop");
  assert.equal((await f.store.get(persisted.id)).status, "interrupted");
  assert.equal((await f.outcomes.snapshot()).activity, null);
  await assert.rejects(readFile(path.join(f.root, "notes", "plan.md")), { code: "ENOENT" });
});

test("natural creation runtime loss keeps the request and requires acknowledgement before retry", async (t) => {
  const f = await fixture(t);
  const request = { instruction: "Create the original plan", directory: null, fileName: "created.md" };
  const creating = f.create(request, "creation-native-loss");
  const failed = assert.rejects(creating, { code: "AGENT_RUNTIME_LOST" });
  await until(() => f.agent.turns.size === 1);
  f.agent.handleNotification({ method: "item/agentMessage/delta", params: { threadId: "native-1", turnId: "turn-1", delta: "partial original plan" } });
  f.agent.handleProcessExit(new Error("native connection disappeared"));
  await failed;
  const record = (await f.store.list())[0];
  assert.equal(record.status, "unknown");
  assert.deepEqual(record.creationRequest, request);
  assert.match(record.result, /partial original plan/);
  assert.equal(f.broker.snapshot("creation-native-loss").status, "unknown");
  assert.equal((await f.outcomes.snapshot()).activity.recoveryRequired, true);
  await assert.rejects(f.create(request, "retry-before-ack", record.id), { code: "WORKSPACE_BUSY" });
  await f.outcomes.acknowledge(record.id, { confirmed: true });
  const retry = f.create(request, "retry-after-ack", record.id);
  await until(() => f.agent.turns.size === 1);
  const active = f.agent.status().runs[0];
  f.agent.handleNotification({ method: "item/completed", params: { threadId: active.sessionId, turnId: active.turnId, item: {
    type: "agentMessage", text: "<XUANNIAO_DOCUMENT_PATH>created.md</XUANNIAO_DOCUMENT_PATH>\n<XUANNIAO_DOCUMENT_CONTENT>\n# Created\n</XUANNIAO_DOCUMENT_CONTENT>"
  } } });
  f.agent.handleNotification({ method: "turn/completed", params: { threadId: active.sessionId, turn: { id: active.turnId, status: "completed" } } });
  const result = await retry;
  assert.equal(await readFile(result.path, "utf8"), "# Created\n");
  const records = await f.store.list();
  assert.equal(records.length, 2);
  assert.equal(records.find((item) => item.id === record.id).status, "unknown");
  assert.equal(records.find((item) => item.retryOf === record.id).status, "completed");
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xuanniao-newdoc-lifecycle-"));
  const filePath = path.join(root, "source.md");
  await writeFile(filePath, "# Source\n");
  const document = new DocumentWorkspace(filePath, new ThreadStore(path.join(root, "threads.json")));
  const store = new OutcomeStore(filePath, { metadataRoot: path.join(root, "metadata") });
  const agent = new CodexAppServerRuntime({ documentPath: filePath, cwd: root, timeoutMs: 1000, interruptGraceMs: 20 });
  agent.ensureInitialized = async () => {};
  agent.modelCatalog = [];
  agent.calls = [];
  let thread = 0;
  let turn = 0;
  agent.request = async (method, params) => {
    agent.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "native-" + ++thread } };
    if (method === "turn/start") return { turn: { id: "turn-" + ++turn } };
    if (method === "model/list") return { data: [] };
    throw new Error("Unexpected RPC: " + method);
  };
  const broker = new AgentRunBroker();
  const gate = new ActivityGate();
  const outcomes = new WorkspaceOutcomes({ document, store, agent, gate, cwd: root, settings: () => ({ permissionMode: "request-approval" }) });
  const service = new DocumentCreationService({ workspaceRoot: root, document, agent, agentRuns: broker });
  const create = (creationRequest, requestKey, retryOf) => outcomes.runExternal({
    origin: "document-creation", requestKey, instruction: creationRequest.instruction, creationRequest, retryOf
  }, ({ onUpdate, isStopping }) => service.create({ ...creationRequest, agentRunId: requestKey }, { onUpdate, isStopping }));
  t.after(async () => { agent.dispose(); broker.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, document, store, agent, broker, gate, outcomes, create };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected native lifecycle transition");
}
