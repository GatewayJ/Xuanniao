import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_NODE_QUICK_ACTIONS, nodeQuickActions } from "./quick-actions";
import type { AgentSettingsPayload } from "./types";

test("node quick actions use defaults until settings load", () => {
  assert.deepEqual(nodeQuickActions(null).map((action) => action.label), ["发散", "审查", "收敛", "转任务"]);
});

test("node quick actions preserve custom and explicitly empty settings", () => {
  const base: AgentSettingsPayload = {
    model: null,
    reasoningEffort: null,
    permissionMode: "request-approval",
    quickActions: [],
    models: [],
    catalogError: null
  };

  assert.deepEqual(nodeQuickActions(base), []);
  assert.deepEqual(nodeQuickActions({
    ...base,
    quickActions: [{ id: "summary", label: "总结", prompt: "总结当前节点" }]
  }), [{ id: "summary", label: "总结", prompt: "总结当前节点" }]);
  assert.equal(DEFAULT_NODE_QUICK_ACTIONS.length, 4);
});
