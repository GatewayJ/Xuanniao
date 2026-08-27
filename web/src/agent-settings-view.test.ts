import assert from "node:assert/strict";
import test from "node:test";

import { agentSettingsSummary, effortLabel } from "./agent-settings-view";
import { DEFAULT_NODE_QUICK_ACTIONS } from "./quick-actions";

test("agent settings summary reports the effective model and reasoning depth", () => {
  assert.equal(agentSettingsSummary({
    model: "gpt-sol",
    reasoningEffort: "max",
    permissionMode: "auto-review",
    quickActions: [...DEFAULT_NODE_QUICK_ACTIONS],
    models: [{
      id: "gpt-sol",
      model: "gpt-sol",
      displayName: "GPT Sol",
      description: null,
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: []
    }],
    catalogError: null
  }), "GPT Sol · Max · 替我审批");
  assert.equal(effortLabel("xhigh"), "极高");
});

test("agent settings summary resolves Codex defaults", () => {
  assert.equal(agentSettingsSummary({
    model: null,
    reasoningEffort: null,
    permissionMode: "request-approval",
    quickActions: [...DEFAULT_NODE_QUICK_ACTIONS],
    models: [{
      id: "gpt-default",
      model: "gpt-default",
      displayName: "GPT Default",
      description: null,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: []
    }],
    catalogError: null
  }), "GPT Default · 中 · 请求批准");
});
