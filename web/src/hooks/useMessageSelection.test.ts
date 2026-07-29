import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSelectedText } from "./useMessageSelection.ts";

test("message selections preserve copyable text while normalizing layout whitespace", () => {
  assert.equal(normalizeSelectedText("  selected\n\nmessage   text  "), "selected message text");
  assert.equal(normalizeSelectedText("x".repeat(2100)).length, 2000);
});
