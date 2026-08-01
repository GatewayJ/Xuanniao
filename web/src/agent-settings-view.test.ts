import assert from "node:assert/strict";
import test from "node:test";

import { agentSettingsSummary, effortLabel } from "./agent-settings-view";

test("agent settings summary reports the effective model and reasoning depth", () => {
  assert.equal(agentSettingsSummary({
    transport: "codex-app-server",
    modelSelectionSupported: true,
    model: "gpt-sol",
    reasoningEffort: "max",
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
  }), "GPT Sol · Max");
  assert.equal(effortLabel("xhigh"), "极高");
});

test("agent settings summary resolves Codex defaults", () => {
  assert.equal(agentSettingsSummary({
    transport: "codex-app-server",
    modelSelectionSupported: true,
    model: null,
    reasoningEffort: null,
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
  }), "GPT Default · 中");
});
