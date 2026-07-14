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
    acpSessionId: null,
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
  const changes = ChangeSet.of({ from: thread.anchor.start!, to: thread.anchor.end!, insert: "replacement" }, previous.length);
  const content = "before replacement after";

  const result = remapThreadsForChange([thread], previous, content, changes, thread.id);

  assert.deepEqual(result.deletedThreadIds, []);
  assert.equal(result.threads[0].selectedText, "replacement");
});

test("deletes a thread when its entire selected range is deleted", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected");
  const changes = ChangeSet.of({ from: thread.anchor.start!, to: thread.anchor.end!, insert: "" }, previous.length);
  const content = "before  after";

  const result = remapThreadsForChange([thread], previous, content, changes);

  assert.deepEqual(result.threads, []);
  assert.deepEqual(result.deletedThreadIds, [thread.id]);
});

test("deletes another thread whose range is covered by a wider replacement", () => {
  const previous = "before first second after";
  const first = makeThread(previous, "first", "first");
  const second = makeThread(previous, "second", "second");
  const changes = ChangeSet.of({ from: first.anchor.start!, to: previous.indexOf(" after"), insert: "replacement" }, previous.length);
  const content = "before replacement after";

  const result = remapThreadsForChange([first, second], previous, content, changes, first.id);

  assert.deepEqual(result.threads.map((thread) => thread.id), [first.id]);
  assert.deepEqual(result.deletedThreadIds, [second.id]);
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
