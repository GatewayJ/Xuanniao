import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentSettingsStore } from "./agent-settings-store.js";

test("agent settings store falls back, persists, and reloads atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xuanniao-agent-settings-"));
  const filePath = path.join(root, "nested", "settings.json");
  const store = new AgentSettingsStore(filePath);

  try {
    assert.deepEqual(await store.load({ model: "env-model", reasoningEffort: "low" }), {
      version: 2,
      model: "env-model",
      reasoningEffort: "low",
      permissionMode: "request-approval"
    });
    const saved = await store.save({
      model: "saved-model",
      reasoningEffort: "high",
      permissionMode: "full-access"
    });
    assert.deepEqual(await store.load({ model: "env-model" }), saved);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
