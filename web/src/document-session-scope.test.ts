import assert from "node:assert/strict";
import test from "node:test";

import { DocumentSessionScope } from "./document-session-scope.ts";

test("advancing a document session aborts and invalidates outstanding operations", () => {
  const scope = new DocumentSessionScope();
  const previous = scope.capture();

  scope.advance();

  assert.equal(previous.signal.aborted, true);
  assert.equal(scope.isCurrent(previous), false);
  assert.equal(scope.isCurrent(scope.capture()), true);
});

test("disposing a document session invalidates captured operations", () => {
  const scope = new DocumentSessionScope();
  const operation = scope.capture();

  scope.dispose();

  assert.equal(operation.signal.aborted, true);
  assert.equal(scope.isCurrent(operation), false);
  assert.equal(scope.isCurrent(scope.capture()), false);
});
