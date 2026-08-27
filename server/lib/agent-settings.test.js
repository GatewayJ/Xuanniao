import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NODE_QUICK_ACTIONS,
  normalizeAgentSettings,
  normalizeModelCatalog,
  parseNodeQuickActions,
  parseAgentSettingsUpdate,
  validateAgentSettingsSelection
} from "./agent-settings.js";

const defaultQuickActions = DEFAULT_NODE_QUICK_ACTIONS.map((action) => ({ ...action }));

const catalog = [
  {
    id: "gpt-default",
    model: "gpt-default",
    displayName: "Default model",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "medium", description: "Balanced" }
    ]
  },
  {
    id: "gpt-deep",
    model: "gpt-deep",
    displayName: "Deep model",
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }]
  }
];

test("agent settings preserve explicit defaults while accepting environment fallbacks", () => {
  assert.deepEqual(normalizeAgentSettings({}, { model: "fallback", reasoningEffort: "high" }), {
    version: 3,
    model: "fallback",
    reasoningEffort: "high",
    permissionMode: "request-approval",
    quickActions: defaultQuickActions
  });
  assert.deepEqual(normalizeAgentSettings({ model: null, reasoningEffort: null }, { model: "fallback" }), {
    version: 3,
    model: null,
    reasoningEffort: null,
    permissionMode: "request-approval",
    quickActions: defaultQuickActions
  });
});

test("model catalog removes hidden, duplicate, and malformed entries", () => {
  assert.deepEqual(normalizeModelCatalog([
    ...catalog,
    { model: "gpt-default", displayName: "Duplicate" },
    { model: "hidden", hidden: true },
    { displayName: "Missing id" }
  ]), catalog.map((model) => ({
    ...model,
    description: null,
    isDefault: model.isDefault === true,
    defaultReasoningEffort: model.defaultReasoningEffort || null
  })));
});

test("settings validation uses the selected model reasoning capabilities", () => {
  assert.deepEqual(validateAgentSettingsSelection({ model: "gpt-deep", reasoningEffort: "high" }, catalog), {
    version: 3,
    model: "gpt-deep",
    reasoningEffort: "high",
    permissionMode: "request-approval",
    quickActions: defaultQuickActions
  });
  assert.deepEqual(validateAgentSettingsSelection({ model: null, reasoningEffort: "medium" }, catalog), {
    version: 3,
    model: null,
    reasoningEffort: "medium",
    permissionMode: "request-approval",
    quickActions: defaultQuickActions
  });
  assert.throws(
    () => validateAgentSettingsSelection({ model: "missing", reasoningEffort: null }, catalog),
    /not available/
  );
  assert.throws(
    () => validateAgentSettingsSelection({ model: "gpt-deep", reasoningEffort: "medium" }, catalog),
    /does not support/
  );
  assert.throws(() => parseAgentSettingsUpdate({ model: 42 }), /string or null/);
  assert.throws(
    () => parseAgentSettingsUpdate({ permissionMode: "unrestricted-ish" }),
    /Unsupported permission mode/
  );
});

test("settings validation canonicalizes a catalog id to its model name", () => {
  assert.deepEqual(validateAgentSettingsSelection({ model: "alias", reasoningEffort: "low" }, [{
    id: "alias",
    model: "canonical-model",
    displayName: "Canonical",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }]
  }]), {
    version: 3,
    model: "canonical-model",
    reasoningEffort: "low",
    permissionMode: "request-approval",
    quickActions: defaultQuickActions
  });
});

test("agent settings persist an explicit permission mode", () => {
  assert.equal(
    parseAgentSettingsUpdate({ model: null, reasoningEffort: null, permissionMode: "auto-review" }).permissionMode,
    "auto-review"
  );
});

test("node quick actions default, validate, and preserve explicit deletion", () => {
  assert.deepEqual(parseNodeQuickActions(undefined), defaultQuickActions);
  assert.deepEqual(parseNodeQuickActions([]), []);
  assert.deepEqual(parseNodeQuickActions([{
    id: "summarize",
    label: "总结",
    prompt: "请总结当前节点。"
  }]), [{
    id: "summarize",
    label: "总结",
    prompt: "请总结当前节点。"
  }]);
  assert.throws(
    () => parseNodeQuickActions([{ id: "duplicate", label: "一", prompt: "一" }, { id: "duplicate", label: "二", prompt: "二" }]),
    /Duplicate quick action id/
  );
  assert.throws(
    () => parseNodeQuickActions([{ id: "empty", label: "", prompt: "提示" }]),
    /non-empty string/
  );
});
