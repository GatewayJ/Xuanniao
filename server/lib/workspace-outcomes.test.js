import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityGate } from "./activity-gate.js";
import { OutcomeStore } from "./outcome-store.js";
import { ProposalService } from "./proposal-service.js";
import { WorkspaceOutcomes } from "./workspace-outcomes.js";
import { DocumentWorkspace, documentRevision } from "./document-workspace.js";
import { ThreadStore } from "./thread-store.js";
import { ConversationService } from "./conversation-service.js";
import { referenceRevision } from "./discussion-context.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(check) {
  for (let index = 0; index < 300; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Expected workflow transition did not occur");
}

function controlledAgent() {
  return {
    busy: false, unknown: false, calls: [], stopCalls: 0, resets: 0,
    isBusy() { return this.busy; },
    status() { return { runs: this.busy ? [{ threadId: this.args?.thread.id, process: { pid: 456 }, status: this.unknown ? "unknown" : "running" }] : [] }; },
    runTurn(args) {
      this.args = args;
      this.calls.push(args);
      this.busy = true;
      this.next = deferred();
      args.onUpdate?.({ type: "run", status: "running", terminal: false, runId: args.runId || "native-run", threadId: args.thread.id, process: { pid: 456, servicePid: process.pid } });
      return this.next.promise.finally(() => { this.busy = this.unknown; });
    },
    complete(content = "<XUANNIAO_PROPOSAL>\nUpdated\n</XUANNIAO_PROPOSAL>") {
      this.args.onUpdate?.({ type: "run", status: "completed", terminal: true, process: { pid: 456 } });
      this.next.resolve({ content, stopReason: "completed", updates: [], session: null });
    },
    fail(code, content = "Partial output") {
      this.unknown = ["AGENT_RUNTIME_LOST", "AGENT_STOP_TIMEOUT"].includes(code);
      this.args?.onUpdate?.({ type: "run", status: this.unknown ? "unknown" : "interrupted", terminal: !this.unknown, process: { pid: 456 } });
      this.next?.reject(Object.assign(new Error(code), { code, content, result: { status: this.unknown ? "unknown" : "interrupted", terminal: !this.unknown, process: { pid: 456 } } }));
    },
    async stop() { this.stopCalls += 1; this.fail("AGENT_INTERRUPTED"); return { status: this.args ? "interrupted" : "idle", terminal: true }; },
    async resetRecovery() { this.resets += 1; this.fail("AGENT_RUNTIME_LOST"); this.unknown = false; this.busy = false; return { reset: true }; }
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xuanniao-outcomes-"));
  const file = path.join(root, "current.md");
  await writeFile(file, "Original\n");
  const threads = new ThreadStore(path.join(root, "threads", "threads.json"));
  const thread = await threads.create({ title: "Discussion", selectedText: "Original", anchor: { start: 0, end: 8, lineStart: 1, lineEnd: 1 } });
  const question = await threads.addMessage(thread.id, { role: "user", content: "How should this change?" });
  const answer = await threads.completeAgentTurn(thread.id, question.id, { role: "assistant", content: "Use the updated design" }, null);
  const document = new DocumentWorkspace(file, threads);
  const store = new OutcomeStore(file, { metadataRoot: path.join(root, "outcomes") });
  const gate = new ActivityGate();
  const agent = controlledAgent();
  const conversation = new ConversationService({ threadStore: threads, document, agent, gate });
  const outcomes = new WorkspaceOutcomes({ document, store, gate, agent, conversation, cwd: root, settings: () => ({ permissionMode: "request-approval" }) });
  conversation.beforeRun = () => outcomes.assertRecovered();
  const source = { kind: "message", documentPath: file, threadId: thread.id, messageId: answer.id, start: 0, end: answer.content.length, revision: referenceRevision(answer.content) };
  const command = { source, references: [], documentRevision: (await document.payload()).revision, instruction: "Update the document", requestKey: randomUUID(), target: { mode: "document", start: 0, end: 9 } };
  t.after(async () => {
    if (agent.busy) { agent.fail("AGENT_INTERRUPTED"); agent.unknown = false; agent.busy = false; }
    await outcomes.pending;
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, document, store, gate, agent, conversation, outcomes, source, command, threads, thread };
}

async function reviewed(f, replacement = "Updated\n") {
  const record = await f.outcomes.start("proposal", { ...f.command, requestKey: randomUUID(), documentRevision: (await f.document.payload()).revision });
  const pending = f.outcomes.pending;
  await until(() => f.agent.calls.length > 0 && f.agent.args.runId === record.attemptId);
  f.agent.complete("<XUANNIAO_PROPOSAL>\n" + replacement + "\n</XUANNIAO_PROPOSAL>");
  await pending;
  return f.store.get(record.id);
}

test("OutcomeStore creates its directory, captures queued inputs, validates identity and serializes concurrent patches", async (t) => {
  const f = await fixture(t);
  const fields = { kind: "execution", status: "completed", requestKey: "request-0001", instruction: "original", events: [] };
  const creating = f.store.create(fields);
  fields.instruction = "mutated later";
  const record = await creating;
  assert.equal(record.instruction, "original");
  assert.equal((await f.store.create({ ...fields, instruction: "original" })).id, record.id);
  await assert.rejects(f.store.create(fields), { code: "OUTCOME_CONFLICT" });
  const second = new OutcomeStore(f.file, { metadataRoot: path.join(f.root, "outcomes") });
  const patch = { events: [{ details: { text: "captured" } }] };
  const writing = f.store.update(record.id, patch);
  patch.events[0].details.text = "changed";
  await Promise.all([writing, second.update(record.id, { verification: "passed" })]);
  const saved = await second.get(record.id);
  assert.equal(saved.events[0].details.text, "captured");
  assert.equal(saved.verification, "passed");
  await assert.rejects(second.update(record.id, { title: "stale" }, record.revision), { code: "OUTCOME_CONFLICT" });
  await assert.rejects(second.update(record.id, { requestKey: "another-key" }), { code: "OUTCOME_CONFLICT" });
  assert.throws(() => second.create({ kind: "execution", requestKey: "bad" }), { code: "OUTCOME_CONFLICT" });
  const raw = JSON.parse(await readFile(f.store.filePath, "utf8"));
  raw.documentPath = f.file + ".other";
  await writeFile(f.store.filePath, JSON.stringify(raw));
  await assert.rejects(second.list(), /document identity/);
});

test("ActivityGate owns normal work, rejects stale owners and keeps recovery protection across release", async () => {
  const gate = new ActivityGate();
  const first = gate.acquire("first");
  assert.match(first.token.id, /^[0-9a-f-]{36}$/);
  assert.equal(await gate.run("nested", () => 42, first.token), 42);
  first.release();
  const second = gate.acquire("second");
  assert.notEqual(second.token.id, first.token.id);
  first.release();
  assert.equal(gate.active, second.token);
  await assert.rejects(gate.run("stale", () => {}, first.token), { code: "WORKSPACE_BUSY" });
  gate.retain(second.token);
  second.release();
  assert.throws(() => gate.assertIdle(), { code: "WORKSPACE_BUSY" });
  await gate.recover(async () => {});
  assert.equal(gate.active, null);
});

test("proposal launch is journaled before native work, duplicate requests launch once, and event snapshots retain enqueue-time values", async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  const mutate = f.store.mutate.bind(f.store);
  f.store.mutate = (operation) => mutate(async (records, tombstones) => {
    const result = await operation(records, tombstones);
    snapshots.push(structuredClone(records));
    return result;
  });
  const run = f.agent.runTurn.bind(f.agent);
  f.agent.runTurn = async (args) => {
    const disk = JSON.parse(await readFile(f.store.filePath, "utf8"));
    assert.equal(disk.records[0].attemptId, args.runId);
    assert.equal(disk.records[0].status, "generating");
    return run(args);
  };
  const [record, duplicate] = await Promise.all([f.outcomes.start("proposal", f.command), f.outcomes.start("proposal", f.command)]);
  assert.equal(record.id, duplicate.id);
  const pending = f.outcomes.pending;
  await until(() => f.agent.calls.length === 1);
  const event = { type: "commandExecution", detail: { content: "first" } };
  f.agent.args.onUpdate(event);
  event.detail.content = "second";
  f.agent.args.onUpdate(event);
  f.agent.complete();
  await pending;
  const saved = await f.store.get(record.id);
  assert.equal(saved.status, "review");
  assert.equal(saved.process.pid, 456);
  assert.equal(saved.process.servicePid, process.pid);
  assert.equal(saved.runtime.runId, record.attemptId);
  assert.ok(snapshots.some((records) => records[0].events.filter((item) => item.type === "commandExecution").length === 1));
  assert.deepEqual(saved.events.filter((item) => item.type === "commandExecution").map((item) => item.detail.content), ["first", "second"]);
  assert.equal(await readFile(f.file, "utf8"), "Original\n");
  assert.equal((await f.outcomes.start("proposal", f.command)).id, record.id);
  await assert.rejects(f.outcomes.start("proposal", { ...f.command, instruction: "different" }), { code: "OUTCOME_CONFLICT" });
  assert.equal(f.agent.calls.length, 1);
});

test("failed creation persistence never launches native work or leaves the gate owned", async (t) => {
  const f = await fixture(t);
  f.store.create = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(f.outcomes.start("proposal", f.command), /disk unavailable/);
  assert.equal(f.agent.calls.length, 0);
  assert.equal(f.gate.active, null);
  assert.equal(f.outcomes.pending, null);
});

test("failed final persistence retains the gate and recovers partial output into an acknowledgeable record", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("proposal", f.command);
  const pending = f.outcomes.pending;
  await until(() => f.agent.calls.length === 1);
  await f.outcomes.current.eventWrites;
  const update = f.store.update.bind(f.store);
  f.store.update = async () => { throw new Error("disk temporarily unavailable"); };
  f.agent.next.reject(Object.assign(new Error("interrupted after partial work"), { code: "AGENT_INTERRUPTED", partialContent: "Saved fragment" }));
  await pending;
  assert.ok(f.gate.active);
  f.store.update = update;
  const snapshot = await f.outcomes.snapshot();
  const recovered = snapshot.records.find((item) => item.id === record.id);
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.result, "Saved fragment");
  assert.equal(recovered.process.servicePid, process.pid);
  assert.equal(snapshot.activity.recoveryRequired, true);
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  assert.equal(f.gate.active, null);
});

test("stop during pending creation waits for its journal and never launches the prepared proposal", async (t) => {
  const f = await fixture(t);
  const creating = deferred();
  const create = f.store.create.bind(f.store);
  let entered = false;
  f.store.create = async (fields) => { entered = true; await creating.promise; return create(fields); };
  const started = f.outcomes.start("proposal", f.command);
  await until(() => entered);
  const operationId = f.gate.active.id;
  let stopped = false;
  const stop = f.outcomes.stop({ operationId }).then((result) => { stopped = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  creating.resolve();
  const record = await started;
  await stop;
  assert.equal((await f.store.get(record.id)).status, "interrupted");
  assert.equal(f.agent.calls.length, 0);
});

test("stopping a proposal that returns text retains partial content and never publishes review", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("proposal", f.command);
  await until(() => f.agent.calls.length === 1);
  f.agent.stop = async () => { f.agent.complete(); return { status: "completed", terminal: true }; };
  await f.outcomes.stop({ operationId: f.gate.active.id });
  const saved = await f.store.get(record.id);
  assert.equal(saved.status, "interrupted");
  assert.match(saved.result, /XUANNIAO_PROPOSAL/);
  assert.equal(await readFile(f.file, "utf8"), "Original\n");
});

test("stop identities replay old results and reject stale requests without stopping a later operation", async (t) => {
  const f = await fixture(t);
  await f.outcomes.start("proposal", f.command);
  await until(() => f.agent.calls.length === 1);
  const oldId = (await f.outcomes.snapshot()).activity.id;
  const stopped = await f.outcomes.stop({ operationId: oldId });
  await f.outcomes.start("proposal", { ...f.command, requestKey: randomUUID() });
  await until(() => f.agent.calls.length === 2);
  assert.notEqual((await f.outcomes.snapshot()).activity.id, oldId);
  assert.deepEqual(await f.outcomes.stop({ operationId: oldId }), stopped);
  assert.equal(f.agent.stopCalls, 1);
  await assert.rejects(f.outcomes.stop({ operationId: randomUUID() }), { code: "OUTCOME_STOP_STALE", statusCode: 409 });
  assert.equal(f.agent.stopCalls, 1);
  f.agent.complete();
  await f.outcomes.pending;
});

test("real conversation execution records message linkage, actual status, partial results and reconciled files", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("execution", f.command);
  const pending = f.outcomes.pending;
  await until(() => f.agent.calls.length === 1);
  assert.ok((await f.store.get(record.id)).messageId);
  await writeFile(f.file, "Execution changed this file\n");
  f.agent.fail("AGENT_INTERRUPTED", "One check completed");
  await pending;
  const saved = await f.store.get(record.id);
  assert.equal(saved.status, "interrupted");
  assert.match(saved.result, /One check completed/);
  assert.equal(saved.afterContent, "Execution changed this file\n");
  assert.equal((await f.outcomes.snapshot()).activity, null);
});

test("lost execution is unknown after conversation reconciliation and ack resets runtime before unlocking", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("execution", f.command);
  const pending = f.outcomes.pending;
  await until(() => f.agent.calls.length === 1);
  f.agent.fail("AGENT_RUNTIME_LOST", "Saved partial work");
  await pending;
  assert.equal((await f.store.get(record.id)).status, "unknown");
  assert.match((await f.store.get(record.id)).result, /Saved partial work/);
  assert.equal((await f.outcomes.snapshot()).activity.recoveryRequired, true);
  assert.throws(() => f.gate.assertIdle(), { code: "WORKSPACE_BUSY" });
  await assert.rejects(f.outcomes.change(record.id, "acknowledge", {}), { code: "OUTCOME_CONFLICT" });
  const reset = deferred();
  f.agent.resetRecovery = async () => { await reset.promise; f.agent.busy = false; return { reset: true }; };
  const ack = f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.gate.active);
  reset.resolve();
  assert.equal((await ack).record.recoveryAcknowledged, true);
  assert.equal((await f.outcomes.snapshot()).activity, null);
});

test("stop timeout stays unknown through late completion until explicit acknowledgement", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("execution", f.command);
  const pending = f.outcomes.pending;
  await until(() => f.agent.calls.length === 1);
  f.agent.stop = async () => { throw Object.assign(new Error("not confirmed"), { code: "AGENT_STOP_TIMEOUT", result: { terminal: false, process: { pid: 456 } } }); };
  const snapshot = await f.outcomes.stop({ operationId: f.gate.active.id });
  assert.equal(snapshot.records[0].status, "unknown");
  assert.equal(f.outcomes.pending, pending);
  f.agent.complete("Late completion");
  await pending;
  assert.equal((await f.store.get(record.id)).status, "unknown");
  assert.ok(f.gate.active);
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  assert.equal(f.gate.active, null);
});

test("ordinary conversation stop timeout gets a recoverable record and waits for reconciliation on acknowledgement", async (t) => {
  const f = await fixture(t);
  const running = f.conversation.addQuestion(f.thread.id, { content: "Continue", askAgent: true, agentRunId: randomUUID() });
  await until(() => f.agent.calls.length === 1);
  f.agent.stop = async () => { throw Object.assign(new Error("still running"), { code: "AGENT_STOP_TIMEOUT" }); };
  const snapshot = await f.outcomes.stop({ operationId: f.gate.active.id });
  assert.equal(snapshot.records[0].status, "unknown");
  assert.equal(snapshot.records[0].source.content, "Continue");
  await f.outcomes.change(snapshot.records[0].id, "acknowledge", { confirmed: true });
  await running;
  assert.equal(f.gate.active, null);
});

test("ordinary onRunFailure persistence immediately updates recovery protection even when runtime is idle", async (t) => {
  const f = await fixture(t);
  let failedRecord;
  f.conversation.onRunFailure = async ({ threadId, questionMessageId, error, events }) => {
    failedRecord = await f.store.create({
      kind: "execution", status: "unknown", requestKey: randomUUID(),
      instruction: "ordinary request", threadId, messageId: questionMessageId,
      source: f.source, events, recoveryAcknowledged: false, process: error.result.process
    });
    assert.equal(f.store.needsRecovery, true);
    assert.equal(new OutcomeStore(f.file, { metadataRoot: path.join(f.root, "outcomes") }).needsRecovery, true);
  };
  const running = f.conversation.addQuestion(f.thread.id, { content: "Ordinary request", askAgent: true, agentRunId: randomUUID() });
  await until(() => f.agent.calls.length === 1);
  f.agent.fail("AGENT_RUNTIME_LOST");
  await running;
  f.agent.busy = false;
  f.agent.unknown = false;
  assert.equal(f.gate.current, null);
  assert.equal(f.store.needsRecovery, true);
  assert.throws(() => f.gate.assertIdle(), { code: "WORKSPACE_BUSY" });
  assert.equal((await f.outcomes.snapshot()).activity.recoveryRequired, true);
  await f.outcomes.change(failedRecord.id, "acknowledge", { confirmed: true });
  assert.equal(f.store.needsRecovery, false);
  await f.outcomes.start("proposal", f.command);
  await until(() => f.agent.calls.length === 2);
  const resets = f.agent.resets;
  await f.outcomes.change(failedRecord.id, "acknowledge", { confirmed: true });
  assert.equal(f.agent.resets, resets, "a duplicate old acknowledgement must not reset the new run");
  f.agent.complete();
  await f.outcomes.pending;
});

test("snapshot exposes runtime protection even without a foreground owner and failed reset cannot acknowledge", async (t) => {
  const f = await fixture(t);
  const record = await f.store.create({ kind: "execution", status: "unknown", requestKey: randomUUID(), instruction: "saved request", source: f.source });
  f.agent.busy = true;
  f.agent.unknown = true;
  f.agent.resetRecovery = async () => { throw new Error("process did not close"); };
  assert.ok((await f.outcomes.snapshot()).activity.id);
  await assert.rejects(f.outcomes.change(record.id, "acknowledge", { confirmed: true }), /process did not close/);
  assert.equal((await f.store.get(record.id)).recoveryAcknowledged, undefined);
  assert.ok(f.gate.active);
});

test("proposal CAS refuses stale edits and applies once even with concurrent service instances", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  const second = new ProposalService({ document: f.document, store: f.store, agent: f.agent });
  const edited = await f.outcomes.change(record.id, "edit", { replacement: "Reviewed\n", expectedRevision: record.revision });
  await assert.rejects(f.outcomes.change(record.id, "apply", { expectedRevision: record.revision }), { code: "OUTCOME_CONFLICT" });
  let writes = 0;
  const save = f.document.save.bind(f.document);
  f.document.save = async (options) => {
    assert.equal((await f.store.get(record.id)).status, "applying");
    writes += 1;
    return save(options);
  };
  const [first, duplicate] = await Promise.all([f.outcomes.proposals.apply(record.id, edited.record.revision), second.apply(record.id, edited.record.revision)]);
  assert.equal(first.record.status, "applied");
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(writes, 1);
  assert.equal(await readFile(f.file, "utf8"), "Reviewed\n");
});

test("proposal document CAS protects external changes and rebase requires review of the current version", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  await writeFile(f.file, "Externally edited\n");
  await assert.rejects(f.outcomes.change(record.id, "apply", { expectedRevision: record.revision }), { code: "DOCUMENT_CONFLICT" });
  assert.equal(await readFile(f.file, "utf8"), "Externally edited\n");
  const conflict = await f.store.get(record.id);
  assert.equal(conflict.status, "conflict");
  const current = await f.document.payload();
  const rebased = await f.outcomes.change(record.id, "rebase", { expectedRevision: conflict.revision, documentRevision: current.revision, target: { mode: "document", start: 0, end: current.content.length } });
  assert.equal(rebased.record.baseContent, current.content);
  assert.equal(rebased.record.status, "review");
});

test("apply journal recovery covers before-write and after-write crashes and repairs document metadata", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  let journal = await f.store.update(record.id, { status: "applying", appliedRevision: documentRevision(record.proposedContent) });
  await f.outcomes.proposals.recover();
  assert.equal((await f.store.get(record.id)).status, "review");
  journal = await f.store.update(record.id, { status: "applying", appliedRevision: documentRevision(record.proposedContent) });
  await writeFile(f.file, journal.proposedContent);
  let reconciliations = 0;
  const save = f.document.save.bind(f.document);
  f.document.save = (options) => { reconciliations += 1; return save(options); };
  await f.outcomes.proposals.recover();
  assert.equal((await f.store.get(record.id)).status, "applied");
  assert.equal(reconciliations, 1);
  await f.outcomes.proposals.recover();
  assert.equal(reconciliations, 1);
});

test("exact undo is idempotent, updates both records atomically and does not count an inverse as applied", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  await f.outcomes.change(record.id, "apply", { expectedRevision: record.revision });
  const [first, repeated] = await Promise.all([f.outcomes.proposals.undo(record.id), f.outcomes.proposals.undo(record.id)]);
  assert.equal(first.record.id, repeated.record.id);
  assert.equal(first.record.status, "undone");
  const records = await f.store.list();
  assert.equal(records.find((item) => item.id === record.id).status, "undone");
  assert.equal(records.filter((item) => item.status === "applied").length, 0);
  assert.equal(await readFile(f.file, "utf8"), "Original\n");
});

test("conflicting undo never applies an unchanged inverse and preserves later edits after manual adjustment", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  await f.outcomes.change(record.id, "apply", { expectedRevision: record.revision });
  await writeFile(f.file, "Updated\nLater work\n");
  const inverse = (await f.outcomes.change(record.id, "undo")).record;
  await assert.rejects(f.outcomes.change(inverse.id, "apply", { expectedRevision: inverse.revision }), /尚未调整/);
  assert.equal((await f.store.get(record.id)).status, "applied");
  const edited = await f.outcomes.change(inverse.id, "edit", { replacement: "Original\nLater work\n", expectedRevision: inverse.revision });
  await f.outcomes.change(inverse.id, "apply", { expectedRevision: edited.record.revision });
  assert.equal(await readFile(f.file, "utf8"), "Original\nLater work\n");
  assert.equal((await f.store.get(record.id)).status, "undone");
});

test("inverse recovery repairs an interrupted two-record commit without repeating the document write", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  await f.outcomes.change(record.id, "apply", { expectedRevision: record.revision });
  const inverse = await f.store.create({ kind: "proposal", status: "applying", inverseOf: record.id, baseContent: record.proposedContent, baseRevision: documentRevision(record.proposedContent), proposedContent: record.baseContent, appliedRevision: record.baseRevision });
  await writeFile(f.file, record.baseContent);
  await f.outcomes.proposals.recover();
  const records = await f.store.list();
  assert.equal(records.find((item) => item.id === inverse.id).status, "undone");
  assert.equal(records.find((item) => item.id === record.id).undoneBy, inverse.id);
});

test("refine returns its generating journal immediately and owns the gate until stopped", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  const refining = await f.outcomes.change(record.id, "refine", { instruction: "Make it shorter", expectedRevision: record.revision });
  assert.equal(refining.record.status, "generating");
  assert.ok(f.gate.active);
  await assert.rejects(f.outcomes.change(record.id, "delete"), { code: "WORKSPACE_BUSY" });
  await until(() => f.agent.calls.length === 2);
  assert.notEqual(f.agent.calls[0].runId, f.agent.calls[1].runId);
  assert.equal(f.agent.calls[1].thread.proposal.previous, record.replacement);
  await f.outcomes.stop({ operationId: f.gate.active.id });
  assert.equal((await f.store.get(record.id)).status, "interrupted");
  assert.equal(f.gate.active, null);
});

for (const refine of [false, true]) {
  test(`${refine ? "refine" : "initial proposal"} never submits native work after stop during its document read`, async (t) => {
    const f = await fixture(t);
    const previous = refine ? await reviewed(f) : null;
    const beforeCalls = f.agent.calls.length;
    const entered = deferred(), resume = deferred();
    const payload = f.document.payload.bind(f.document);
    let reads = 0;
    f.document.payload = async () => {
      reads++;
      if (refine || reads > 1) { entered.resolve(); await resume.promise; }
      return payload();
    };
    f.agent.stop = async () => { f.agent.stopCalls++; assert.equal(f.agent.busy, false); return { status: "idle", terminal: true }; };
    try {
      const record = refine
        ? (await f.outcomes.change(previous.id, "refine", { instruction: "Make it shorter", expectedRevision: previous.revision })).record
        : await f.outcomes.start("proposal", f.command);
      await entered.promise;
      const stopping = f.outcomes.stop({ operationId: f.gate.active.id });
      await until(() => f.agent.stopCalls === 1);
      resume.resolve();
      await until(() => f.agent.calls.length > beforeCalls || !f.outcomes.pending);
      assert.equal(f.agent.calls.length, beforeCalls);
      const snapshot = await stopping;
      assert.equal(snapshot.activity, null);
      const saved = await f.store.get(record.id);
      assert.equal(saved.status, "interrupted");
      if (previous) {
        assert.equal(saved.replacement, previous.replacement);
        assert.equal(saved.result, previous.result);
      }
      assert.equal(await readFile(f.file, "utf8"), "Original\n");
    } finally {
      resume.resolve();
      if (f.agent.busy) f.agent.fail("AGENT_INTERRUPTED");
    }
  });
}

test("retry makes a new record; a deleted source requires explicit preparation and preserves the previous snapshot", async (t) => {
  const f = await fixture(t);
  const first = await f.outcomes.start("execution", f.command);
  const pending = f.outcomes.pending;
  await until(() => f.agent.calls.length === 1);
  f.agent.complete("Completed once");
  await pending;
  const next = await f.outcomes.start("execution", { ...f.command, requestKey: randomUUID(), retryOf: first.id });
  assert.notEqual(next.id, first.id);
  await until(() => f.agent.calls.length === 2);
  const nextPending = f.outcomes.pending;
  f.agent.complete("Completed retry");
  await nextPending;
  await f.threads.delete(f.thread.id);
  await assert.rejects(f.outcomes.start("execution", { ...f.command, requestKey: randomUUID(), retryOf: first.id }), { code: "OUTCOME_SOURCE_UNAVAILABLE" });
  assert.equal((await f.store.get(first.id)).source.content, "Use the updated design");
  assert.equal((await f.store.list()).length, 2);
});

test("restart recovers generating records as unknown and blocks work without discarding process metadata", async (t) => {
  const f = await fixture(t);
  const record = await f.store.create({ kind: "proposal", status: "generating", requestKey: randomUUID(), process: { pid: 777, servicePid: 123 }, source: f.source });
  await f.outcomes.proposals.recover();
  assert.equal((await f.store.get(record.id)).status, "unknown");
  assert.equal((await f.store.get(record.id)).process.pid, 777);
  assert.equal((await f.outcomes.snapshot()).activity.recoveryRequired, true);
  await assert.rejects(f.outcomes.start("proposal", f.command), { code: "WORKSPACE_BUSY" });
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  assert.equal((await f.outcomes.snapshot()).activity, null);
});

test("stop timeout journal EIO can be retried and acknowledged without waiting for late native completion", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("execution", f.command);
  await until(() => f.agent.calls.length === 1);
  await f.outcomes.current.eventWrites;
  const update = f.store.update.bind(f.store);
  let writesFail = true;
  f.store.update = (id, patch, revision) => {
    if (writesFail && typeof patch === "object" && patch.status === "unknown") return Promise.reject(Object.assign(new Error("journal temporarily unavailable"), { code: "EIO" }));
    return update(id, patch, revision);
  };
  f.agent.stop = async () => { throw Object.assign(new Error("native stop timed out"), { code: "AGENT_STOP_TIMEOUT", result: { terminal: false, process: { pid: 456 } } }); };
  const operationId = f.gate.active.id;
  await assert.rejects(f.outcomes.stop({ operationId }), { code: "EIO" });
  await assert.rejects(f.outcomes.snapshot(), { code: "EIO" });
  assert.ok(f.outcomes.pending);
  assert.equal(f.gate.active.recoveryRequired, true);
  writesFail = false;
  const retried = await f.outcomes.stop({ operationId });
  assert.equal(retried.records[0].status, "unknown");
  assert.equal(retried.activity.recoveryRequired, true);
  const ack = await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  assert.equal(ack.record.recoveryAcknowledged, true);
  assert.equal(f.agent.resets, 1);
  assert.equal((await f.outcomes.snapshot()).activity, null);
  assert.equal((await f.outcomes.snapshot()).records[0].recoveryAcknowledged, true);
});

test("unknown event persistence failure is recoverable while the native promise is still pending", async (t) => {
  const f = await fixture(t);
  const record = await f.outcomes.start("proposal", f.command);
  await until(() => f.agent.calls.length === 1);
  await f.outcomes.current.eventWrites;
  const update = f.store.update.bind(f.store);
  f.store.update = async () => { throw Object.assign(new Error("event journal failed"), { code: "EIO" }); };
  f.agent.args.onUpdate({ type: "run", status: "unknown", terminal: false });
  await f.outcomes.current.eventWrites.catch(() => {});
  f.store.update = update;
  assert.equal((await f.outcomes.snapshot()).records[0].status, "unknown");
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  assert.equal(f.gate.active, null);
});

test("deleting execution records keeps minimal durable idempotency tombstones across store instances", async (t) => {
  const f = await fixture(t);
  const first = await f.outcomes.start("execution", f.command);
  await until(() => f.agent.calls.length === 1);
  const pending = f.outcomes.pending;
  f.agent.complete("Execution already performed");
  await pending;
  const other = new OutcomeStore(f.file, { metadataRoot: path.join(f.root, "outcomes") });
  await Promise.all([f.outcomes.change(first.id, "delete"), other.delete(first.id)]);
  const raw = JSON.parse(await readFile(f.store.filePath, "utf8"));
  assert.deepEqual(raw.records, []);
  assert.equal(raw.tombstones.length, 1);
  assert.deepEqual(Object.keys(raw.tombstones[0]).sort(), ["agentRunId", "requestFingerprint", "requestKey"]);
  assert.equal(await other.hasRun(first.agentRunId), true);
  assert.equal(await other.hasRun(undefined), false);
  await assert.rejects(other.findRequest(f.command.requestKey), { code: "OUTCOME_REQUEST_DELETED", statusCode: 410 });
  await assert.rejects(other.create(first), { code: "OUTCOME_REQUEST_DELETED" });
  await assert.rejects(f.outcomes.start("execution", f.command), { code: "OUTCOME_REQUEST_DELETED" });
  await assert.rejects(f.outcomes.start("execution", { ...f.command, instruction: "Changed request" }), { code: "OUTCOME_CONFLICT" });
  assert.equal(f.agent.calls.length, 1);
  await f.outcomes.start("execution", { ...f.command, requestKey: randomUUID() });
  await until(() => f.agent.calls.length === 2);
  const nextPending = f.outcomes.pending;
  f.agent.complete("Explicit new execution");
  await nextPending;
  assert.equal(JSON.parse(await readFile(f.store.filePath, "utf8")).tombstones.length, 1);
});

test("failed apply preserves an external write made after the proposal post-image", async (t) => {
  const f = await fixture(t);
  const record = await reviewed(f);
  f.threads.reconcileAnchors = async () => {
    assert.equal(await readFile(f.file, "utf8"), record.proposedContent);
    await writeFile(f.file, "External work after proposal\n");
    throw Object.assign(new Error("anchor journal failed"), { code: "EIO" });
  };
  await assert.rejects(f.outcomes.change(record.id, "apply", { expectedRevision: record.revision }), (error) => {
    assert.equal(error.code, "DOCUMENT_CONFLICT");
    assert.equal(error.cause.code, "EIO");
    return true;
  });
  assert.equal(await readFile(f.file, "utf8"), "External work after proposal\n");
  assert.equal((await f.store.get(record.id)).status, "conflict");
});

test("rollback does not recreate a document removed during anchor persistence", async (t) => {
  const f = await fixture(t);
  f.threads.reconcileAnchors = async () => { await rm(f.file); throw new Error("anchor persistence failed"); };
  await assert.rejects(f.document.save({ content: "Edited\n", expectedRevision: f.command.documentRevision }), { code: "DOCUMENT_CONFLICT" });
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("acknowledge, verify and delete work after the source document was removed", async (t) => {
  const f = await fixture(t);
  const completed = await f.store.create({ kind: "execution", origin: "outcome", status: "completed", source: f.source });
  const unknown = await f.store.create({ kind: "execution", origin: "discussion", status: "unknown", recoveryAcknowledged: false, source: f.source });
  await rm(f.file);
  const ack = await f.outcomes.change(unknown.id, "acknowledge", { confirmed: true });
  assert.equal(ack.record.recoveryAcknowledged, true);
  const checked = await f.outcomes.change(completed.id, "verify", { expectedRevision: completed.revision, verification: "passed", verificationNote: "Independent files checked" });
  assert.equal(checked.record.verification, "passed");
  assert.deepEqual(await f.outcomes.change(completed.id, "delete"), { deleted: true });
  assert.deepEqual(await f.outcomes.change(unknown.id, "delete"), { deleted: true });
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("acknowledged discussion retry creates new execution children and preserves all previous questions and output", async (t) => {
  const f = await fixture(t);
  const originalThread = await f.threads.get(f.thread.id);
  const question = originalThread.messages.find((message) => message.role === "user");
  const source = { ...f.source, messageId: question.id, start: 0, end: question.content.length, revision: referenceRevision(question.content) };
  const original = await f.store.create({ kind: "execution", origin: "discussion", status: "unknown", recoveryAcknowledged: true,
    source, instruction: question.content, result: "Previous partial output", threadId: f.thread.id, messageId: question.id });
  let prior = original;
  let preserved = originalThread.messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await f.outcomes.start("execution", { ...f.command, source, instruction: original.instruction, requestKey: randomUUID(), retryOf: prior.id });
    assert.notEqual(fresh.id, prior.id);
    assert.equal(fresh.origin, "discussion");
    await until(() => f.agent.calls.length === attempt + 1);
    const pending = f.outcomes.pending;
    const running = await f.store.get(fresh.id);
    const thread = await f.threads.get(f.thread.id);
    const child = thread.messages.find((message) => message.id === running.messageId);
    assert.equal(child.parentId, question.id);
    assert.equal(child.meta.executionId, fresh.id);
    assert.match(child.content, /前次执行可能已有部分文件修改，请先核对/);
    assert.ok(child.content.includes(original.instruction));
    for (const old of preserved) assert.deepEqual(thread.messages.find((message) => message.id === old.id), old);
    f.agent.complete(`New output ${attempt}`);
    await pending;
    prior = await f.store.get(fresh.id);
    assert.equal(prior.status, "completed");
    assert.equal(prior.result, `New output ${attempt}`);
    preserved = (await f.threads.get(f.thread.id)).messages;
  }
  assert.deepEqual(await f.store.get(original.id), original);
  assert.equal((await f.store.list()).length, 3);
  assert.equal(preserved.length, originalThread.messages.length + 4);
});

test("user sources require an acknowledged discussion retry of that exact question", async (t) => {
  const f = await fixture(t);
  const question = (await f.threads.get(f.thread.id)).messages.find((message) => message.role === "user");
  const source = { ...f.source, messageId: question.id, end: question.content.length, revision: referenceRevision(question.content) };
  await assert.rejects(f.outcomes.start("execution", { ...f.command, source }), { code: "OUTCOME_SOURCE_UNAVAILABLE" });
  const original = await f.store.create({ kind: "execution", origin: "discussion", status: "unknown", recoveryAcknowledged: false, source });
  await assert.rejects(f.outcomes.start("execution", { ...f.command, source, retryOf: original.id }), { code: "WORKSPACE_BUSY" });
  await f.outcomes.change(original.id, "acknowledge", { confirmed: true });
  await assert.rejects(f.outcomes.start("execution", { ...f.command, retryOf: original.id }), { code: "OUTCOME_RETRY_SOURCE" });
  await assert.rejects(f.outcomes.start("proposal", { ...f.command, source, retryOf: original.id }), { code: "OUTCOME_CONFLICT" });
  const creation = await f.store.create({ kind: "execution", origin: "document-creation", status: "unknown", recoveryAcknowledged: true, source: f.source });
  await assert.rejects(f.outcomes.start("execution", { ...f.command, retryOf: creation.id }), { code: "OUTCOME_RETRY_ORIGIN", origin: "document-creation" });
  assert.equal(f.agent.calls.length, 0);
});

function creationCommand(patch = {}) {
  return { origin: "document-creation", requestKey: randomUUID(), instruction: "Create a plan",
    creationRequest: { instruction: "Create a plan", directory: "docs", fileName: "new.md" }, ...patch };
}

test("external creation journals before native work and replays the completed result without rerunning", async (t) => {
  const f = await fixture(t);
  f.document.referenceIdentity = randomUUID();
  const command = creationCommand();
  let runs = 0;
  const work = deferred();
  const result = { path: path.join(f.root, "new.md"), relativePath: "new.md", content: "Created\n" };
  const execute = async ({ record, operationToken, onUpdate, isStopping }) => {
    runs++;
    assert.equal(f.gate.active, operationToken);
    const saved = await f.store.get(record.id);
    assert.equal(saved.status, "running");
    assert.equal(saved.origin, "document-creation");
    assert.deepEqual(saved.creationRequest, command.creationRequest);
    assert.equal(saved.agentRunId, command.requestKey);
    assert.equal(saved.source.sourceIdentity, f.document.referenceIdentity);
    assert.equal(Object.hasOwn(saved.source, "referenceIdentity"), false);
    assert.equal(isStopping(), false);
    onUpdate({ type: "commandExecution", command: "inspect target" });
    await work.promise;
    return result;
  };
  const first = f.outcomes.runExternal(command, execute);
  const duplicate = f.outcomes.runExternal(command, execute);
  await until(() => runs === 1);
  await assert.rejects(f.outcomes.start("proposal", f.command), { code: "WORKSPACE_BUSY" });
  work.resolve();
  assert.deepEqual(await first, result);
  assert.deepEqual(await duplicate, result);
  assert.deepEqual(await f.outcomes.runExternal(command, execute), result);
  const [record] = await f.store.list();
  assert.equal(record.status, "completed");
  assert.equal(record.newDocumentPath, result.path);
  assert.deepEqual(record.creationResult, result);
  assert.equal(record.events[0].command, "inspect target");
  assert.equal(runs, 1);
  assert.equal(f.gate.active, null);
});

test("stopping external creation while its journal is pending never invokes the callback", async (t) => {
  const f = await fixture(t);
  const paused = deferred();
  const create = f.store.create.bind(f.store);
  let journalStarted = false, callbacks = 0;
  f.store.create = async (fields) => { journalStarted = true; await paused.promise; return create(fields); };
  const creating = f.outcomes.runExternal(creationCommand(), async () => { callbacks++; return {}; });
  const rejected = assert.rejects(creating, { code: "AGENT_INTERRUPTED" });
  await until(() => journalStarted);
  const stopping = f.outcomes.stop({ operationId: f.gate.active.id });
  paused.resolve();
  await rejected;
  const snapshot = await stopping;
  assert.equal(callbacks, 0);
  assert.equal(snapshot.records[0].status, "interrupted");
  assert.equal(snapshot.activity, null);
});

test("external runtime loss preserves the request and partial output until acknowledgement and explicit retry", async (t) => {
  const f = await fixture(t);
  const command = creationCommand();
  const creating = f.outcomes.runExternal(command, async ({ record, onUpdate }) => {
    return f.agent.runTurn({ runId: record.agentRunId, thread: { id: "document-creation" }, onUpdate });
  });
  const rejected = assert.rejects(creating, { code: "AGENT_RUNTIME_LOST" });
  await until(() => f.agent.calls.length === 1);
  f.agent.fail("AGENT_RUNTIME_LOST", "Partially prepared document");
  await rejected;
  const [record] = await f.store.list();
  assert.equal(record.status, "unknown");
  assert.equal(record.result, "Partially prepared document");
  assert.deepEqual(record.creationRequest, command.creationRequest);
  assert.equal(record.process.pid, 456);
  assert.equal(f.gate.active.recoveryRequired, true);
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  await assert.rejects(f.outcomes.runExternal(command, async () => ({})), { code: "OUTCOME_RETRY_REQUIRED" });
  const fresh = await f.outcomes.runExternal(creationCommand({ retryOf: record.id }), async () => ({ path: path.join(f.root, "retry.md"), content: "Retry" }));
  assert.ok(fresh.path.endsWith("retry.md"));
  assert.equal((await f.store.list()).length, 2);
});

test("external callback is never invoked after failed creation persistence", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.store.create = async () => { throw Object.assign(new Error("storage unavailable"), { code: "EIO" }); };
  await assert.rejects(f.outcomes.runExternal(creationCommand(), async () => { calls++; }), { code: "EIO" });
  assert.equal(calls, 0);
  assert.equal(f.gate.active, null);
});

test("a transient completion journal EIO after document creation preserves the file and requires acknowledgement", async (t) => {
  const f = await fixture(t);
  const command = creationCommand();
  const result = { path: path.join(f.root, "new.md"), relativePath: "new.md", content: "Already created\n" };
  const update = f.store.update.bind(f.store);
  let failCompletion = false;
  f.store.update = (...args) => {
    if (failCompletion) {
      failCompletion = false;
      return Promise.reject(Object.assign(new Error("completion journal EIO"), { code: "EIO" }));
    }
    return update(...args);
  };
  await assert.rejects(f.outcomes.runExternal(command, async () => {
    await writeFile(result.path, result.content);
    failCompletion = true;
    return result;
  }), { code: "EIO" });
  const [record] = await f.store.list();
  assert.equal(record.status, "unknown");
  assert.deepEqual(record.creationResult, result);
  assert.equal(record.newDocumentPath, result.path);
  assert.equal(await readFile(result.path, "utf8"), result.content);
  await assert.rejects(f.outcomes.runExternal(creationCommand(), async () => assert.fail("cannot create before acknowledgement")), { code: "WORKSPACE_BUSY" });
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  await assert.rejects(f.outcomes.runExternal(command, async () => assert.fail("must not replay native work")), { code: "OUTCOME_RETRY_REQUIRED" });
  assert.equal(f.gate.active, null);
});

test("stop after the document write retains the created result even when the journal stays unavailable until recovery", async (t) => {
  const f = await fixture(t);
  const command = creationCommand();
  const written = deferred(), finish = deferred();
  const result = { path: path.join(f.root, "new.md"), relativePath: "new.md", content: "Created before stop\n" };
  const update = f.store.update.bind(f.store);
  let failWrites = false;
  f.store.update = (...args) => failWrites
    ? Promise.reject(Object.assign(new Error("journal unavailable"), { code: "EIO" })) : update(...args);
  const creating = f.outcomes.runExternal(command, async () => {
    await writeFile(result.path, result.content);
    written.resolve();
    await finish.promise;
    failWrites = true;
    return result;
  });
  const createRejected = assert.rejects(creating, { code: "EIO" });
  await written.promise;
  const stopping = f.outcomes.stop({ operationId: f.gate.active.id });
  const stopRejected = assert.rejects(stopping, { code: "EIO" });
  await until(() => f.agent.stopCalls === 1);
  finish.resolve();
  await Promise.all([createRejected, stopRejected]);
  assert.equal(f.gate.active.recoveryRequired, true);
  assert.equal(await readFile(result.path, "utf8"), result.content);
  failWrites = false;
  const snapshot = await f.outcomes.snapshot();
  const record = snapshot.records[0];
  assert.equal(record.status, "unknown");
  assert.deepEqual(record.creationResult, result);
  assert.equal(record.result, result.content);
  assert.equal(record.newDocumentPath, result.path);
  await f.outcomes.change(record.id, "acknowledge", { confirmed: true });
  assert.equal((await f.outcomes.snapshot()).activity, null);
  assert.equal((await f.store.get(record.id)).recoveryAcknowledged, true);
  await assert.rejects(f.outcomes.runExternal(command, async () => assert.fail("must not create twice")), { code: "OUTCOME_RETRY_REQUIRED" });
});

test("confirmed stop after document write leaves an interrupted record with the created file result", async (t) => {
  const f = await fixture(t);
  const written = deferred(), finish = deferred();
  const result = { path: path.join(f.root, "new.md"), relativePath: "new.md", content: "Retain this file\n" };
  const creating = f.outcomes.runExternal(creationCommand(), async () => {
    await writeFile(result.path, result.content);
    written.resolve();
    await finish.promise;
    return result;
  });
  const rejected = assert.rejects(creating, { code: "AGENT_INTERRUPTED" });
  await written.promise;
  const stopping = f.outcomes.stop({ operationId: f.gate.active.id });
  await until(() => f.agent.stopCalls === 1);
  finish.resolve();
  await rejected;
  const snapshot = await stopping;
  assert.equal(snapshot.records[0].status, "interrupted");
  assert.deepEqual(snapshot.records[0].creationResult, result);
  assert.equal(await readFile(result.path, "utf8"), result.content);
  assert.equal(snapshot.activity, null);
});

test("document payload includes optional reference registration and relink requirements", async (t) => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(await f.document.payload(), "referenceIdentity"), false);
  assert.equal(Object.hasOwn(await f.document.payload(), "referenceIdentityRequired"), false);
  f.document.referenceIdentity = randomUUID();
  f.document.referenceIdentityRequired = true;
  const payload = await f.document.payload();
  assert.equal(payload.referenceIdentity, f.document.referenceIdentity);
  assert.equal(payload.referenceIdentityRequired, true);
  f.document.referenceIdentityRequired = false;
  assert.equal(Object.hasOwn(await f.document.payload(), "referenceIdentityRequired"), false);
});
