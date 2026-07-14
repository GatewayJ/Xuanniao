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

test("server replacement remaps every affected thread and removes deleted selections", () => {
  const previous = "before first second after";
  const first = makeThread(previous, "first", "first");
  const second = makeThread(previous, "second", "second");
  const start = previous.indexOf("first");
  const end = previous.indexOf(" after");
  const replacement = "replacement";
  const content = `${previous.slice(0, start)}${replacement}${previous.slice(end)}`;

  const result = remapThreadsForReplacement([first, second], previous, { start, end, replacement, content }, first.id);

  assert.deepEqual(result.deletedThreadIds, [second.id]);
  assert.deepEqual(result.threads.map((thread) => thread.selectedText), ["replacement"]);
});

test("server replacement removes a thread when its selected text is deleted", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected", "selected");
  const start = thread.anchor.start;
  const end = thread.anchor.end;
  const content = `${previous.slice(0, start)}${previous.slice(end)}`;

  const result = remapThreadsForReplacement([thread], previous, { start, end, replacement: "", content });

  assert.deepEqual(result.threads, []);
  assert.deepEqual(result.deletedThreadIds, [thread.id]);
});

test("server reconciliation removes a thread after an out-of-band document rewrite", () => {
  const previous = "before selected after";
  const thread = makeThread(previous, "selected", "selected");

  const result = reconcileThreadsForContent([thread], "before replacement after");

  assert.deepEqual(result.threads, []);
  assert.deepEqual(result.deletedThreadIds, [thread.id]);
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
