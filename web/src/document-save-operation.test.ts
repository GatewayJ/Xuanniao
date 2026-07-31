import assert from "node:assert/strict";
import test from "node:test";

import { executeScopedSave } from "./document-save-operation.ts";
import { DocumentSessionScope } from "./document-session-scope.ts";

test("a queued save does not start after its document session changes", async () => {
  const scope = new DocumentSessionScope();
  const operation = scope.capture();
  let releasePrevious: () => void = () => undefined;
  const previous = new Promise<void>((resolve) => {
    releasePrevious = resolve;
  });
  let persistCalls = 0;
  const saving = executeScopedSave({
    previous,
    operation,
    isCurrent: (candidate) => scope.isCurrent(candidate),
    persist: async () => {
      persistCalls += 1;
      return "saved";
    }
  });

  scope.advance();
  releasePrevious();

  assert.deepEqual(await saving, { status: "stale" });
  assert.equal(persistCalls, 0);
});

test("a response arriving after a document switch cannot commit save state", async () => {
  const scope = new DocumentSessionScope();
  const operation = scope.capture();
  let releaseRequest: (value: string) => void = () => undefined;
  const request = new Promise<string>((resolve) => {
    releaseRequest = resolve;
  });
  const saving = executeScopedSave({
    previous: Promise.resolve(),
    operation,
    isCurrent: (candidate) => scope.isCurrent(candidate),
    persist: () => request
  });
  await Promise.resolve();

  scope.advance();
  releaseRequest("document-a-result");

  assert.deepEqual(await saving, { status: "stale" });
});
