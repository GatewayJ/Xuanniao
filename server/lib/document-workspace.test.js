import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentDocumentMutationError, DocumentConflictError, DocumentWorkspace } from "./document-workspace.js";
import { ThreadStore } from "./thread-store.js";
import { branchRevisionForQuestion } from "./thread-tree.js";

function threadStoreStub({ failUpdates = false, failCompletion = false } = {}) {
  return {
    async reconcileAnchors(reconciler) {
      if (failUpdates) throw new Error("anchor update failed");
      await reconciler([]);
      return [];
    },
    async completeAgentTurn(_threadId, _userMessageId, message) {
      if (failCompletion) throw new Error("agent turn commit failed");
      return message;
    },
    async completeAgentTurnWithAnchorReconciliation({ reconcile, message }) {
      await reconcile([]);
      if (failCompletion) throw new Error("agent turn commit failed");
      return { assistantMessage: message, threads: [] };
    }
  };
}

test("document saves require the revision that was originally read", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-document-workspace-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "# Original\n", "utf8");
    const workspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const original = await workspace.payload();
    await writeFile(documentPath, "# External change\n", "utf8");

    await assert.rejects(
      workspace.save({
        content: "# Stale overwrite\n",
        expectedRevision: original.revision,
        anchorPatches: []
      }),
      (error) => error instanceof DocumentConflictError && error.statusCode === 409
    );
    assert.equal(await readFile(documentPath, "utf8"), "# External change\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("thread creation validates the document revision and selected range", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-document-revision-"));
  const documentPath = path.join(tempDir, "plan.md");
  const created = [];
  const store = {
    async create(input) {
      created.push(input);
      return input;
    }
  };

  try {
    await writeFile(documentPath, "# Plan\nnext line\n", "utf8");
    const workspace = new DocumentWorkspace(documentPath, store);
    const document = await workspace.payload();
    await workspace.createThread({
      title: "Plan",
      selectedText: "Plan",
      anchor: { start: 2, end: 6 },
      expectedRevision: document.revision
    });
    assert.equal(created.length, 1);

    await workspace.createThread({
      title: "Multiline",
      selectedText: "Plan next",
      anchor: { start: 2, end: 11 },
      expectedRevision: document.revision
    });
    assert.equal(created[1].selectedText, "Plan\nnext");

    await assert.rejects(
      workspace.createThread({
        title: "Stale",
        selectedText: "wrong",
        anchor: { start: 2, end: 6 },
        expectedRevision: document.revision
      }),
      (error) => error instanceof DocumentConflictError && error.statusCode === 409
    );
    assert.equal(created.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("concurrent document saves cannot both commit the same base revision", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-document-concurrency-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "base", "utf8");
    const firstWorkspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const secondWorkspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const original = await firstWorkspace.payload();
    const results = await Promise.allSettled([
      firstWorkspace.save({ content: "first", expectedRevision: original.revision, anchorPatches: [] }),
      secondWorkspace.save({ content: "second", expectedRevision: original.revision, anchorPatches: [] })
    ]);

    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    assert.ok(["first", "second"].includes(await readFile(documentPath, "utf8")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("document content rolls back when anchor persistence fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-document-rollback-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "before", "utf8");
    const workspace = new DocumentWorkspace(documentPath, threadStoreStub({ failUpdates: true }));
    const original = await workspace.payload();

    await assert.rejects(
      workspace.save({
        content: "after",
        expectedRevision: original.revision,
        anchorPatches: []
      }),
      /anchor update failed/
    );
    assert.equal(await readFile(documentPath, "utf8"), "before");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("unchanged agent turns commit without returning a document update", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-unchanged-agent-turn-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "unchanged", "utf8");
    const workspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const snapshot = await workspace.createAgentSnapshot();
    const result = await workspace.completeAgentTurnFromSnapshot({
      snapshot,
      threadId: "thread-1",
      userMessageId: "question-1",
      message: { role: "assistant", content: "answer", meta: {} },
      agentSession: null,
      expectedBranchRevision: "branch-revision"
    });

    assert.equal(result.document, null);
    assert.equal(result.changed, false);
    assert.equal(result.assistantMessage.meta.appliedEdit, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("direct document edits outside the discussion root preserve its anchor", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-direct-document-edit-"));
  const documentPath = path.join(tempDir, "plan.md");
  const content = "Feishu / Lark\n\n```mermaid\ngraph TD\n  A --> B\n```\n";
  const thread = {
    id: "thread-1",
    selectedText: "Feishu / Lark",
    anchor: { start: 0, end: 13, lineStart: 1, lineEnd: 1, blockId: null }
  };
  let savedPatches = [];
  const store = {
    async completeAgentTurnWithAnchorReconciliation({ reconcile, message }) {
      const update = await reconcile([thread]);
      savedPatches = update.patches;
      return { assistantMessage: message, threads: update.patches };
    }
  };

  try {
    await writeFile(documentPath, content, "utf8");
    const workspace = new DocumentWorkspace(documentPath, store);
    const snapshot = await workspace.createAgentSnapshot();
    await writeFile(documentPath, content.replace("  A --> B", "  A --> B\n  B --> C"), "utf8");
    const result = await workspace.completeAgentTurnFromSnapshot({
      snapshot,
      threadId: thread.id,
      userMessageId: "question-1",
      message: { role: "assistant", content: "updated", meta: {} },
      agentSession: null,
      expectedBranchRevision: "branch-revision"
    });

    assert.match(result.document.content, /B --> C/);
    assert.equal(result.assistantMessage.meta.appliedEdit, true);
    assert.equal(savedPatches[0].selectedText, "Feishu / Lark");
    assert.equal(savedPatches[0].anchor.start, 0);
    assert.equal(savedPatches[0].anchor.end, 13);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("direct edits preserve the active discussion root when its selected text changes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-active-root-edit-"));
  const documentPath = path.join(tempDir, "plan.md");
  const content = "before selected text after";
  const thread = {
    id: "thread-1",
    selectedText: "selected text",
    anchor: { start: 7, end: 20, lineStart: 1, lineEnd: 1, blockId: null }
  };
  let savedPatches = [];
  const store = {
    async completeAgentTurnWithAnchorReconciliation({ reconcile, message }) {
      const update = await reconcile([thread]);
      savedPatches = update.patches;
      return { assistantMessage: message, threads: update.patches };
    }
  };

  try {
    await writeFile(documentPath, content, "utf8");
    const workspace = new DocumentWorkspace(documentPath, store);
    const snapshot = await workspace.createAgentSnapshot();
    await writeFile(documentPath, "before improved text after", "utf8");
    await workspace.completeAgentTurnFromSnapshot({
      snapshot,
      threadId: thread.id,
      userMessageId: "question-1",
      message: { role: "assistant", content: "updated", meta: {} },
      agentSession: null,
      expectedBranchRevision: "branch-revision"
    });

    assert.equal(savedPatches[0].selectedText, "improved text");
    assert.equal(savedPatches[0].anchor.start, 7);
    assert.equal(savedPatches[0].anchor.end, 20);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("separate direct edits remap an unchanged discussion anchor through every change", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-multiple-direct-edits-"));
  const documentPath = path.join(tempDir, "plan.md");
  const content = "alpha root omega";
  const thread = {
    id: "thread-1",
    selectedText: "root",
    anchor: { start: 6, end: 10, lineStart: 1, lineEnd: 1, blockId: null }
  };
  let savedPatches = [];
  const store = {
    async completeAgentTurnWithAnchorReconciliation({ reconcile, message }) {
      const update = await reconcile([thread]);
      savedPatches = update.patches;
      return { assistantMessage: message, threads: update.patches };
    }
  };

  try {
    await writeFile(documentPath, content, "utf8");
    const workspace = new DocumentWorkspace(documentPath, store);
    const snapshot = await workspace.createAgentSnapshot();
    await writeFile(documentPath, "alphabet root end", "utf8");
    const result = await workspace.completeAgentTurnFromSnapshot({
      snapshot,
      threadId: thread.id,
      userMessageId: "question-1",
      message: { role: "assistant", content: "updated", meta: {} },
      agentSession: null,
      expectedBranchRevision: "branch-revision"
    });

    assert.equal(result.document.content, "alphabet root end");
    assert.equal(savedPatches[0].selectedText, "root");
    assert.equal(savedPatches[0].anchor.start, 9);
    assert.equal(savedPatches[0].anchor.end, 13);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a failed metadata commit does not overwrite a direct Codex edit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-direct-edit-commit-failure-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "before", "utf8");
    const workspace = new DocumentWorkspace(
      documentPath,
      threadStoreStub({ failCompletion: true })
    );
    const snapshot = await workspace.createAgentSnapshot();
    await writeFile(documentPath, "after", "utf8");

    await assert.rejects(
      workspace.completeAgentTurnFromSnapshot({
        snapshot,
        threadId: "thread-1",
        userMessageId: "question-1",
        message: { role: "assistant", content: "answer" },
        agentSession: null,
        expectedBranchRevision: "branch-revision"
      }),
      /agent turn commit failed/
    );
    assert.equal(await readFile(documentPath, "utf8"), "after");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent turns for the same document are serialized", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-agent-turn-lock-"));
  const documentPath = path.join(tempDir, "plan.md");
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];

  try {
    await writeFile(documentPath, "document", "utf8");
    const firstWorkspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const secondWorkspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const first = firstWorkspace.withAgentTurn(async () => {
      order.push("first-start");
      firstStarted();
      await firstGate;
      order.push("first-end");
    });
    await firstStartedPromise;
    const second = secondWorkspace.withAgentTurn(async () => {
      order.push("second-start");
      order.push("second-end");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a controlled save during an agent turn is not attributed to Codex", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-agent-save-conflict-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "before", "utf8");
    const workspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const concurrentWorkspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const snapshot = await workspace.createAgentSnapshot();
    await concurrentWorkspace.save({
      content: "user save",
      expectedRevision: snapshot.revision
    });
    await writeFile(documentPath, "later file write", "utf8");

    await assert.rejects(
      workspace.completeAgentTurnFromSnapshot({
        snapshot,
        threadId: "thread-1",
        userMessageId: "question-1",
        message: { role: "assistant", content: "answer" },
        agentSession: null,
        expectedBranchRevision: "branch-revision"
      }),
      (error) => (
        error instanceof AgentDocumentMutationError &&
        error.document.content === "later file write"
      )
    );
    assert.equal(await readFile(documentPath, "utf8"), "later file write");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("document saves canonicalize client anchor proposals against saved content", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-document-anchors-"));
  const documentPath = path.join(tempDir, "plan.md");
  const thread = {
    id: "thread-1",
    selectedText: "selected",
    anchor: {
      start: 7,
      end: 15,
      lineStart: 1,
      lineEnd: 1,
      blockId: null
    }
  };
  let savedPatches = [];
  const store = {
    async reconcileAnchors(reconciler) {
      const update = await reconciler([thread]);
      savedPatches = update.patches;
      return update.patches;
    }
  };

  try {
    await writeFile(documentPath, "before selected after", "utf8");
    const workspace = new DocumentWorkspace(documentPath, store);
    const original = await workspace.payload();
    const content = "prefix before selected after";
    const selectedStart = content.indexOf("selected");

    const result = await workspace.save({
      content,
      expectedRevision: original.revision,
      anchorPatches: [{
        id: thread.id,
        selectedText: "untrusted value",
        anchor: {
          start: selectedStart,
          end: selectedStart + "selected".length,
          lineStart: 999,
          lineEnd: 999,
          blockId: null
        }
      }]
    });

    assert.equal(result.threads[0].selectedText, "selected");
    assert.equal(savedPatches[0].anchor.start, selectedStart);
    assert.equal(savedPatches[0].anchor.lineStart, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent snapshots preserve unclassified external writes and report a conflict", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-agent-document-guard-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "protected", "utf8");
    const workspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const snapshot = await workspace.createAgentSnapshot();
    await writeFile(documentPath, "agent overwrite", "utf8");

    await assert.rejects(
      workspace.verifyAgentSnapshot(snapshot),
      (error) => (
        error instanceof AgentDocumentMutationError &&
        error.code === "AGENT_DOCUMENT_MUTATION" &&
        error.document.content === "agent overwrite"
      )
    );
    assert.equal(await readFile(documentPath, "utf8"), "agent overwrite");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("agent snapshots never overwrite an unknown write after a controlled save", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-agent-document-race-"));
  const documentPath = path.join(tempDir, "plan.md");

  try {
    await writeFile(documentPath, "protected", "utf8");
    const workspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const concurrentWorkspace = new DocumentWorkspace(documentPath, threadStoreStub());
    const snapshot = await workspace.createAgentSnapshot();
    await concurrentWorkspace.save({
      content: "user save",
      expectedRevision: snapshot.revision
    });
    await writeFile(documentPath, "agent overwrite", "utf8");

    await assert.rejects(
      workspace.verifyAgentSnapshot(snapshot),
      (error) => error instanceof AgentDocumentMutationError
    );
    assert.equal(await readFile(documentPath, "utf8"), "agent overwrite");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("relinked document identity survives save, reconciliation and agent conflict payloads", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-document-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "document.md");
  await writeFile(file, "Original\n");
  const workspace = new DocumentWorkspace(file, threadStoreStub());
  workspace.referenceIdentity = "new-registration-identity";
  workspace.referenceIdentityRequired = true;
  const check = (document) => {
    assert.equal(document.referenceIdentity, workspace.referenceIdentity);
    assert.equal(document.referenceIdentityRequired, true);
    assert.equal(document.path, file);
    return true;
  };
  check(await workspace.payload());
  const snapshot = await workspace.createAgentSnapshot();
  check(snapshot.document);
  const saved = await workspace.save({ content: "Controlled save\n", expectedRevision: snapshot.revision });
  check(saved.document);
  check(await workspace.verifyAgentSnapshot(snapshot));
  const unchanged = await workspace.save({ content: saved.document.content, expectedRevision: saved.document.revision });
  check(unchanged.document);
  const turn = (before) => workspace.completeAgentTurnFromSnapshot({ snapshot: before, threadId: "thread", userMessageId: "question",
    message: { role: "assistant", content: "Updated" }, agentSession: null, expectedBranchRevision: "revision" });
  await assert.rejects(turn(snapshot), (error) => error.code === "AGENT_DOCUMENT_MUTATION" && check(error.document));
  await writeFile(file, "Concurrent edit\n");
  await assert.rejects(workspace.verifyAgentSnapshot(snapshot), (error) => error.code === "AGENT_DOCUMENT_MUTATION" && check(error.document));
  const fresh = await workspace.createAgentSnapshot();
  await writeFile(file, "Agent change\n");
  await assert.rejects(workspace.verifyAgentSnapshot(fresh), (error) => error.code === "AGENT_DOCUMENT_MUTATION" && check(error.document));
  const completed = await turn(fresh);
  assert.equal(completed.changed, true);
  assert.equal(completed.document.content, "Agent change\n");
  check(completed.document);
});

async function discussionFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-orphan-workspace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const documentPath = path.join(dir, "plan.md");
  const content = "before selected after\n\nnew target";
  await writeFile(documentPath, content);
  const store = new ThreadStore(path.join(dir, "threads.json"));
  const workspace = new DocumentWorkspace(documentPath, store);
  const document = await workspace.payload();
  const thread = await workspace.createThread({ title: "Original", selectedText: "selected", anchor: { start: 7, end: 15, lineStart: 1, lineEnd: 1, blockId: "old-block" }, expectedRevision: document.revision });
  const source = { id: "ref", kind: "document", documentPath, title: "Original source", start: 7, end: 15, content: "selected", revision: document.revision };
  const question = await store.addMessage(thread.id, { role: "user", content: "Original question", meta: { references: [source] } });
  const checkpoint = { adapter: "codex-app-server", sessionId: "saved-session", turnId: "saved-turn", documentHash: document.revision };
  await store.completeAgentTurn(thread.id, question.id, { role: "assistant", content: "Original answer", meta: { verification: "passed" } }, checkpoint);
  const outcomesPath = path.join(dir, "outcomes.json");
  const outcomes = JSON.stringify({ version: 1, documentPath, records: [{ id: "applied", kind: "proposal", status: "applied", source }, { id: "execution", kind: "execution", status: "completed", source }] });
  await writeFile(outcomesPath, outcomes);
  return { dir, documentPath, workspace, store, document, thread: await store.get(thread.id), question, source, checkpoint, outcomesPath, outcomes };
}

test("independent discussions from an orphan reuse the saved source snapshot without a valid document anchor", async (t) => {
  const { workspace, store, document, thread } = await discussionFixture(t);
  const saved = await workspace.save({ content: "replacement", expectedRevision: document.revision });
  const orphan = await store.get(thread.id);
  assert.equal(orphan.orphaned, true);
  const command = { title: "Independent", independent: true, contextScope: "references", sourceThreadId: thread.id, expectedRevision: saved.document.revision };
  const independent = await workspace.createThread(command);
  const second = await workspace.createThread({ ...command, selectedText: "client-forged", anchor: { start: 0, end: "replacement".length } });
  for (const created of [independent, second]) {
    assert.notEqual(created.id, thread.id);
    assert.equal(created.sourceThreadId, thread.id);
    assert.equal(created.selectedText, thread.selectedText);
    assert.equal(created.contextScope, "references");
    assert.equal(created.independent, true);
    assert.equal(created.orphaned, true);
    assert.deepEqual(created.anchor, { ...thread.anchor, start: null, end: null, lineStart: null, lineEnd: null, blockId: null });
    assert.deepEqual(created.messages, []);
    assert.equal(created.agentSession, undefined);
    assert.equal((await new ThreadStore(store.filePath).get(created.id)).orphaned, true);
  }
  assert.notEqual(independent.id, second.id);
  assert.deepEqual((await store.get(thread.id)).messages, thread.messages);
  await assert.rejects(workspace.createThread({ ...command, expectedRevision: document.revision }), { code: "DOCUMENT_CONFLICT" });
  await assert.rejects(workspace.createThread({ ...command, contextScope: "invalid" }), { code: "DOCUMENT_CONFLICT" });
  await assert.rejects(workspace.createThread({ ...command, sourceThreadId: "not-found" }), /thread not found/);
  await assert.rejects(workspace.createThread({ ...command, independent: false, contextScope: "full" }), { code: "DOCUMENT_CONFLICT" });
});

test("ordinary document saves cannot reactivate an orphan via stale proposals, restored text or legacy deleted IDs", async (t) => {
  const { workspace, store, document, thread, outcomesPath, outcomes } = await discussionFixture(t);
  const detached = await workspace.save({ content: document.content, expectedRevision: document.revision, deletedThreadIds: [thread.id], anchorPatches: [{ ...thread, orphaned: false }] });
  assert.equal(detached.threads.length, 1);
  assert.equal(detached.threads[0].orphaned, true);
  const rewritten = await workspace.save({ content: "", expectedRevision: detached.document.revision });
  const restored = await workspace.save({ content: document.content, expectedRevision: rewritten.document.revision, anchorPatches: [{ ...thread, orphaned: false, selectedText: "forged" }] });
  const historical = restored.threads[0];
  assert.equal(historical.orphaned, true);
  assert.equal(historical.anchor.start, null);
  assert.equal(historical.selectedText, thread.selectedText);
  assert.deepEqual(historical.messages, thread.messages);
  assert.equal(await readFile(outcomesPath, "utf8"), outcomes);
  const fresh = await workspace.createThread({ title: "Fresh", selectedText: thread.selectedText, anchor: thread.anchor, expectedRevision: restored.document.revision });
  assert.notEqual(fresh.id, thread.id);
  assert.equal((await store.get(thread.id)).orphaned, true);
});

test("explicit reanchor changes only the location while preserving messages, reference snapshots, results and checkpoints", async (t) => {
  const { workspace, store, document, thread, outcomesPath, outcomes } = await discussionFixture(t);
  const saved = await workspace.save({ content: "# New\n\nnew target", expectedRevision: document.revision });
  const before = await store.get(thread.id);
  const baseRevision = branchRevisionForQuestion(before, before.messages[0].id);
  const start = saved.document.content.indexOf("new target");
  const rebound = await workspace.reanchor(thread.id, { start, end: start + 10, expectedRevision: saved.document.revision });
  const current = rebound.find((item) => item.id === thread.id);
  assert.equal(current.id, before.id);
  assert.equal(current.orphaned, false);
  assert.equal(current.selectedText, "new target");
  assert.equal(current.anchor.lineStart, 3);
  assert.equal(current.anchor.blockId, saved.document.blocks.find((block) => block.lineStart === 3).id);
  assert.equal(current.anchor.contextBefore, "# New\n\n");
  assert.deepEqual(current.messages, before.messages);
  assert.equal(branchRevisionForQuestion(current, current.messages[0].id), baseRevision);
  assert.equal(await readFile(outcomesPath, "utf8"), outcomes);
  const reloaded = await new ThreadStore(store.filePath).get(thread.id);
  assert.equal(reloaded.orphaned, false);
  assert.deepEqual(reloaded.messages, before.messages);
  assert.equal((await workspace.save({ content: saved.document.content, expectedRevision: saved.document.revision })).threads[0].orphaned, false);
});

test("failed reanchor validation leaves the historical thread and Markdown unchanged", async (t) => {
  const { workspace, store, document, thread, outcomesPath, outcomes } = await discussionFixture(t);
  const saved = await workspace.save({ content: "new", expectedRevision: document.revision });
  const before = await store.get(thread.id);
  for (const command of [
    { start: 0, end: 1, expectedRevision: document.revision },
    { start: -1, end: 1, expectedRevision: saved.document.revision },
    { start: 0, end: 0, expectedRevision: saved.document.revision },
    { start: 0, end: 4, expectedRevision: saved.document.revision },
    { start: 0.5, end: 2, expectedRevision: saved.document.revision }
  ]) await assert.rejects(workspace.reanchor(thread.id, command), { code: "DOCUMENT_CONFLICT" });
  await assert.rejects(workspace.reanchor("missing", { start: 0, end: 1, expectedRevision: saved.document.revision }), /thread not found/);
  assert.deepEqual(await store.get(thread.id), before);
  assert.equal((await workspace.payload()).content, "new");
  assert.equal(await readFile(outcomesPath, "utf8"), outcomes);
  await assert.rejects(workspace.createThread({ selectedText: "new", anchor: { start: 0, end: 100 }, expectedRevision: saved.document.revision }), { code: "DOCUMENT_CONFLICT" });
});

test("deleting the source file does not erase discussion snapshots, messages, results or checkpoints", async (t) => {
  const { workspace, store, documentPath, document, thread, outcomesPath, outcomes } = await discussionFixture(t);
  await rm(documentPath);
  await assert.rejects(workspace.payload(), { code: "ENOENT" });
  await assert.rejects(workspace.save({ content: "replacement", expectedRevision: document.revision }), { code: "ENOENT" });
  await assert.rejects(workspace.reanchor(thread.id, { start: 0, end: 1, expectedRevision: document.revision }), { code: "ENOENT" });
  assert.deepEqual(await new ThreadStore(store.filePath).get(thread.id), thread);
  assert.equal(await readFile(outcomesPath, "utf8"), outcomes);
  await assert.rejects(readFile(documentPath), { code: "ENOENT" });
});

test("agent completion after deleting its root keeps the answer and checkpoint on the orphaned thread", async (t) => {
  const { workspace, store, documentPath, thread, outcomesPath, outcomes } = await discussionFixture(t);
  const question = await store.addMessage(thread.id, { role: "user", content: "Remove the whole source", nodeId: thread.messages[0].id });
  const before = await store.get(thread.id);
  const snapshot = await workspace.createAgentSnapshot();
  await writeFile(documentPath, "");
  const checkpoint = { adapter: "codex-app-server", sessionId: "new-session", turnId: "new-turn", documentHash: "empty" };
  const result = await workspace.completeAgentTurnFromSnapshot({ snapshot, threadId: thread.id, userMessageId: question.id, message: { role: "assistant", content: "Removed source", meta: {} }, agentSession: checkpoint, expectedBranchRevision: branchRevisionForQuestion(before, question.id) });
  assert.equal(result.changed, true);
  assert.equal(result.threads[0].orphaned, true);
  assert.equal(result.threads[0].selectedText, thread.selectedText);
  assert.equal(result.threads[0].messages.at(-1).content, "Removed source");
  assert.equal(result.threads[0].messages.find((item) => item.id === question.nodeId).agentSession.sessionId, checkpoint.sessionId);
  assert.equal(await readFile(outcomesPath, "utf8"), outcomes);
});

test("reanchor cannot overwrite a message appended after the source thread was read", async (t) => {
  const { workspace, store, document, thread } = await discussionFixture(t);
  const saved = await workspace.save({ content: "new target", expectedRevision: document.revision });
  let release;
  let announce;
  const barrier = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { announce = resolve; });
  const updateAnchors = store.updateAnchors.bind(store);
  store.updateAnchors = async (...args) => { announce(); await barrier; return updateAnchors(...args); };
  const reanchoring = workspace.reanchor(thread.id, { start: 0, end: 10, expectedRevision: saved.document.revision });
  await started;
  try {
    const concurrent = await store.addMessage(thread.id, { role: "user", content: "Concurrent question" });
    release();
    await reanchoring;
    const current = await store.get(thread.id);
    assert.equal(current.orphaned, false);
    assert.equal(current.messages.some((message) => message.id === concurrent.id), true);
    assert.deepEqual(current.messages.slice(0, thread.messages.length), thread.messages);
  } finally { release(); }
});
