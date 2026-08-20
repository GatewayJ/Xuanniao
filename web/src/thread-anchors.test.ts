import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeSelection } from "./thread-anchors";
import type { SelectionContext } from "./types";

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
