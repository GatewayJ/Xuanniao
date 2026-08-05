import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAgentSettings,
  normalizeModelCatalog,
  parseAgentSettingsUpdate,
  validateAgentSettingsSelection
} from "./agent-settings.js";

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
    version: 2,
    model: "fallback",
    reasoningEffort: "high",
    permissionMode: "request-approval"
  });
  assert.deepEqual(normalizeAgentSettings({ model: null, reasoningEffort: null }, { model: "fallback" }), {
    version: 2,
    model: null,
    reasoningEffort: null,
    permissionMode: "request-approval"
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
    version: 2,
    model: "gpt-deep",
    reasoningEffort: "high",
    permissionMode: "request-approval"
  });
  assert.deepEqual(validateAgentSettingsSelection({ model: null, reasoningEffort: "medium" }, catalog), {
    version: 2,
    model: null,
    reasoningEffort: "medium",
    permissionMode: "request-approval"
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
    version: 2,
    model: "canonical-model",
    reasoningEffort: "low",
    permissionMode: "request-approval"
  });
});

test("agent settings persist an explicit permission mode", () => {
  assert.equal(
    parseAgentSettingsUpdate({ model: null, reasoningEffort: null, permissionMode: "auto-review" }).permissionMode,
    "auto-review"
  );
});
