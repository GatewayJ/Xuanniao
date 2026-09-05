import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeSelection, compareThreadsByAnchor, resolveThreadAnchor } from "./thread-anchors";
import type { SelectionContext, Thread } from "./types";

test("canonicalizes a stale selection range using its text and line hint", () => {
  const content = "prefix\nselected text\nsuffix";
  const selection: SelectionContext = {
    selectedText: "selected text",
    anchor: {
      start: 0,
      end: 8,
      lineStart: 2,
      lineEnd: 2,
      blockId: null
    }
  };

  const canonical = canonicalizeSelection(content, selection);

  assert.equal(canonical?.selectedText, "selected text");
  assert.equal(canonical?.anchor.start, content.indexOf("selected text"));
  assert.equal(canonical?.anchor.end, content.indexOf("selected text") + "selected text".length);
});

test("rejects a selection that no longer exists in the document", () => {
  const selection: SelectionContext = {
    selectedText: "missing",
    anchor: { start: null, end: null, lineStart: 1, lineEnd: 1, blockId: null }
  };

  assert.equal(canonicalizeSelection("current document", selection), null);
});

test("orphaned threads cannot resolve or sort as active locations even when stale coordinates match", () => {
  const orphan: Thread = { id: "orphan", title: "Old", selectedText: "old", orphaned: true, anchor: { start: 0, end: 3, lineStart: 1, lineEnd: 1, blockId: "old-block" }, messages: [], createdAt: "2020", updatedAt: "2020" };
  const active: Thread = { ...orphan, id: "active", orphaned: false, selectedText: "active", anchor: { start: 4, end: 10, lineStart: 2, lineEnd: 2, blockId: null } };
  assert.equal(resolveThreadAnchor("old\nactive", orphan), null);
  assert.ok(compareThreadsByAnchor(orphan, active, "old\nactive") > 0);
  assert.ok(compareThreadsByAnchor(orphan, active) > 0);
  // A fresh explicit selection is still usable for the separate reanchor command.
  const selection = canonicalizeSelection("old\nactive", { selectedText: "active", anchor: active.anchor });
  assert.equal(selection?.anchor.start, 4);
  assert.equal(orphan.orphaned, true);
});
