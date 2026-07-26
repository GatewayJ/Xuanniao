import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { documentMetadataKey, legacyThreadStorePathFor, threadStorePathFor } from "./metadata-paths.js";
import { ThreadStore } from "./thread-store.js";

test("thread store paths use the document path sha256 under the metadata root", () => {
  const documentPath = path.join(os.tmpdir(), "xuanniao-docs", "plan.md");
  const metadataRoot = path.join(os.tmpdir(), "xuanniao-home");
  const expectedKey = createHash("sha256").update(path.resolve(documentPath)).digest("hex");

  assert.equal(documentMetadataKey(documentPath), expectedKey);
  assert.equal(threadStorePathFor(documentPath, metadataRoot), path.join(metadataRoot, expectedKey, "threads.json"));
  assert.equal(legacyThreadStorePathFor(documentPath), path.join(path.dirname(documentPath), ".xuanniao", "plan.md.threads.json"));
});

test("thread ACP session IDs persist across store instances", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-store-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const firstStore = new ThreadStore(storePath);
    const thread = await firstStore.create({
      title: "Thread",
      selectedText: "selection",
      anchor: { start: 0, end: 9, lineStart: 1, lineEnd: 1, blockId: null }
    });
    assert.equal(thread.acpSessionId, null);
    await firstStore.updateThread(thread.id, { acpSessionId: "session-123" });

    const restored = await new ThreadStore(storePath).get(thread.id);
    assert.equal(restored.acpSessionId, "session-123");
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

    const threads = await store.updateAnchors([{
      id: kept.id,
      selectedText: "kept",
      anchor: { start: 0, end: 4, lineStart: 1, lineEnd: 1, blockId: null }
    }], [removed.id]);

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
    const root = await store.addMessage(thread.id, { role: "user", content: "Root", parentId: null });
    await store.addMessage(thread.id, { role: "assistant", content: "Root answer", parentId: root.id });
    const child = await store.addMessage(thread.id, { role: "user", content: "Child", parentId: root.id });
    await store.addMessage(thread.id, { role: "assistant", content: "Child answer", parentId: child.id });
    const grandchild = await store.addMessage(thread.id, { role: "user", content: "Grandchild", parentId: child.id });
    await store.addMessage(thread.id, { role: "assistant", content: "Grandchild answer", parentId: grandchild.id });
    const sibling = await store.addMessage(thread.id, { role: "user", content: "Sibling", parentId: root.id });
    await store.addMessage(thread.id, { role: "assistant", content: "Sibling answer", parentId: sibling.id });

    const restored = await new ThreadStore(storePath).get(thread.id);
    assert.equal(restored.messages.find((message) => message.id === child.id).parentId, root.id);
    assert.equal(restored.messages.find((message) => message.id === child.id).nodeId, child.id);
    assert.equal(restored.messages.find((message) => message.id === sibling.id).parentId, root.id);
    assert.equal(restored.messages.filter((message) => message.role === "user" && message.parentId === root.id).length, 2);

    const removed = await store.deleteMessage(thread.id, child.id);
    assert.equal(removed.length, 4);
    assert.deepEqual((await store.get(thread.id)).messages.map((message) => message.content), [
      "Root",
      "Root answer",
      "Sibling",
      "Sibling answer"
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizes legacy linear messages into parent-linked questions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-legacy-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    await writeFile(storePath, JSON.stringify({
      version: 1,
      threads: [{
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
      }]
    }), "utf8");

    const thread = await new ThreadStore(storePath).get("legacy");
    assert.deepEqual(thread.messages.map((message) => message.parentId), [null, "q1", "q1", "q2"]);
    assert.deepEqual(thread.messages.map((message) => message.nodeId), ["q1", "q1", "q2", "q2"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps continued questions in one node and deletes only that turn", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-turn-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({ title: "Turns", selectedText: "selection", anchor: {} });
    const root = await store.addMessage(thread.id, { role: "user", content: "Root", parentId: null });
    await store.addMessage(thread.id, { role: "assistant", content: "Root answer", nodeId: root.nodeId, parentId: root.id });
    const followUp = await store.addMessage(thread.id, { role: "user", content: "Continue", nodeId: root.nodeId, parentId: null });
    await store.addMessage(thread.id, { role: "assistant", content: "Continued answer", nodeId: root.nodeId, parentId: followUp.id });

    assert.equal((await store.get(thread.id)).messages.filter((message) => message.nodeId === root.nodeId).length, 4);
    const removed = await store.deleteMessage(thread.id, followUp.id);
    assert.deepEqual(removed.map((message) => message.content), ["Continue", "Continued answer"]);
    assert.deepEqual((await store.get(thread.id)).messages.map((message) => message.content), ["Root", "Root answer"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("inserts a continuation node before every existing child subtree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-thread-insert-test-"));
  const storePath = path.join(tempDir, "threads.json");

  try {
    const store = new ThreadStore(storePath);
    const thread = await store.create({ title: "Inserted continuation", selectedText: "selection", anchor: {} });
    const root = await store.addMessage(thread.id, { role: "user", content: "A", parentId: null });
    const child = await store.addMessage(thread.id, { role: "user", content: "C", parentId: root.id });
    const grandchild = await store.addMessage(thread.id, { role: "user", content: "C1", parentId: child.id });
    const sibling = await store.addMessage(thread.id, { role: "user", content: "C2", parentId: root.id });

    const inserted = await store.insertNodeAfter(thread.id, root.id, { role: "user", content: "B" });
    const restored = await store.get(thread.id);

    assert.equal(inserted.parentId, root.id);
    assert.equal(inserted.nodeId, inserted.id);
    assert.equal(restored.messages.find((message) => message.id === child.id).parentId, inserted.id);
    assert.equal(restored.messages.find((message) => message.id === sibling.id).parentId, inserted.id);
    assert.equal(restored.messages.find((message) => message.id === grandchild.id).parentId, child.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
