import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AcpDocumentAgent,
  acpAgentMode,
  buildPrompt,
  normalizeAgentMode
} from "./acp-client.js";

function createAgent(documentPath, accessMode) {
  return new AcpDocumentAgent({
    documentPath,
    cwd: path.dirname(documentPath),
    commandLine: "codex-acp",
    accessMode,
    timeoutMs: 1000
  });
}

test("full access is the default ACP mode", () => {
  assert.equal(normalizeAgentMode(undefined), "full-access");
  assert.equal(acpAgentMode("full-access"), "agent-full-access");
});

test("read-only maps to the ACP read-only mode", () => {
  assert.equal(acpAgentMode("read-only"), "read-only");
  assert.throws(() => normalizeAgentMode("agent"), /Expected full-access or read-only/);
});

test("full access writes arbitrary files while read-only rejects writes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-access-test-"));
  const documentPath = path.join(tempDir, "document.md");
  const otherPath = path.join(tempDir, "other.txt");
  await writeFile(documentPath, "document", "utf8");

  try {
    await createAgent(documentPath, "full-access").writeTextFile({ path: otherPath, content: "changed" });
    assert.equal(await readFile(otherPath, "utf8"), "changed");
    await assert.rejects(
      createAgent(documentPath, "read-only").writeTextFile({ path: otherPath, content: "denied" }),
      /write denied in read-only mode/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("permission requests resolve automatically in both modes", async () => {
  const fullAccess = createAgent("/tmp/document.md", "full-access");
  const readOnly = createAgent("/tmp/document.md", "read-only");
  const options = [
    { optionId: "allow", kind: "allow_once", name: "Allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" }
  ];

  assert.deepEqual(await fullAccess.requestUserPermission({ options }), {
    outcome: { outcome: "selected", optionId: "allow" }
  });
  assert.deepEqual(await readOnly.requestUserPermission({ options }), {
    outcome: { outcome: "selected", optionId: "deny" }
  });
});

test("each thread creates or loads its own persisted ACP session", async () => {
  class StubAgent extends AcpDocumentAgent {
    constructor() {
      super({
        documentPath: "/tmp/document.md",
        cwd: "/tmp",
        commandLine: "codex-acp",
        timeoutMs: 1000
      });
      this.calls = [];
      this.agentCapabilities = { loadSession: true };
    }

    async ensureInitialized() {}

    async request(method, params) {
      this.calls.push({ method, params });
      return method === "session/new" ? { sessionId: "new-session" } : {};
    }
  }

  const newAgent = new StubAgent();
  let persistedSessionId = null;
  const newThread = { id: "thread-new", acpSessionId: null };
  assert.equal(await newAgent.ensureThreadSession(newThread, (id) => { persistedSessionId = id; }), "new-session");
  assert.equal(persistedSessionId, "new-session");
  assert.deepEqual(newAgent.calls, [{ method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }]);

  const restoredAgent = new StubAgent();
  const restoredThread = { id: "thread-restored", acpSessionId: "stored-session" };
  assert.equal(await restoredAgent.ensureThreadSession(restoredThread), "stored-session");
  assert.deepEqual(restoredAgent.calls, [{
    method: "session/load",
    params: { sessionId: "stored-session", cwd: "/tmp", mcpServers: [] }
  }]);
});

test("prompt contains the complete document and every thread message", () => {
  const messages = Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`
  }));
  const prompt = buildPrompt({
    question: "message-13",
    document: { path: "/tmp/plan.md", title: "plan.md", content: "# Complete plan\n\nAll details." },
    thread: { selectedText: "All details.", anchor: { start: 17, end: 29 }, messages }
  });

  assert.match(prompt, /# Complete plan\n\nAll details\./);
  assert.match(prompt, /user: message-0/);
  assert.match(prompt, /assistant: message-13/);
  assert.match(prompt, /Complete current thread message history:/);
});

test("startup fails when the ACP executable does not exist", async () => {
  const agent = createAgent("/tmp/document.md", "full-access");
  agent.commandLine = "xuanniao-missing-codex-acp-command";
  await assert.rejects(agent.start(), /Failed to start ACP command/);
});
