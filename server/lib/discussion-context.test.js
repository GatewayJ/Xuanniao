import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureReferences, referenceRevision } from "./discussion-context.js";
import { buildAgentPrompt } from "./agent-context.js";
import { ConversationService } from "./conversation-service.js";
import { DocumentWorkspace } from "./document-workspace.js";
import { ThreadStore } from "./thread-store.js";
import { branchThreadForQuestion } from "./thread-tree.js";

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "plan.md");
  await writeFile(file, "# Plan\n\nPRIVATE_UNSELECTED_BODY\n");
  const store = new ThreadStore(path.join(dir, "threads.json"));
  const document = new DocumentWorkspace(file, store);
  const payload = await document.payload();
  const source = await document.createThread({ title: "Plan", selectedText: "Plan", anchor: { start: 2, end: 6 }, expectedRevision: payload.revision });
  const sourceQuestion = await store.addMessage(source.id, { role: "user", content: "不增加依赖" });
  const sourceAnswer = await store.completeAgentTurn(source.id, sourceQuestion.id, { role: "assistant", content: "采用现有方案，先验证兼容性", meta: {} }, { adapter: "codex-app-server", sessionId: "original-native-session", turnId: "old-turn" });
  const input = { kind: "message", threadId: source.id, messageId: sourceAnswer.id, start: 0, end: sourceAnswer.content.length, revision: referenceRevision(sourceAnswer.content) };
  return { dir, file, store, document, payload, source, sourceQuestion, sourceAnswer, input };
}

test("reference capture resolves authoritative content, deduplicates and rejects invalid or stale sources", async (t) => {
  const { store, payload, input, sourceAnswer, source } = await workspace(t);
  const refs = await captureReferences([{ ...input, content: "forged", title: "forged" }, input], { document: payload, threadStore: store });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].content, sourceAnswer.content);
  assert.notEqual(refs[0].title, "forged");
  assert.equal(refs[0].sourceLength, sourceAnswer.content.length);
  await assert.rejects(captureReferences([{ ...input, revision: "stale" }], { document: payload, threadStore: store }), { code: "REFERENCE_CHANGED" });
  await assert.rejects(captureReferences([{ ...input, start: -1 }], { document: payload, threadStore: store }), { statusCode: 400 });
  assert.equal((await captureReferences(Array(25).fill(input), { document: payload, threadStore: store })).length, 1);
  const large = "x".repeat(160_001);
  await assert.rejects(captureReferences([{ kind: "document", start: 0, end: large.length, revision: referenceRevision(large) }], { document: { ...payload, content: large }, threadStore: store }), { statusCode: 400 });
  await store.delete(source.id);
  await assert.rejects(captureReferences([input], { document: payload, threadStore: store }), { code: "REFERENCE_CHANGED" });
  assert.equal(refs[0].content, sourceAnswer.content);
});

test("a retry may include its primary source twice but still respects 24 unique references", async (t) => {
  const { store, payload } = await workspace(t);
  const inputs = Array.from({ length: 24 }, (_, start) => ({ kind: "document", start, end: start + 1, revision: payload.revision }));
  const captured = await captureReferences(inputs, { document: payload, threadStore: store });
  const retried = await captureReferences([captured[0], ...captured], { document: payload, threadStore: store });
  assert.equal(retried.length, 24);
  assert.deepEqual(retried.map((item) => item.id), captured.map((item) => item.id));
  await assert.rejects(captureReferences([...captured, { ...inputs[0], start: 24, end: 25 }], { document: payload, threadStore: store }), /24 项不同/);
});

test("independent discussion survives reload and starts without source sessions or hidden document context", async (t) => {
  const { store, document, payload, source, sourceAnswer, input } = await workspace(t);
  const independent = await document.createThread({ title: "独立评估", selectedText: "Plan", anchor: source.anchor, expectedRevision: payload.revision, independent: true, contextScope: "references", sourceThreadId: source.id });
  assert.notEqual(independent.id, source.id);
  const normal = await document.createThread({ title: "Plan", selectedText: "Plan", anchor: source.anchor, expectedRevision: payload.revision });
  assert.equal(normal.id, source.id);
  let actual;
  const service = new ConversationService({ threadStore: store, document, agent: {
    async runTurn(turn) {
      actual = turn;
      return { content: "只评估所选方案", transport: "test", updates: [], session: null };
    }
  } });
  const result = await service.addQuestion(independent.id, { content: "评估兼容性", references: [input], askAgent: true });
  assert.equal(actual.thread.agentSession, null);
  assert.equal(actual.thread.parentAgentSession, null);
  assert.deepEqual(actual.thread.messages, []);
  const prompt = buildAgentPrompt({ ...actual, supplementalHistory: actual.thread.messages });
  assert.match(prompt, /采用现有方案/);
  assert.doesNotMatch(prompt, /PRIVATE_UNSELECTED_BODY|<XUANNIAO_BRANCH_HISTORY>/);
  assert.doesNotMatch(prompt, /Selected document text:/);
  assert.ok(prompt.endsWith("Current user question:\n评估兼容性"));
  for (const value of [source.id, sourceAnswer.id, input.revision]) assert.ok(!prompt.includes(value));
  await store.delete(source.id);
  const reloaded = await new ThreadStore(store.filePath).get(independent.id);
  assert.equal(reloaded.contextScope, "references");
  assert.equal(reloaded.sourceThreadId, source.id);
  assert.equal(reloaded.messages[0].meta.references[0].content, "采用现有方案，先验证兼容性");
  const savedReference = reloaded.messages[0].meta.references[0];
  for (const field of ["kind", "threadId", "messageId", "start", "end", "revision"]) assert.equal(savedReference[field], input[field]);
  const revision = await service.reviseQuestion(independent.id, result.userMessage.id, { content: "换一种评估方法", askAgent: false });
  assert.deepEqual(revision.message.meta.references, result.userMessage.meta.references);
  const followup = await service.addQuestion(independent.id, { content: "继续", parentMessageId: result.userMessage.id, askAgent: false });
  const branch = branchThreadForQuestion(await store.get(independent.id), followup.userMessage.id);
  const reconstructed = buildAgentPrompt({ question: "继续", document: payload, thread: branch, supplementalHistory: branch.messages });
  assert.match(reconstructed, /采用现有方案/);
  assert.doesNotMatch(reconstructed, /PRIVATE_UNSELECTED_BODY/);
});

test("stale references fail before saving a question or invoking the agent", async (t) => {
  const { store, document, source, input } = await workspace(t);
  let calls = 0;
  const service = new ConversationService({ threadStore: store, document, agent: { runTurn: async () => { calls++; } } });
  const before = await store.get(source.id);
  await assert.rejects(service.addQuestion(source.id, { content: "Review", parentMessageId: before.messages[0].id, references: [{ ...input, revision: "old" }], askAgent: true }), { code: "REFERENCE_CHANGED" });
  assert.equal(calls, 0);
  assert.equal((await store.get(source.id)).messages.length, before.messages.length);
  assert.equal(service.isBusy(), false);
});

test("cross-document capture uses the selected document and partitions duplicate message IDs by source path", async (t) => {
  const { store, payload, input, sourceAnswer, source } = await workspace(t);
  const externalPath = path.join(path.dirname(payload.path), "another.md");
  const external = { ...payload, path: externalPath, title: "Other", content: "# Other\nEXTERNAL_ONLY" };
  let resolveCalls = 0;
  const externalThread = { ...source, messages: [{ ...sourceAnswer, content: "Separate source answer" }] };
  const resolver = async (filePath) => {
    assert.equal(filePath, externalPath);
    resolveCalls++;
    return { document: external, threadStore: { list: async () => [externalThread] } };
  };
  const refs = await captureReferences([
    input,
    { ...input, documentPath: externalPath, end: externalThread.messages[0].content.length, revision: referenceRevision(externalThread.messages[0].content) },
    { kind: "document", documentPath: externalPath, start: 0, end: external.content.length, revision: referenceRevision(external.content), content: "forged" }
  ], { document: payload, threadStore: store, resolveDocument: resolver });
  assert.equal(resolveCalls, 1);
  assert.equal(refs.length, 3);
  assert.equal(refs[0].documentPath, payload.path);
  assert.equal(refs[1].documentPath, externalPath);
  assert.notEqual(refs[0].id, refs[1].id);
  assert.equal(refs[1].content, "Separate source answer");
  assert.equal(refs[2].content, external.content);
  await assert.rejects(captureReferences([{ ...input, documentPath: externalPath }], { document: payload, threadStore: store }), { statusCode: 400 });
  await assert.rejects(captureReferences([{ ...input, documentPath: externalPath }], { document: payload, threadStore: store, resolveDocument: async () => ({ document: payload, threadStore: store }) }), { code: "REFERENCE_CHANGED" });
  await assert.rejects(captureReferences([{ ...input, documentPath: externalPath }], { document: payload, threadStore: store, resolveDocument: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }), { code: "REFERENCE_CHANGED" });
});

test("generated message references label the corresponding question and preserve full source metadata", async (t) => {
  const { store, payload, source, sourceQuestion, sourceAnswer, input } = await workspace(t);
  const original = await store.get(source.id);
  const question = { ...sourceQuestion, id: "followup", nodeId: sourceQuestion.id, content: "  本次追问\n\t兼容性 " };
  const answer = { ...sourceAnswer, id: "followup-answer", nodeId: sourceQuestion.id, parentId: question.id, content: "完整回答\n" + "必要依据。".repeat(100) };
  const thread = { ...original, title: "引用中不应该显示的无关原文".repeat(100), messages: [...original.messages, question, answer] };
  const sourceDocument = { ...payload, referenceIdentity: "stable-source-identity" };
  const request = { ...input, messageId: answer.id, title: thread.title, content: "forged", start: 2, end: answer.content.length - 3, revision: referenceRevision(answer.content), sourceIdentity: sourceDocument.referenceIdentity };
  const historicalSnapshot = { ...request, title: "已发送的历史标题", content: answer.content.slice(request.start, request.end) };
  const before = structuredClone({ thread, historicalSnapshot });
  const [captured] = await captureReferences([request], { document: sourceDocument, threadStore: { list: async () => [thread] } });
  assert.equal(captured.title, "本次追问 兼容性 · 回答");
  assert.equal(captured.content, answer.content.slice(request.start, request.end));
  for (const field of ["threadId", "messageId", "start", "end", "revision", "sourceIdentity"]) assert.equal(captured[field], request[field]);
  assert.equal(captured.sourceLength, answer.content.length);
  assert.equal(captured.id, `message:${payload.path}:${thread.id}:${answer.id}:${request.start}:${request.end}:${request.revision}:stable-source-identity`);
  assert.deepEqual({ thread, historicalSnapshot }, before);
  assert.deepEqual(await store.get(source.id), original);
});

test("missing questions use a concise label instead of an unrelated thread or answer paragraph", async () => {
  const answer = { id: "answer", role: "assistant", parentId: "deleted", nodeId: "root", content: "回答正文".repeat(60) };
  const thread = { id: "thread", title: "无关长段落".repeat(200), messages: [{ id: "root", role: "user", content: "另一个问题" }, answer] };
  const document = { path: "/missing-question.md", content: "", title: "Document" };
  const [captured] = await captureReferences([{ kind: "message", threadId: thread.id, messageId: answer.id, start: 0, end: answer.content.length, revision: referenceRevision(answer.content) }], { document, threadStore: { list: async () => [thread] } });
  assert.equal(captured.title, "原问题不可用 · 回答");
  assert.equal(captured.content, answer.content);
});
