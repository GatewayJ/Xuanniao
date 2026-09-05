import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api";
import { createAgentRunId } from "./agent-run";
import { documentCreationCommand, prepareDocumentCreationRetry } from "./document-creation";
import type { OutcomeRecord } from "./types";

const path = "/workspace/source.md";
const oldRecord: OutcomeRecord = {
  id: "lost-creation", kind: "execution", origin: "document-creation", status: "unknown", recoveryAcknowledged: true,
  documentPath: path, title: "New design document", instruction: "Expanded agent prompt", revision: 1,
  createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z",
  source: { id: "source", kind: "document", documentPath: path, content: "source", start: 0, end: 6, revision: "v1", title: "Source" }, references: [],
  creationRequest: { instruction: "Document the issue", directory: "/workspace/docs", fileName: "design.md" }, result: "Partial output: created a draft."
};

test("creation retry restores the original user request and destination, retaining the prior record and output", () => {
  const before = structuredClone(oldRecord);
  const retry = prepareDocumentCreationRetry(oldRecord, path);
  assert.deepEqual(retry.command, oldRecord.creationRequest);
  assert.notEqual(retry.command.instruction, oldRecord.instruction);
  assert.equal(retry.previousResult, oldRecord.result); assert.equal(retry.documentPath, path);
  const command = documentCreationCommand({ ...retry.command, fileName: "reviewed-design.md" }, path, retry);
  assert.equal(command.retryOf, oldRecord.id); assert.equal(command.fileName, "reviewed-design.md");
  assert.deepEqual(oldRecord, before);
  const automatic = prepareDocumentCreationRetry({ ...oldRecord, creationRequest: { instruction: "Let the agent choose" } }, path);
  assert.deepEqual(automatic.command, { instruction: "Let the agent choose", directory: null, fileName: null });
});

test("creation retries require an acknowledged terminal record and its original active document", () => {
  assert.throws(() => prepareDocumentCreationRetry({ ...oldRecord, recoveryAcknowledged: false }, path), /先核对/);
  assert.throws(() => prepareDocumentCreationRetry({ ...oldRecord, status: "running" }, path), /先核对/);
  assert.throws(() => prepareDocumentCreationRetry({ ...oldRecord, origin: "discussion" }, path), /原始创建要求不可用/);
  assert.throws(() => prepareDocumentCreationRetry({ ...oldRecord, creationRequest: undefined }, path), /原始创建要求不可用/);
  assert.throws(() => prepareDocumentCreationRetry(oldRecord, "/workspace/created.md"), /来源文档/);
  const retry = prepareDocumentCreationRetry(oldRecord, path);
  assert.throws(() => documentCreationCommand(retry.command, "/workspace/created.md", retry), /活动文档已切换/);
  assert.throws(() => documentCreationCommand(retry.command, null), /尚未加载/);
});

test("POST creation always retains the captured source path, including a replay after the response switches to the created file", async (t) => {
  const calls: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    calls.push({ url, body: JSON.parse(options!.body as string), signal: options?.signal });
    return calls.length === 1
      ? new Response(JSON.stringify({ document: { path: "/workspace/created.md" }, threads: [], files: [] }))
      : new Response(JSON.stringify({ error: "活动文档已经切换" }), { status: 409 });
  });
  let currentPath = path;
  const draft = { instruction: "Create a design", directory: null, fileName: "created.md" };
  const captured = documentCreationCommand(draft, currentPath);
  const runId = createAgentRunId();
  const controller = new AbortController();
  const result = await api.createDocument(captured, runId, controller.signal);
  currentPath = result.document.path;
  draft.instruction = "A newer edit";
  await assert.rejects(api.createDocument(captured, runId, controller.signal), /活动文档已经切换/);
  assert.equal(currentPath, "/workspace/created.md");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "/api/document/create"); assert.equal(call.signal, controller.signal);
    assert.equal(call.body.documentPath, path); assert.equal(call.body.instruction, "Create a design"); assert.equal(call.body.agentRunId, runId);
  }
});

test("an explicit retry POST names the old record and a new native run, without changing the source binding", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options?: RequestInit) => {
    bodies.push(JSON.parse(options!.body as string));
    return new Response(JSON.stringify({ document: { path: "/workspace/new.md" }, threads: [], files: [] }));
  });
  const retry = prepareDocumentCreationRetry(oldRecord, path);
  const command = documentCreationCommand(retry.command, path, retry);
  await api.createDocument(command, createAgentRunId());
  await api.createDocument(command, createAgentRunId());
  assert.notEqual(bodies[0].agentRunId, bodies[1].agentRunId);
  for (const body of bodies) { assert.equal(body.retryOf, oldRecord.id); assert.equal(body.documentPath, path); assert.equal(body.instruction, oldRecord.creationRequest!.instruction); }
});
