import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { api as browserApi } from "../../web/src/api.ts";

const serverEntry = fileURLToPath(new URL("../index.js", import.meta.url));
const revision = (text) => createHash("sha256").update(text).digest("hex");

export const fakeOutcomeAgent = String.raw`
import readline from "node:readline";
let next = 0;
const timers = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { userAgent: "outcome-test" } });
  if (method === "model/list") return send({ id, result: { data: [{ id: "test", model: "test", displayName: "本地验证桩", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }], nextCursor: null } });
  if (["thread/start", "thread/fork", "thread/resume"].includes(method)) return send({ id, result: { thread: { id: method === "thread/resume" ? params.threadId : "native-" + ++next }, sandbox: { type: params.sandbox === "read-only" ? "readOnly" : "dangerFullAccess" }, approvalPolicy: params.approvalPolicy, model: "test" } });
  if (method === "turn/interrupt") {
    clearTimeout(timers.get(params.turnId)); timers.delete(params.turnId);
    send({ id, result: {} });
    send({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    return;
  }
  if (method === "turn/start") {
    const turnId = "turn-" + ++next;
    const prompt = params.input.map((item) => item.text || "").join("\n");
    send({ id, result: { turn: { id: turnId } } });
    send({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { id: "cmd-" + turnId, type: "commandExecution", command: "检查当前工作区", cwd: process.cwd(), status: "completed", aggregatedOutput: "已检查当前文件；没有实施验收。", exitCode: 0 } } });
    timers.set(turnId, setTimeout(() => {
      const text = prompt.includes("<XUANNIAO_PROPOSAL>") ? "<XUANNIAO_PROPOSAL>\n\n## 已采纳结论\n\n采用分块重试，保留客户端兼容性。\n</XUANNIAO_PROPOSAL>" : "### 方案分析\n\n采用分块重试，保留客户端兼容性。\n\n- 先检查当前文件。\n- 验证断点恢复。\n- 记录尚未验证的部分。";
      send({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { id: "answer-" + turnId, type: "agentMessage", text } } });
      send({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      timers.delete(turnId);
    }, prompt.includes("LONG_EXECUTION") ? 10000 : 200));
    return;
  }
  send({ id, result: {} });
});
`;

test("HTTP proposals, executions, references and project previews share one document lifecycle", { timeout: 25000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-outcome-http-"));
  const documentPath = path.join(dir, "plan.md");
  const otherPath = path.join(dir, "rfc.md");
  const original = "# 上传方案\n\n兼容旧客户端，验证断点恢复。\n";
  await writeFile(documentPath, original);
  await writeFile(otherPath, "# RFC\n\n独立依据。\n");
  const fakePath = path.join(dir, "fake-agent.mjs");
  await writeFile(fakePath, fakeOutcomeAgent);
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [serverEntry, documentPath], { cwd: dir, env: { ...process.env, XUANNIAO_DATA_DIR: path.join(dir, "metadata"), XUANNIAO_CODEX_CMD: `${process.execPath} ${fakePath}`, HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  // Resolve browser-relative URLs only; keep the frontend's actual headers/body.
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, options) => nativeFetch(
    typeof input === "string" && input.startsWith("/") ? base + input : input,
    options
  ));
  const request = async (route, body, method = "POST") => {
    const response = await fetch(base + route, body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.ok(response.ok, `${route}: ${JSON.stringify(payload)}\n${logs}`);
    return payload;
  };
  const until = async (predicate) => {
    for (let index = 0; index < 100; index++) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
    throw new Error(`Timed out\n${logs}`);
  };
  try {
    await until(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } });
    let document = await request("/api/document");
    const { thread } = await request("/api/threads", { documentPath, title: "上传方案", selectedText: "兼容旧客户端", anchor: { start: original.indexOf("兼容旧客户端"), end: original.indexOf("兼容旧客户端") + 6 }, expectedRevision: document.revision });
    const reply = await request(`/api/threads/${thread.id}/messages`, { content: "分析上传方案", askAgent: true, agentRunId: "http_first_question" });
    assert.equal(reply.agentOutcome, "completed");
    const source = { kind: "message", documentPath, threadId: thread.id, messageId: reply.assistantMessage.id, start: 0, end: reply.assistantMessage.content.length, revision: revision(reply.assistantMessage.content) };
    const proposalCommand = { kind: "proposal", documentPath, documentRevision: document.revision, source, instruction: "将结论追加到文档", requestKey: "http-proposal-1", target: { mode: "insert", start: original.length, end: original.length, label: "文档末尾" } };
    const started = await request("/api/outcomes", proposalCommand);
    const duplicate = await request("/api/outcomes", proposalCommand);
    assert.equal(started.record.id, duplicate.record.id);
    assert.equal(await readFile(documentPath, "utf8"), original);
    const record = await until(async () => { const state = await request("/api/outcomes"); const item = state.records.find((item) => item.id === started.record.id); return !state.activity && item.status === "review" && item; });
    const applied = await request(`/api/outcomes/${record.id}/apply`, { documentPath, expectedRevision: record.revision });
    const reapplied = await request(`/api/outcomes/${record.id}/apply`, { documentPath, expectedRevision: record.revision });
    assert.equal(applied.document.content, reapplied.document.content);
    assert.equal(applied.document.content.split("## 已采纳结论").length, 2);
    const undone = await request(`/api/outcomes/${record.id}/undo`, { documentPath });
    assert.equal(undone.document.content, original);
    await request("/api/project/documents", { path: otherPath });
    const preview = await request(`/api/project/preview?path=${encodeURIComponent(otherPath)}`);
    assert.equal((await request("/api/document")).path, documentPath);
    const externalRef = { kind: "document", documentPath: otherPath, start: 0, end: preview.document.content.length, revision: preview.document.revision };
    assert.equal((await request("/api/references/incoming")).length, 0);
    const referenceReply = await request(`/api/threads/${thread.id}/messages`, { content: "比较 RFC", askAgent: false, parentMessageId: reply.userMessage.id, references: [externalRef, source] });
    const refs = referenceReply.userMessage.meta.references;
    assert.equal((await request("/api/references/check", { references: refs }))[0].state, "current");
    await writeFile(otherPath, "# RFC\n\n依据改动。\n");
    assert.equal((await request("/api/references/check", { references: refs }))[0].state, "changed");
    assert.equal((await request("/api/references/incoming"))[0].targetMessageId, referenceReply.userMessage.id);
    const afterMessageDeletion = await browserApi.deleteMessage(thread.id, referenceReply.userMessage.id);
    assert.ok(!afterMessageDeletion.threads[0].messages.some((message) => message.id === referenceReply.userMessage.id));
    assert.equal((await request("/api/references/incoming")).length, 0);
    document = await request("/api/document");
    const execution = await request("/api/outcomes", { kind: "execution", documentPath, documentRevision: document.revision, source, instruction: "LONG_EXECUTION 验证恢复", acceptance: "提供测试证据", requestKey: "http-execution-1" });
    const persisted = (await request("/api/outcomes")).records.find((item) => item.id === execution.record.id);
    assert.equal(persisted.instruction, "LONG_EXECUTION 验证恢复");
    const blocked = await fetch(base + "/api/document/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: otherPath }) });
    assert.equal(blocked.status, 409);
    assert.equal((await request(`/api/project/preview?path=${encodeURIComponent(otherPath)}`)).document.path, otherPath);
    await request("/api/agent/stop", { documentPath, operationId: (await request("/api/outcomes")).activity.id });
    const final = await until(async () => { const state = await request("/api/outcomes"); return !state.activity && state; });
    assert.equal(final.records.find((item) => item.id === execution.record.id).status, "interrupted");
    assert.equal(final.records.find((item) => item.id === execution.record.id).verification, "not-checked");
    await writeFile(otherPath, "x".repeat(160_001));
    const grownChecks = await request("/api/references/check", { references: refs });
    assert.equal(grownChecks[0].state, "changed");
    assert.equal(grownChecks[0].latestUnavailableReason, "reference_too_large");
    assert.equal(grownChecks[1].state, "current");
    const link = path.join(dir, "linked-source.md");
    await symlink(otherPath, link);
    await request("/api/project/documents", { path: link });
    const linked = await request(`/api/project/preview?path=${encodeURIComponent(link)}`);
    const linkReference = { id: "linked-history", kind: "document", documentPath: link,
      sourceIdentity: linked.document.referenceIdentity, start: 0, end: 4, content: "xxxx", revision: linked.document.revision };
    await rm(link);
    await symlink(documentPath, link);
    const passive = await request("/api/project/documents", { path: link });
    assert.equal(passive.documents.find((item) => item.path === link).available, false);
    const relinked = await request("/api/project/documents", { path: link, relink: true });
    assert.equal(relinked.documents.find((item) => item.path === link).available, true);
    assert.equal((await request(`/api/project/preview?path=${encodeURIComponent(link)}`)).document.content, original);
    assert.equal((await request("/api/references/check", { references: [linkReference] }))[0].reason, "document_identity_changed");
    assert.equal((await request("/api/document")).path, documentPath);
    const afterThreadDeletion = await browserApi.deleteThread(thread.id);
    assert.deepEqual(afterThreadDeletion.threads, []);
    assert.equal((await request("/api/threads")).threads.length, 0);
    assert.ok((await request("/api/outcomes")).records.some((item) => item.source.messageId === source.messageId));
    assert.ok((await request("/api/project")).documents.some((item) => item.records.length >= 3));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
    await rm(dir, { recursive: true, force: true });
  }
});
