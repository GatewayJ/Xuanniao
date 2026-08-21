import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentDocumentMutationError, DocumentConflictError, DocumentWorkspace } from "./document-workspace.js";

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
