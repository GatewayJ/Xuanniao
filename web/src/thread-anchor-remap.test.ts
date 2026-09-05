import assert from "node:assert/strict";
import test from "node:test";
import { ChangeSet } from "@codemirror/state";
import { remapThreadsForChange } from "./thread-anchor-remap.ts";
import { resolveThreadAnchor } from "./thread-anchors.ts";
import type { Thread } from "./types.ts";

function makeThread(content: string, selectedText: string, id = "thread-1"): Thread {
  const start = content.indexOf(selectedText);
  const end = start + selectedText.length;
  return {
    id,
    title: selectedText,
    selectedText,
    anchor: {
      start,
      end,
      lineStart: content.slice(0, start).split(/\r?\n/).length,
      lineEnd: content.slice(0, end).split(/\r?\n/).length,
      blockId: null
    },
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

test("moves a thread down when content is inserted before its line", () => {
  const previous = "first\nselected\nlast";
  const thread = makeThread(previous, "selected");
  const changes = ChangeSet.of({ from: 0, insert: "new first\n" }, previous.length);
  const content = "new first\nfirst\nselected\nlast";

  const result = remapThreadsForChange([thread], previous, content, changes);

  assert.deepEqual(result.deletedThreadIds, []);
  assert.equal(result.threads[0].anchor.lineStart, 3);
  assert.equal(result.threads[0].selectedText, "selected");
});

test("expands a thread when text is inserted inside its selected range", () => {
  const previous = "abcdef";
  const thread = makeThread(previous, "bcd");
  const changes = ChangeSet.of({ from: 2, insert: "XY" }, previous.length);
  const content = "abXYcdef";

  const result = remapThreadsForChange([thread], previous, content, changes, thread.id);

  assert.equal(result.threads[0].selectedText, "bXYcd");
  assert.equal(result.threads[0].anchor.start, 1);
  assert.equal(result.threads[0].anchor.end, 6);
});

test("keeps a thread on a non-empty replacement of its entire selection", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected");
  const changes = ChangeSet.of(
    {
      from: thread.anchor.start!,
      to: thread.anchor.end!,
      insert: "replacement"
    },
    previous.length
  );
  const content = "before replacement after";

  const result = remapThreadsForChange([thread], previous, content, changes, thread.id);

  assert.deepEqual(result.deletedThreadIds, []);
  assert.equal(result.threads[0].selectedText, "replacement");
});

test("orphans a thread and retains its source snapshot when the entire selection is deleted", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected");
  const changes = ChangeSet.of({ from: thread.anchor.start!, to: thread.anchor.end!, insert: "" }, previous.length);
  const content = "before  after";

  const result = remapThreadsForChange([thread], previous, content, changes);

  assert.equal(result.threads[0].selectedText, thread.selectedText);
  assert.equal(result.threads[0].orphaned, true);
  assert.equal(result.threads[0].anchor.start, null);
  assert.deepEqual(result.deletedThreadIds, []);
});

test("retains another thread as orphaned when its range is covered by a wider replacement", () => {
  const previous = "before first second after";
  const first = makeThread(previous, "first", "first");
  const second = makeThread(previous, "second", "second");
  const changes = ChangeSet.of(
    {
      from: first.anchor.start!,
      to: previous.indexOf(" after"),
      insert: "replacement"
    },
    previous.length
  );
  const content = "before replacement after";

  const result = remapThreadsForChange([first, second], previous, content, changes, first.id);

  assert.deepEqual(
    result.threads.map((thread) => thread.id),
    [first.id, second.id]
  );
  assert.equal(result.threads[1].selectedText, "second");
  assert.equal(result.threads[1].orphaned, true);
  assert.deepEqual(result.deletedThreadIds, []);
});

test("recovers a stale anchor from selected text nearest to its saved line", () => {
  const content = "wrong\nline two\nselected\nlast";
  const thread = makeThread(content, "selected");
  thread.anchor.start = 0;
  thread.anchor.end = 5;
  const changes = ChangeSet.of([], content.length);

  const result = remapThreadsForChange([thread], content, content, changes);

  assert.deepEqual(result.deletedThreadIds, []);
  assert.equal(result.threads[0].anchor.lineStart, 3);
  assert.equal(result.threads[0].selectedText, "selected");
});

test("uses anchor context to recover the intended duplicate on the same line", () => {
  const previous = "foofoo";
  const thread = makeThread(previous, "foo");
  thread.anchor.start = 3;
  thread.anchor.end = 6;
  thread.anchor.contextBefore = "foo";
  thread.anchor.contextAfter = "";

  const location = resolveThreadAnchor("123foofoo", thread);

  assert.equal(location?.start, 6);
  assert.equal(location?.end, 9);
});

test("editor remapping never restores orphaned threads, even after undo or a preserved replacement", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected");
  thread.messages = [{ id: "q", role: "user", content: "Keep history", createdAt: "now", agentSession: { adapter: "codex-app-server", sessionId: "checkpoint", turnId: "t", documentHash: "hash" } }];
  const removed = remapThreadsForChange([thread], previous, "", ChangeSet.of({ from: 0, to: previous.length, insert: "" }, previous.length), thread.id);
  const restored = remapThreadsForChange(removed.threads, "", previous, ChangeSet.of({ from: 0, insert: previous }, 0), thread.id);
  assert.equal(restored.threads[0].orphaned, true);
  assert.equal(restored.threads[0].selectedText, "selected");
  assert.deepEqual(restored.threads[0].messages, thread.messages);
  assert.equal(resolveThreadAnchor(previous, restored.threads[0]), null);
  assert.deepEqual(restored.deletedThreadIds, []);
  const inconsistent = { ...thread, orphaned: true };
  const normalized = remapThreadsForChange([inconsistent], previous, previous, ChangeSet.of([], previous.length));
  assert.deepEqual(normalized.threads[0].anchor, { start: null, end: null, lineStart: null, lineEnd: null, blockId: null });
});

test("server and editor remaps agree at replacement boundaries and partial overlaps", async () => {
  const modulePath = "../../server/lib/thread-anchor-remap.js";
  const { remapThreadsForReplacement } = await import(modulePath);
  const previous = "0123456789";
  const thread = makeThread(previous, "345");
  for (const [start, end, replacement] of [
    [3, 3, "XX"], [6, 6, "XX"], [4, 4, "XX"], [1, 4, "XX"], [5, 8, "XX"],
    [3, 4, "XX"], [5, 6, "XX"], [3, 6, "XX"], [3, 6, ""], [0, 10, ""], [0, 10, "whole"]
  ] as const) {
    const content = previous.slice(0, start) + replacement + previous.slice(end);
    const changes = ChangeSet.of({ from: start, to: end, insert: replacement }, previous.length);
    for (const preserved of [null, thread.id]) {
      const server = remapThreadsForReplacement([thread], previous, { start, end, replacement, content }, preserved).threads[0] as Thread;
      const client = remapThreadsForChange([thread], previous, content, changes, preserved).threads[0];
      assert.deepEqual({ text: server.selectedText, start: server.anchor.start, end: server.anchor.end, orphaned: !!server.orphaned },
        { text: client.selectedText, start: client.anchor.start, end: client.anchor.end, orphaned: !!client.orphaned }, `${start}:${end}:${replacement}:${preserved}`);
    }
  }
});
