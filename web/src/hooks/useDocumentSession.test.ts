import assert from "node:assert/strict";
import test from "node:test";

import { hasIncomingDocumentConflict } from "./useDocumentSession.ts";

test("incoming document updates never silently replace a divergent local draft", () => {
  assert.equal(hasIncomingDocumentConflict("base", "local edit", "agent edit"), true);
  assert.equal(hasIncomingDocumentConflict("base", "base", "agent edit"), false);
  assert.equal(hasIncomingDocumentConflict("base", "local edit", "base"), false);
  assert.equal(hasIncomingDocumentConflict("base", "same result", "same result"), false);
});
