import assert from "node:assert/strict";
import test from "node:test";

import { AcpDocumentAgent } from "./acp-client.js";
import { assertAgentRuntime, createAgentRuntime, normalizeAgentTransport } from "./agent-runtime.js";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";

test("native Codex is the default transport and ACP remains explicit", () => {
  const common = {
    documentPath: "/tmp/plan.md",
    cwd: "/tmp"
  };
  const native = createAgentRuntime({ ...common, env: {} });
  const acp = createAgentRuntime({
    ...common,
    env: { XUANNIAO_AGENT_TRANSPORT: "acp" }
  });

  assert.ok(native instanceof CodexAppServerRuntime);
  assert.equal(native.commandLine, "codex app-server");
  assert.equal(native.timeoutMs, 600_000);
  assert.ok(acp instanceof AcpDocumentAgent);
  assert.equal(acp.commandLine, "codex-acp");
  assert.equal(acp.timeoutMs, 600_000);
});

test("transport and timeout configuration fails fast on invalid values", () => {
  assert.equal(normalizeAgentTransport(undefined), "codex");
  assert.throws(() => normalizeAgentTransport("unknown"), /Expected codex or acp/);
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
