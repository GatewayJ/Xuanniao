import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThreadStore } from "./thread-store.js";

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
