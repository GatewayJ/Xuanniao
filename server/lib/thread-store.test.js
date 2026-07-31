import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { documentMetadataKey, legacyThreadStorePathFor, threadStorePathFor } from "./metadata-paths.js";
import { ThreadStore } from "./thread-store.js";
import { branchRevisionForQuestion } from "./thread-tree.js";

test("thread store paths use the document path sha256 under the metadata root", () => {
  const documentPath = path.join(os.tmpdir(), "xuanniao-docs", "plan.md");
  const metadataRoot = path.join(os.tmpdir(), "xuanniao-home");
  const expectedKey = createHash("sha256").update(path.resolve(documentPath)).digest("hex");

  assert.equal(documentMetadataKey(documentPath), expectedKey);
  assert.equal(threadStorePathFor(documentPath, metadataRoot), path.join(metadataRoot, expectedKey, "threads.json"));
  assert.equal(legacyThreadStorePathFor(documentPath), path.join(path.dirname(documentPath), ".xuanniao", "plan.md.threads.json"));
});

test("agent sessions persist across store instances and legacy ACP sessions migrate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-store-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const firstStore = new ThreadStore(storePath);
    const thread = await firstStore.create({
      title: "Thread",
      selectedText: "selection",
      anchor: { start: 0, end: 9, lineStart: 1, lineEnd: 1, blockId: null }
    });
    const question = await firstStore.addMessage(thread.id, {
      role: "user",
      content: "Question"
    });
    await firstStore.completeAgentTurn(
      thread.id,
      question.id,
      { role: "assistant", content: "Answer" },
      {
        adapter: "codex-app-server",
        sessionId: "session-123",
        turnId: "turn-123",
        documentHash: "hash-123"
      }
    );

    const restored = await new ThreadStore(storePath).get(thread.id);
    assert.deepEqual(restored.messages.find((message) => message.id === question.id).agentSession, {
      adapter: "codex-app-server",
      sessionId: "session-123",
      turnId: "turn-123",
      documentHash: "hash-123"
    });

    await writeFile(
      storePath,
      JSON.stringify({
        version: 2,
        threads: [
          {
            id: "legacy",
            title: "Legacy",
            selectedText: "",
            anchor: {},
            messages: [
              {
                id: "legacy-question",
                role: "user",
                content: "Legacy question",
                nodeId: "legacy-question",
                parentId: null,
                acpSessionId: "legacy-acp-session"
              }
            ]
          }
        ]
      }),
      "utf8"
    );
    const legacy = await new ThreadStore(storePath).get("legacy");
    assert.deepEqual(legacy.messages[0].agentSession, {
      adapter: "acp",
      sessionId: "legacy-acp-session",
      turnId: null,
      documentHash: null
    });

    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        threads: [
          {
            id: "legacy-thread-session",
            title: "Legacy thread session",
            selectedText: "",
            anchor: {},
            acpSessionId: "legacy-thread-acp-session",
            messages: [{ id: "root", role: "user", content: "Root" }]
          }
        ]
      }),
      "utf8"
    );
    const legacyThreadSession = await new ThreadStore(storePath).get("legacy-thread-session");
    assert.equal(legacyThreadSession.messages[0].agentSession.sessionId, "legacy-thread-acp-session");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("anchor synchronization deletes removed threads from the store", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-store-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const kept = await store.create({
      title: "Kept",
      selectedText: "keep",
      anchor: { start: 0, end: 4, lineStart: 1, lineEnd: 1, blockId: null }
    });
    const removed = await store.create({
      title: "Removed",
      selectedText: "remove",
      anchor: { start: 5, end: 11, lineStart: 1, lineEnd: 1, blockId: null }
    });

    const threads = await store.updateAnchors(
      [
        {
          id: kept.id,
          selectedText: "kept",
          anchor: { start: 0, end: 4, lineStart: 1, lineEnd: 1, blockId: null }
        }
      ],
      [removed.id]
    );

    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, kept.id);
    assert.equal(threads[0].selectedText, "kept");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("persists question parent links and deletes an entire child subtree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-tree-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({
      title: "Tree",
      selectedText: "selection",
      anchor: { start: 0, end: 9, lineStart: 1, lineEnd: 1, blockId: null }
    });
    const root = await store.addMessage(thread.id, {
      role: "user",
      content: "Root",
      parentId: null
    });
    await store.addMessage(thread.id, {
      role: "assistant",
      content: "Root answer",
      parentId: root.id
    });
    const child = await store.addMessage(thread.id, {
      role: "user",
      content: "Child",
      parentId: root.id
    });
    await store.addMessage(thread.id, {
      role: "assistant",
      content: "Child answer",
      parentId: child.id
    });
    const grandchild = await store.addMessage(thread.id, {
      role: "user",
      content: "Grandchild",
      parentId: child.id
    });
    await store.addMessage(thread.id, {
      role: "assistant",
      content: "Grandchild answer",
      parentId: grandchild.id
    });
    const sibling = await store.addMessage(thread.id, {
      role: "user",
      content: "Sibling",
      parentId: root.id
    });
    await store.addMessage(thread.id, {
      role: "assistant",
      content: "Sibling answer",
      parentId: sibling.id
    });

    const restored = await new ThreadStore(storePath).get(thread.id);
    assert.equal(restored.messages.find((message) => message.id === child.id).parentId, root.id);
    assert.equal(restored.messages.find((message) => message.id === child.id).nodeId, child.id);
    assert.equal(restored.messages.find((message) => message.id === sibling.id).parentId, root.id);
    assert.equal(restored.messages.filter((message) => message.role === "user" && message.parentId === root.id).length, 2);

    const removed = await store.deleteMessage(thread.id, child.id);
    assert.equal(removed.length, 4);
    assert.deepEqual(
      (await store.get(thread.id)).messages.map((message) => message.content),
      ["Root", "Root answer", "Sibling", "Sibling answer"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizes legacy linear messages into parent-linked questions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-legacy-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        threads: [
          {
            id: "legacy",
            title: "Legacy",
            selectedText: "selection",
            anchor: {},
            messages: [
              { id: "q1", role: "user", content: "One" },
              { id: "a1", role: "assistant", content: "Answer one" },
              { id: "q2", role: "user", content: "Two" },
              { id: "a2", role: "assistant", content: "Answer two" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const thread = await new ThreadStore(storePath).get("legacy");
    assert.deepEqual(
      thread.messages.map((message) => message.parentId),
      [null, "q1", "q1", "q2"]
    );
    assert.deepEqual(
      thread.messages.map((message) => message.nodeId),
      ["q1", "q1", "q2", "q2"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps continued questions in one node and deletes only that turn", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-turn-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({
      title: "Turns",
      selectedText: "selection",
      anchor: {}
    });
    const root = await store.addMessage(thread.id, {
      role: "user",
      content: "Root",
      parentId: null
    });
    await store.addMessage(thread.id, {
      role: "assistant",
      content: "Root answer",
      nodeId: root.nodeId,
      parentId: root.id
    });
    const followUp = await store.addMessage(thread.id, {
      role: "user",
      content: "Continue",
      nodeId: root.nodeId,
      parentId: null
    });
    await store.addMessage(thread.id, {
      role: "assistant",
      content: "Continued answer",
      nodeId: root.nodeId,
      parentId: followUp.id
    });

    assert.equal((await store.get(thread.id)).messages.filter((message) => message.nodeId === root.nodeId).length, 4);
    const removed = await store.deleteMessage(thread.id, followUp.id);
    assert.deepEqual(
      removed.map((message) => message.content),
      ["Continue", "Continued answer"]
    );
    assert.deepEqual(
      (await store.get(thread.id)).messages.map((message) => message.content),
      ["Root", "Root answer"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("persists planning metadata on user questions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-meta-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({
      title: "Planning meta",
      selectedText: "selection",
      anchor: {}
    });
    const question = await store.addMessage(thread.id, {
      role: "user",
      content: "What is risky?",
      meta: {
        branchSelection: { sourceMessageId: "a1", text: "selected text" }
      }
    });

    await store.updateMessageMeta(thread.id, question.id, { nodeKind: "risk" });
    const restored = await new ThreadStore(storePath).get(thread.id);
    assert.deepEqual(restored.messages[0].meta, {
      branchSelection: { sourceMessageId: "a1", text: "selected text" },
      nodeKind: "risk"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("editing a question invalidates its node session and every descendant session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-invalidation-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({
      title: "Invalidation",
      selectedText: "selection",
      anchor: {}
    });
    const root = await store.addMessage(thread.id, {
      role: "user",
      content: "Root"
    });
    const child = await store.addMessage(thread.id, {
      role: "user",
      content: "Child",
      parentId: root.id
    });
    const sibling = await store.addMessage(thread.id, {
      role: "user",
      content: "Sibling",
      parentId: null
    });
    const session = (id) => ({
      adapter: "codex-app-server",
      sessionId: id,
      turnId: `${id}-turn`,
      documentHash: "hash"
    });
    await store.completeAgentTurn(thread.id, root.id, { role: "assistant", content: "Root answer" }, session("root"));
    await store.completeAgentTurn(thread.id, child.id, { role: "assistant", content: "Child answer" }, session("child"));
    await store.completeAgentTurn(thread.id, sibling.id, { role: "assistant", content: "Sibling answer" }, session("sibling"));

    await store.updateMessage(thread.id, root.id, { content: "Edited root" });
    const restored = await store.get(thread.id);
    assert.equal(restored.messages.find((message) => message.id === root.id).agentSession, null);
    assert.equal(restored.messages.find((message) => message.id === child.id).agentSession, null);
    assert.equal(restored.messages.find((message) => message.id === sibling.id).agentSession.sessionId, "sibling");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("serializes concurrent mutations without losing branch messages", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-concurrency-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({ title: "Concurrent", selectedText: "selection", anchor: {} });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.addMessage(thread.id, {
          role: "user",
          content: `Branch ${index}`
        })
      )
    );

    const restored = await store.get(thread.id);
    assert.equal(restored.messages.length, 12);
    assert.deepEqual(
      new Set(restored.messages.map((message) => message.content)),
      new Set(Array.from({ length: 12 }, (_, index) => `Branch ${index}`))
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("anchor reconciliation holds the repository mutation boundary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-anchor-reconcile-lock-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const original = await store.create({ title: "Original", selectedText: "one", anchor: {} });
    let releaseReconciliation;
    const reconciliationBarrier = new Promise((resolve) => {
      releaseReconciliation = resolve;
    });
    let reconciliationStarted;
    const started = new Promise((resolve) => {
      reconciliationStarted = resolve;
    });
    const reconciliation = store.reconcileAnchors(async (threads) => {
      reconciliationStarted();
      await reconciliationBarrier;
      return { patches: threads, deletedThreadIds: [] };
    });
    await started;
    let createFinished = false;
    const create = store.create({ title: "Concurrent", selectedText: "two", anchor: {} })
      .then(() => {
        createFinished = true;
      });

    await Promise.resolve();
    assert.equal(createFinished, false);
    releaseReconciliation();
    await Promise.all([reconciliation, create]);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.get(original.id)).title, "Original");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("serializes mutations across multiple stores for the same file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-multi-store-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const firstStore = new ThreadStore(storePath);
    const secondStore = new ThreadStore(storePath);
    const thread = await firstStore.create({ title: "Shared", selectedText: "selection", anchor: {} });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const store = index % 2 === 0 ? firstStore : secondStore;
        return store.addMessage(thread.id, {
          role: "user",
          content: `Shared branch ${index}`
        });
      })
    );

    const restored = await new ThreadStore(storePath).get(thread.id);
    assert.equal(restored.messages.length, 12);
    assert.deepEqual(
      new Set(restored.messages.map((message) => message.content)),
      new Set(Array.from({ length: 12 }, (_, index) => `Shared branch ${index}`))
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("continuing a parent node invalidates existing child branch sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-continuation-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({ title: "Continuation", selectedText: "selection", anchor: {} });
    const root = await store.addMessage(thread.id, { role: "user", content: "Root" });
    const child = await store.addMessage(thread.id, { role: "user", content: "Child", parentId: root.id });
    const session = (id) => ({
      adapter: "codex-app-server",
      sessionId: id,
      turnId: `${id}-turn`,
      documentHash: "hash"
    });
    await store.completeAgentTurn(thread.id, root.id, { role: "assistant", content: "Root answer" }, session("root"));
    await store.completeAgentTurn(thread.id, child.id, { role: "assistant", content: "Child answer" }, session("child"));

    await store.addMessage(thread.id, {
      role: "user",
      content: "Continue root",
      nodeId: root.id,
      parentId: null
    });
    const restored = await store.get(thread.id);
    assert.equal(restored.messages.find((message) => message.id === root.id).agentSession.sessionId, "root");
    assert.equal(restored.messages.find((message) => message.id === child.id).agentSession, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects an agent result when its conversation branch changed in flight", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-cas-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({ title: "CAS", selectedText: "selection", anchor: {} });
    const root = await store.addMessage(thread.id, { role: "user", content: "Root" });
    const child = await store.addMessage(thread.id, { role: "user", content: "Child", parentId: root.id });
    const revision = branchRevisionForQuestion(await store.get(thread.id), child.id);

    await store.addMessage(thread.id, {
      role: "user",
      content: "Parent changed",
      nodeId: root.id,
      parentId: null
    });
    await assert.rejects(
      store.completeAgentTurn(
        thread.id,
        child.id,
        { role: "assistant", content: "Stale answer" },
        {
          adapter: "codex-app-server",
          sessionId: "stale-session",
          turnId: "stale-turn",
          documentHash: "hash"
        },
        revision
      ),
      /conversation branch changed/
    );

    const restored = await store.get(thread.id);
    assert.equal(restored.messages.some((message) => message.content === "Stale answer"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("anchor reconciliation and agent completion commit in one store mutation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-turn-commit-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({
      title: "Coordinated",
      selectedText: "before",
      anchor: { start: 0, end: 6 }
    });
    const question = await store.addMessage(thread.id, { role: "user", content: "Replace" });
    const revision = branchRevisionForQuestion(await store.get(thread.id), question.id);

    const committed = await store.completeAgentTurnWithAnchorReconciliation({
      threadId: thread.id,
      userMessageId: question.id,
      message: { role: "assistant", content: "Applied" },
      agentSession: null,
      expectedBranchRevision: revision,
      reconcile: async () => ({
        patches: [{
          id: thread.id,
          selectedText: "after",
          anchor: { start: 2, end: 7 }
        }],
        deletedThreadIds: []
      })
    });

    assert.equal(committed.assistantMessage.content, "Applied");
    const restored = await store.get(thread.id);
    assert.equal(restored.selectedText, "after");
    assert.deepEqual(restored.anchor, { start: 2, end: 7 });
    assert.equal(restored.messages.some((message) => message.content === "Applied"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
