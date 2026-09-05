import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityGate } from "./activity-gate.js";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";
import { ConversationService } from "./conversation-service.js";
import { referenceRevision } from "./discussion-context.js";
import { DocumentWorkspace } from "./document-workspace.js";
import { OutcomeStore } from "./outcome-store.js";
import { ThreadStore } from "./thread-store.js";
import { WorkspaceOutcomes } from "./workspace-outcomes.js";

for (const retryVia of ["snapshot", "stop"]) {
  test(`ordinary stop journal EIO can recover via ${retryVia} after the native turn has already ended`, async (t) => {
    const f = await fixture(t);
    const { running, requestKey } = await f.start();
    const create = f.store.create.bind(f.store);
    const attempts = [];
    let fail = true;
    f.store.create = async (fields) => {
      attempts.push(structuredClone(fields));
      if (fail) throw eio();
      return create(fields);
    };
    const operationId = f.gate.active.id;
    await assert.rejects(f.outcomes.stop({ operationId }), { code: "EIO" });
    assert.equal(f.agent.turns.size, 1, "stop timeout must leave the native promise pending");
    f.finish("interrupted");
    await running;
    assert.equal(f.agent.isBusy(), false);
    assert.throws(() => f.gate.assertIdle(), { code: "WORKSPACE_BUSY" });
    fail = false;
    const snapshot = retryVia === "stop" ? await f.outcomes.stop({ operationId }) : await f.outcomes.snapshot();
    assert.equal(snapshot.records.length, 1);
    const record = snapshot.records[0];
    assert.equal(record.status, "unknown");
    assert.equal(record.requestKey, requestKey);
    assert.equal(record.source.content, "Original ordinary request");
    assert.deepEqual(attempts.at(-1), attempts[0], "retry must use the frozen request and source snapshot");
    await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
    assert.equal((await f.outcomes.snapshot()).activity, null);
    assert.equal((await f.store.get(record.id)).recoveryAcknowledged, true);
  });
}

test("ordinary pending stop journals the saved question and can acknowledge when Markdown was deleted", async (t) => {
  const f = await fixture(t);
  const { running, requestKey } = await f.start();
  await rm(f.file);
  const snapshot = await f.outcomes.stop({ operationId: f.gate.active.id });
  assert.equal(f.agent.turns.size, 1);
  assert.equal(snapshot.records.length, 1);
  const record = snapshot.records[0];
  assert.equal(record.status, "unknown");
  assert.equal(record.origin, "discussion");
  assert.equal(record.requestKey, requestKey);
  assert.equal(record.source.kind, "message");
  assert.equal(record.source.content, "Original ordinary request");
  assert.equal(record.source.sourceIdentity, f.document.referenceIdentity);
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  await running;
  assert.equal((await f.outcomes.snapshot()).activity, null);
  assert.equal((await f.store.list()).length, 1, "reset failure callback must not create a second recovery");
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("natural ordinary loss freezes a retryable journal before create EIO and respects its later deletion tombstone", async (t) => {
  const f = await fixture(t);
  const { running, requestKey } = await f.start();
  const create = f.store.create.bind(f.store);
  let frozen;
  f.store.create = async (fields) => { frozen = structuredClone(fields); throw eio(); };
  f.partial("Partial original output");
  f.agent.handleProcessExit(new Error("native connection lost"));
  const completed = await running;
  assert.equal(completed.error.code, "EIO");
  assert.throws(() => f.gate.assertIdle(), { code: "WORKSPACE_BUSY" });
  const identity = f.document.referenceIdentity;
  f.document.referenceIdentity = randomUUID();
  await rm(f.file);
  f.store.create = create;
  const snapshots = await Promise.all([f.outcomes.snapshot(), f.outcomes.snapshot()]);
  const record = snapshots[0].records[0];
  assert.equal(snapshots[1].records[0].id, record.id);
  assert.equal(record.requestKey, requestKey);
  assert.equal(record.source.content, frozen.source.content);
  assert.equal(record.source.sourceIdentity, identity);
  assert.match(record.result, /Partial original output/);
  assert.equal((await f.store.list()).length, 1);
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  await f.outcomes.change(record.id, "delete");
  const failure = f.failures[0];
  await f.outcomes.recordUnownedFailure(failure.error, failure);
  assert.deepEqual((await f.outcomes.snapshot()).records, []);
  assert.equal(f.gate.active, null);
  assert.equal(JSON.parse(await readFile(f.store.filePath, "utf8")).tombstones[0].requestKey, requestKey);
});

test("owned execution loss uses its existing recovery journal even when the shared natural-loss callback runs", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("execution", {
    source: f.source, references: [], documentRevision: (await f.document.payload()).revision,
    instruction: "Run from the answer", requestKey: randomUUID()
  });
  const pending = f.outcomes.pending;
  await until(() => f.agent.turns.size === 1);
  const update = f.store.update.bind(f.store);
  f.store.update = async () => { throw eio(); };
  f.partial("Owned partial output");
  f.agent.handleProcessExit(new Error("native lost during execution"));
  await pending;
  f.store.update = update;
  const snapshot = await f.outcomes.snapshot();
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, record.id);
  assert.equal(snapshot.records[0].status, "unknown");
  assert.match(snapshot.records[0].result, /Owned partial output/);
  assert.equal(f.failures.length, 1);
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  assert.equal((await f.outcomes.snapshot()).activity, null);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xuanniao-ordinary-recovery-"));
  const file = path.join(root, "source.md");
  await writeFile(file, "# Source\n");
  const threads = new ThreadStore(path.join(root, "threads.json"));
  const thread = await threads.create({ title: "Source", selectedText: "Source", anchor: { start: 2, end: 8, lineStart: 1, lineEnd: 1 } });
  const question = await threads.addMessage(thread.id, { role: "user", content: "Original root question" });
  const answer = await threads.completeAgentTurn(thread.id, question.id, { role: "assistant", content: "Stable source answer" }, null);
  const document = new DocumentWorkspace(file, threads);
  document.referenceIdentity = randomUUID();
  const store = new OutcomeStore(file, { metadataRoot: path.join(root, "metadata") });
  const gate = new ActivityGate();
  const agent = new CodexAppServerRuntime({ documentPath: file, cwd: root, timeoutMs: 1000, interruptGraceMs: 20 });
  agent.ensureInitialized = async () => {};
  agent.modelCatalog = [];
  let session = 0, turn = 0;
  agent.request = async (method) => {
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") return { thread: { id: `native-${++session}` } };
    if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
    if (method === "turn/interrupt") return {};
    throw new Error("Unexpected RPC: " + method);
  };
  const failures = [], calls = [];
  const conversation = new ConversationService({ threadStore: threads, document, agent, gate });
  const outcomes = new WorkspaceOutcomes({ document, store, agent, gate, conversation, cwd: root, settings: () => ({ permissionMode: "request-approval" }) });
  conversation.beforeRun = () => outcomes.assertRecovered();
  conversation.onRunFailure = async (failure) => {
    if (!["AGENT_RUNTIME_LOST", "AGENT_STOP_TIMEOUT"].includes(failure.error?.code)) return;
    failures.push(failure);
    await outcomes.recordUnownedFailure(failure.error, failure);
  };
  t.after(async () => {
    await agent.resetRecovery({ confirmed: true });
    await Promise.all(calls);
    await outcomes.pending;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, file, threads, document, store, gate, agent, conversation, outcomes, failures,
    source: { kind: "message", documentPath: file, sourceIdentity: document.referenceIdentity, threadId: thread.id,
      messageId: answer.id, start: 0, end: answer.content.length, revision: referenceRevision(answer.content) },
    start: async () => {
      const requestKey = randomUUID();
      const running = conversation.addQuestion(thread.id, { content: "Original ordinary request", askAgent: true, agentRunId: requestKey })
        .then((result) => ({ result }), (error) => ({ error }));
      calls.push(running);
      await until(() => agent.turns.size === 1);
      return { running, requestKey };
    },
    finish: (status) => {
      const run = agent.status().runs[0];
      agent.handleNotification({ method: "turn/completed", params: { threadId: run.sessionId, turn: { id: run.turnId, status } } });
    },
    partial: (delta) => {
      const run = agent.status().runs[0];
      agent.handleNotification({ method: "item/agentMessage/delta", params: { threadId: run.sessionId, turnId: run.turnId, delta } });
    }
  };
}

function eio() { return Object.assign(new Error("recovery journal EIO"), { code: "EIO" }); }
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected native lifecycle transition");
}
