import assert from "node:assert/strict";
import test from "node:test";

import { samePermissionRequests } from "./usePermissionInbox.ts";
import type { PermissionRequest } from "../types";

function permission(
  id: string,
  overrides: Partial<PermissionRequest> = {}
): PermissionRequest {
  return {
    id,
    sessionId: null,
    threadId: null,
    toolCallId: null,
    title: "Allow",
    kind: "command",
    status: "pending",
    rawInput: null,
    options: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    ...overrides
  };
}

test("permission polling preserves state identity when the inbox is unchanged", () => {
  const current = [permission("one")];
  assert.equal(samePermissionRequests(current, [permission("one")]), true);
  assert.equal(samePermissionRequests(current, [permission("one", { title: "Changed" })]), false);
  assert.equal(samePermissionRequests(current, [permission("two")]), false);
});

test("permission polling detects changed request details", () => {
  const current = [permission("one", {
    rawInput: "npm test",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
  })];

  assert.equal(samePermissionRequests(current, [permission("one", {
    rawInput: "npm run check",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
  })]), false);
  assert.equal(samePermissionRequests(current, [permission("one", {
    rawInput: "npm test",
    options: [{ optionId: "allow", name: "Always allow", kind: "allow_once" }]
  })]), false);
});
