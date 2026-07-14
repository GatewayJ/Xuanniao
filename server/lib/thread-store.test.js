import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
