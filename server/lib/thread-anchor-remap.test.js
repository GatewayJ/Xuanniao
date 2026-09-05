import assert from "node:assert/strict";
import test from "node:test";

import { reconcileThreadsForContent, remapThreadsForReplacement } from "./thread-anchor-remap.js";

function makeThread(content, selectedText, id) {
  const start = content.indexOf(selectedText);
  return {
    id,
    title: selectedText,
    selectedText,
    anchor: {
      start,
      end: start + selectedText.length,
      lineStart: content.slice(0, start).split(/\r?\n/).length,
      lineEnd: content.slice(0, start + selectedText.length).split(/\r?\n/).length,
      blockId: null
    }
  };
}

test("server replacement remaps the active thread and orphans other covered selections", () => {
  const previous = "before first second after";
  const first = makeThread(previous, "first", "first");
  const second = makeThread(previous, "second", "second");
  const start = previous.indexOf("first");
  const end = previous.indexOf(" after");
  const replacement = "replacement";
  const content = `${previous.slice(0, start)}${replacement}${previous.slice(end)}`;

  const result = remapThreadsForReplacement([first, second], previous, { start, end, replacement, content }, first.id);

  assert.deepEqual(result.deletedThreadIds, []);
  assert.deepEqual(result.threads.map((thread) => thread.selectedText), ["replacement", "second"]);
  assert.equal(result.threads[1].orphaned, true);
  assert.equal(result.threads[1].anchor.start, null);
});

test("server replacement preserves the source snapshot when its selected text is deleted", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected", "selected");
  const start = thread.anchor.start;
  const end = thread.anchor.end;
  const content = `${previous.slice(0, start)}${previous.slice(end)}`;

  const result = remapThreadsForReplacement([thread], previous, { start, end, replacement: "", content });

  assert.equal(result.threads[0].selectedText, thread.selectedText);
  assert.equal(result.threads[0].orphaned, true);
  assert.equal(result.threads[0].anchor.start, null);
  assert.deepEqual(result.deletedThreadIds, []);
});

test("server reconciliation orphans a thread after an out-of-band document rewrite", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected", "selected");

  const result = reconcileThreadsForContent([thread], "before replacement after");

  assert.equal(result.threads[0].selectedText, thread.selectedText);
  assert.equal(result.threads[0].orphaned, true);
  assert.equal(result.threads[0].anchor.start, null);
  assert.deepEqual(result.deletedThreadIds, []);
});

test("server reconciliation keeps the intended duplicate text using anchor context", () => {
  const previous = "foofoo";
  const thread = makeThread(previous, "foo", "second");
  thread.anchor.start = 3;
  thread.anchor.end = 6;
  thread.anchor.contextBefore = "foo";
  thread.anchor.contextAfter = "";

  const result = reconcileThreadsForContent([thread], "123foofoo");

  assert.deepEqual(result.deletedThreadIds, []);
  assert.equal(result.threads[0].anchor.start, 6);
  assert.equal(result.threads[0].anchor.end, 9);
});

test("orphaned selections never reactivate when the old text returns or an active edit preserves their ID", () => {
  const original = "before selected after";
  const thread = { ...makeThread(original, "selected", "lost"), messages: [{ id: "q", content: "Question", meta: { references: [{ content: "Historical reference" }] } }], records: [{ id: "result" }], checkpoint: { turnId: "turn" } };
  const before = structuredClone(thread);
  const [orphan] = reconcileThreadsForContent([thread], "").threads;
  assert.equal(orphan.selectedText, "selected");
  assert.deepEqual(orphan.messages, thread.messages);
  assert.deepEqual(orphan.records, thread.records);
  assert.deepEqual(orphan.checkpoint, thread.checkpoint);
  assert.equal(reconcileThreadsForContent([orphan], original).threads[0].orphaned, true);
  const edited = remapThreadsForReplacement([orphan], original, { start: 7, end: 15, replacement: "replacement", content: "before replacement after" }, orphan.id);
  assert.equal(edited.threads[0].orphaned, true);
  assert.equal(edited.threads[0].selectedText, "selected");
  assert.deepEqual(thread, before);
});

test("invalid anchors are retained with every location coordinate cleared", () => {
  const thread = { ...makeThread("selected", "selected", "invalid"), selectedText: "missing", anchor: { start: -1, end: 999, lineStart: 9, lineEnd: 9, blockId: "stale-block" } };
  const [orphan] = reconcileThreadsForContent([thread], "current").threads;
  assert.equal(orphan.selectedText, "missing");
  assert.equal(orphan.orphaned, true);
  assert.deepEqual(orphan.anchor, { start: null, end: null, lineStart: null, lineEnd: null, blockId: null });
});
