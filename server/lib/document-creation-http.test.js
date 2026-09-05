import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OutcomeStore } from "./outcome-store.js";

const serverEntry = fileURLToPath(new URL("../index.js", import.meta.url));

test("HTTP creation loss is journaled before native submission and retries preserve the old record", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, "loss");
  const creationRequest = { instruction: "  Create a deployment plan\nwith recovery steps  ", directory: "notes", fileName: "deployment" };
  const command = { ...creationRequest, documentPath: f.documentPath, agentRunId: "newdoc-loss-first" };
  await f.request("/api/document/create", command, "POST", 500);
  const state = await f.request("/api/outcomes");
  const record = state.records[0];
  assert.equal(record.origin, "document-creation");
  assert.equal(record.status, "unknown");
  assert.deepEqual(record.creationRequest, creationRequest);
  assert.match(record.result, /partial native output/);
  assert.equal(state.activity.recoveryRequired, true);
  assert.equal((await f.request("/api/agent-runs/newdoc-loss-first")).status, "unknown");
  const submitted = (await f.audit())[0];
  assert.equal(submitted.journalStatus, "running");
  assert.deepEqual(submitted.creationRequest, creationRequest);
  assert.equal((await f.request("/api/document")).path, f.documentPath);

  await f.request("/api/outcomes/" + record.id + "/acknowledge", { documentPath: f.documentPath, confirmed: true });
  await f.request("/api/document/create", command, "POST", 409);
  await f.mode("complete");
  const retry = { ...creationRequest, documentPath: f.documentPath, agentRunId: "newdoc-loss-retry", retryOf: record.id };
  const created = await f.request("/api/document/create", retry, "POST", 201);
  assert.equal(created.document.path, path.join(f.root, "notes", "deployment.md"));
  assert.equal(created.document.content, "# Created\n");
  const nativeCountAfterRetry = (await f.audit()).length;
  const staleReplay = await f.request("/api/document/create", retry, "POST", 409);
  assert.match(staleReplay.error, /active document changed/);
  assert.equal((await f.audit()).length, nativeCountAfterRetry);
  assert.deepEqual((await f.request("/api/outcomes")).records, []);
  await f.request("/api/document/open", { path: f.documentPath });
  const records = (await f.request("/api/outcomes")).records;
  assert.equal(records.length, 2);
  assert.equal(records.find((item) => item.id === record.id).status, "unknown");
  assert.equal(records.find((item) => item.id === record.id).recoveryAcknowledged, true);
  const completed = records.find((item) => item.retryOf === record.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.creationResult.path, created.document.path);
  const nativeCount = (await f.audit()).length;
  await f.request("/api/document/create", retry, "POST", 201);
  assert.equal((await f.audit()).length, nativeCount, "duplicate successful creation replays its saved result");
});

test("HTTP service restart preserves an in-flight creation request and requires recovery acknowledgement", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, "hold");
  const creationRequest = { instruction: "Create the original migration plan", directory: null, fileName: "migration.md" };
  const pending = f.request("/api/document/create", { ...creationRequest, documentPath: f.documentPath, agentRunId: "creation-server-crash" }, "POST", 201).catch(() => null);
  await until(async () => (await f.audit()).length === 1);
  const journal = JSON.parse(await readFile(f.journal, "utf8"));
  assert.equal(journal.records[0].status, "running");
  assert.deepEqual(journal.records[0].creationRequest, creationRequest);
  await f.stop("SIGKILL");
  await pending;
  await f.start();
  const recovered = await f.request("/api/outcomes");
  assert.equal(recovered.records.length, 1);
  const record = recovered.records[0];
  assert.equal(record.status, "unknown");
  assert.deepEqual(record.creationRequest, creationRequest);
  assert.equal(recovered.activity.recoveryRequired, true);
  const retry = { ...creationRequest, documentPath: f.documentPath, agentRunId: "creation-after-restart", retryOf: record.id };
  await f.request("/api/document/create", retry, "POST", 409);
  await f.request("/api/outcomes/" + record.id + "/acknowledge", { documentPath: f.documentPath, confirmed: true });
  await f.mode("complete");
  const created = await f.request("/api/document/create", retry, "POST", 201);
  assert.equal(await readFile(created.document.path, "utf8"), "# Created\n");
});

test("HTTP creation requires the source path and rejects cross-document replays before native work, including deleted records", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, "complete");
  const command = { instruction: "Create a deployment plan", fileName: "deployment.md", agentRunId: "creation-source-bound" };
  for (const documentPath of [undefined, null, "", "   ", 42]) {
    const invalid = await f.request("/api/document/create", { ...command, documentPath }, "POST", 400);
    assert.match(invalid.error, /源文档路径/);
  }
  assert.deepEqual(await f.audit(), []);
  assert.deepEqual((await f.request("/api/outcomes")).records, []);
  const boundCommand = { ...command, documentPath: f.documentPath };
  const created = await f.request("/api/document/create", boundCommand, "POST", 201);
  assert.equal((await f.request("/api/document")).path, created.document.path);
  const stale = await f.request("/api/document/create", boundCommand, "POST", 409);
  assert.match(stale.error, /active document changed/);
  await f.request("/api/document/create", command, "POST", 400);
  assert.equal((await f.audit()).length, 1);
  assert.deepEqual((await f.request("/api/outcomes")).records, []);

  await f.request("/api/document/open", { path: f.documentPath });
  const original = (await f.request("/api/outcomes")).records[0];
  await f.request(`/api/outcomes/${original.id}/delete`, { documentPath: f.documentPath });
  const journal = JSON.parse(await readFile(f.journal, "utf8"));
  assert.equal(journal.records.length, 0);
  assert.equal(journal.tombstones[0].requestKey, command.agentRunId);
  const deleted = await f.request("/api/document/create", boundCommand, "POST", 410);
  assert.match(deleted.error, /旧提交不会再次执行/);
  await f.request("/api/document/open", { path: created.document.path });
  const deletedStale = await f.request("/api/document/create", boundCommand, "POST", 409);
  assert.match(deletedStale.error, /active document changed/);
  assert.equal((await f.audit()).length, 1);
  assert.deepEqual((await f.request("/api/outcomes")).records, []);
  assert.equal(await readFile(created.document.path, "utf8"), "# Created\n");
});

test("HTTP ordinary unknown records identify the original question and each failed retry has its own recovery", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, "loss");
  const document = await f.request("/api/document");
  const { thread } = await f.request("/api/threads", {
    documentPath: f.documentPath, title: "Source", selectedText: "Source", anchor: { start: 2, end: 8 }, expectedRevision: document.revision
  }, "POST", 201);
  const reply = await f.request(`/api/threads/${thread.id}/messages`, { content: "Inspect the plan", agentRunId: "discussion-loss-first" });
  assert.equal(reply.agentOutcome, "failed");
  const first = (await f.request("/api/outcomes")).records[0];
  assert.equal(first.origin, "discussion");
  assert.equal(first.threadId, thread.id);
  assert.equal(first.messageId, reply.userMessage.id);
  await f.request(`/api/outcomes/${first.id}/acknowledge`, { documentPath: f.documentPath, confirmed: true });
  const retryPath = `/api/threads/${thread.id}/messages/${reply.userMessage.id}`;
  const repeated = await f.request(retryPath, { content: "Inspect the plan", rerunAgent: true, agentRunId: "discussion-loss-second" }, "PUT");
  assert.equal(repeated.agentOutcome, "failed");
  const records = (await f.request("/api/outcomes")).records;
  assert.equal(records.length, 2);
  const second = records.find((item) => item.requestKey === "discussion-loss-second");
  assert.equal(second.origin, "discussion");
  assert.equal(second.messageId, first.messageId);
  assert.equal(second.recoveryAcknowledged, false);
  assert.equal(records.find((item) => item.id === first.id).recoveryAcknowledged, true);
  await f.request(`/api/outcomes/${second.id}/acknowledge`, { documentPath: f.documentPath, confirmed: true });
  await f.mode("complete");
  const completed = await f.request(retryPath, { content: "Inspect the plan", rerunAgent: true, agentRunId: "discussion-retry-success" }, "PUT");
  assert.equal(completed.agentOutcome, "completed");
  assert.equal((await f.request("/api/outcomes")).records.length, 2);
});

test("HTTP natural discussion loss retries its unavailable journal with the original question and partial result", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, "loss-journal-error");
  const document = await f.request("/api/document");
  const { thread } = await f.request("/api/threads", {
    documentPath: f.documentPath, title: "Source", selectedText: "Source", anchor: { start: 2, end: 8 }, expectedRevision: document.revision
  }, "POST", 201);
  await f.request(`/api/threads/${thread.id}/messages`, { content: "Inspect the original plan", agentRunId: "discussion-journal-unavailable" }, "POST", 500);
  await f.request("/api/outcomes", undefined, "GET", 500);
  await f.request(`/api/threads/${thread.id}/messages`, { content: "Do not run", agentRunId: "blocked-during-journal-failure" }, "POST", 409);
  assert.equal((await f.audit()).length, 1);

  await rm(f.journal, { recursive: true });
  const recovered = await f.request("/api/outcomes");
  assert.equal(recovered.records.length, 1);
  assert.equal(recovered.activity.recoveryRequired, true);
  const record = recovered.records[0];
  assert.equal(record.status, "unknown");
  assert.equal(record.origin, "discussion");
  assert.equal(record.requestKey, "discussion-journal-unavailable");
  assert.equal(record.threadId, thread.id);
  assert.equal(record.source.content, "Inspect the original plan");
  assert.equal(record.source.sourceIdentity, document.referenceIdentity);
  assert.match(record.result, /partial native output/);
  assert.ok(record.events.length > 0);
  assert.equal(JSON.parse(await readFile(f.journal, "utf8")).records[0].id, record.id);
  await f.request(`/api/outcomes/${record.id}/acknowledge`, { documentPath: f.documentPath, confirmed: true });
  assert.equal((await f.request("/api/outcomes")).activity, null);
  await f.mode("complete");
  await f.request(`/api/threads/${thread.id}/messages`, { content: "A new question after recovery", agentRunId: "discussion-after-journal-recovery" });
  assert.equal((await f.audit()).length, 2);
  assert.equal((await f.request("/api/outcomes")).records.length, 1);
});

test("HTTP outcome retry of an unknown discussion creates a child and preserves the original partial answer", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, "loss");
  const document = await f.request("/api/document");
  const { thread } = await f.request("/api/threads", {
    documentPath: f.documentPath, title: "Source", selectedText: "Source", anchor: { start: 2, end: 8 }, expectedRevision: document.revision
  }, "POST", 201);
  const reply = await f.request(`/api/threads/${thread.id}/messages`, { content: "Inspect the original plan", agentRunId: "discussion-outcome-original" });
  const original = (await f.request("/api/outcomes")).records[0];
  assert.equal(original.origin, "discussion");
  assert.match(original.result, /partial native output/);
  assert.match(reply.assistantMessage.content, /partial native output/);
  await f.request(`/api/outcomes/${original.id}/acknowledge`, { documentPath: f.documentPath, confirmed: true });
  await f.mode("complete");
  const { record: retry } = await f.request("/api/outcomes", {
    kind: "execution", documentPath: f.documentPath, documentRevision: document.revision,
    source: original.source, references: original.references, instruction: "Inspect current files and continue the original plan",
    requestKey: "discussion-outcome-retry", retryOf: original.id
  }, "POST", 202);
  assert.notEqual(retry.id, original.id);
  const settled = await until(async () => {
    const state = await f.request("/api/outcomes");
    return !state.activity && state.records.find((record) => record.id === retry.id)?.status === "completed" && state;
  });
  assert.equal(settled.records.length, 2);
  const oldRecord = settled.records.find((record) => record.id === original.id);
  assert.equal(oldRecord.status, "unknown");
  assert.equal(oldRecord.result, original.result);
  assert.equal(oldRecord.recoveryAcknowledged, true);
  assert.equal(settled.records.find((record) => record.id === retry.id).retryOf, original.id);
  const { threads } = await f.request("/api/threads");
  const messages = threads.find((item) => item.id === thread.id).messages;
  assert.equal(messages.find((message) => message.id === reply.userMessage.id).content, reply.userMessage.content);
  assert.equal(messages.find((message) => message.id === reply.assistantMessage.id).content, reply.assistantMessage.content);
  const newQuestion = messages.find((message) => message.meta?.executionId === retry.id);
  assert.ok(newQuestion);
  assert.notEqual(newQuestion.id, reply.userMessage.id);
  assert.equal(newQuestion.parentId, reply.userMessage.nodeId || reply.userMessage.id);
  assert.equal(messages.length, 4);
});

async function fixture(t, mode) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "xuanniao-creation-http-")));
  let child;
  const stop = async (signal = "SIGTERM") => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill(signal);
    await exited;
  };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const documentPath = path.join(root, "source.md");
  const metadataRoot = path.join(root, "metadata");
  const journal = new OutcomeStore(documentPath, { metadataRoot }).filePath;
  const modePath = path.join(root, "mode.txt");
  const auditPath = path.join(root, "native-audit.jsonl");
  const nativePath = path.join(root, "native.mjs");
  await Promise.all([writeFile(documentPath, "# Source\n"), writeFile(modePath, mode), writeFile(nativePath, fakeNative)]);
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let logs = "";
  const start = async () => {
    child = spawn(process.execPath, [serverEntry, documentPath], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), XUANNIAO_DATA_DIR: metadataRoot,
        XUANNIAO_CODEX_CMD: `${process.execPath} ${nativePath}`, REVIEW_MODE_PATH: modePath, REVIEW_AUDIT_PATH: auditPath, REVIEW_JOURNAL_PATH: journal }
    });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(logs);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    });
  };
  await start();
  return {
    root, documentPath, journal, start, stop,
    mode: (value) => writeFile(modePath, value),
    audit: async () => {
      try { return (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
    request: async (route, body, method = body === undefined ? "GET" : "POST", status = 200) => {
      const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      const payload = await response.json();
      assert.equal(response.status, status, `${route}: ${JSON.stringify(payload)}\n${logs}`);
      return payload;
    }
  };
}

async function until(predicate) {
  for (let index = 0; index < 200; index++) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for HTTP lifecycle transition");
}

const fakeNative = String.raw`
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import readline from "node:readline";
let next = 0;
const timers = new Map();
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: {} });
  if (method === "model/list") return send({ id, result: { data: [] } });
  if (["thread/start", "thread/resume", "thread/fork"].includes(method)) return send({ id, result: { thread: { id: params.threadId || "native-" + ++next } } });
  if (method === "turn/interrupt") {
    clearTimeout(timers.get(params.turnId)); timers.delete(params.turnId);
    send({ id, result: {} });
    return send({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
  }
  if (method !== "turn/start") return send({ id, result: {} });
  const turnId = "turn-" + ++next;
  const prompt = params.input.map(item => item.text || "").join("\n");
  const creation = prompt.includes("<XUANNIAO_DOCUMENT_CONTENT>");
  let journal;
  if (creation) journal = JSON.parse(readFileSync(process.env.REVIEW_JOURNAL_PATH, "utf8")).records.findLast(record => record.origin === "document-creation" && record.status === "running");
  appendFileSync(process.env.REVIEW_AUDIT_PATH, JSON.stringify({ creation, journalStatus: journal?.status, creationRequest: journal?.creationRequest }) + "\n");
  send({ id, result: { turn: { id: turnId } } });
  const mode = readFileSync(process.env.REVIEW_MODE_PATH, "utf8");
  if (mode === "loss" || mode === "loss-journal-error") {
    if (mode === "loss-journal-error") mkdirSync(process.env.REVIEW_JOURNAL_PATH);
    send({ method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId, delta: "partial native output" } });
    setTimeout(() => process.exit(2), 15);
    return;
  }
  if (mode === "hold") { timers.set(turnId, setTimeout(() => {}, 60000)); return; }
  const text = creation ? "<XUANNIAO_DOCUMENT_PATH>created.md</XUANNIAO_DOCUMENT_PATH>\n<XUANNIAO_DOCUMENT_CONTENT>\n# Created\n</XUANNIAO_DOCUMENT_CONTENT>" : "Checked the plan.";
  send({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { type: "agentMessage", text } } });
  send({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
});
`;
