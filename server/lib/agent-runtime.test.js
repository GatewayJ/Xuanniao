import assert from "node:assert/strict";
import test from "node:test";

import { assertAgentRuntime, createAgentRuntime, runtimeAgentSettingsFromEnv } from "./agent-runtime.js";
import { DEFAULT_NODE_QUICK_ACTIONS } from "./agent-settings.js";

const defaultQuickActions = DEFAULT_NODE_QUICK_ACTIONS.map((action) => ({ ...action }));
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";

test("the runtime uses native Codex app-server", () => {
  const common = {
    documentPath: "/tmp/plan.md",
    cwd: "/tmp"
  };
  const native = createAgentRuntime({ ...common, env: {} });

  assert.ok(native instanceof CodexAppServerRuntime);
  assert.equal(native.commandLine, "codex app-server");
  assert.equal(native.timeoutMs, 600_000);
});

test("timeout configuration fails fast on invalid values", () => {
  assert.throws(
    () =>
      createAgentRuntime({
        documentPath: "/tmp/plan.md",
        cwd: "/tmp",
        env: { XUANNIAO_AGENT_TIMEOUT_MS: "not-a-number" }
      }),
    /positive numeric/
  );
  assert.throws(
    () =>
      createAgentRuntime({
        documentPath: "/tmp/plan.md",
        cwd: "/tmp",
        env: { XUANNIAO_AGENT_SNAPSHOT_CACHE_ENTRIES: "1.5" }
      }),
    /positive integer/
  );
});

test("runtime contract fails at the composition root when an adapter is incomplete", () => {
  assert.throws(() => assertAgentRuntime({ status() {} }), /missing required method: start/);
});

test("persisted runtime settings override environment values including explicit defaults", () => {
  assert.deepEqual(runtimeAgentSettingsFromEnv({
    XUANNIAO_CODEX_MODEL: "env-model",
    XUANNIAO_CODEX_REASONING_EFFORT: "high"
  }), {
    version: 3,
    model: "env-model",
    reasoningEffort: "high",
    permissionMode: "request-approval",
    quickActions: defaultQuickActions
  });

  const runtime = createAgentRuntime({
    documentPath: "/tmp/plan.md",
    cwd: "/tmp",
    env: {
      XUANNIAO_CODEX_MODEL: "env-model",
      XUANNIAO_CODEX_REASONING_EFFORT: "high"
    },
    settings: { model: null, reasoningEffort: null }
  });
  assert.equal(runtime.status().model, null);
  assert.equal(runtime.status().reasoningEffort, null);
  assert.equal(runtime.status().permissionMode, "request-approval");
});

test("permission mode can be configured by environment", () => {
  assert.equal(runtimeAgentSettingsFromEnv({
    XUANNIAO_AGENT_PERMISSION_MODE: "auto-review"
  }).permissionMode, "auto-review");
});
