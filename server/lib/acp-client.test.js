import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpDocumentAgent, acpAgentMode, buildPrompt, normalizeAgentMode } from "./acp-client.js";

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
    await createAgent(documentPath, "full-access").writeTextFile({
      path: otherPath,
      content: "changed"
    });
    assert.equal(await readFile(otherPath, "utf8"), "changed");
    await assert.rejects(
      createAgent(documentPath, "read-only").writeTextFile({
        path: otherPath,
        content: "denied"
      }),
      /write denied in read-only mode/
    );
    await assert.rejects(
      createAgent(documentPath, "full-access").writeTextFile({
        path: documentPath,
        content: "bypass"
      }),
      /protected active document/
    );
    assert.equal(await readFile(documentPath, "utf8"), "document");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("permission requests are surfaced to the approval broker", async () => {
  const agent = createAgent("/tmp/document.md", "full-access");
  const options = [
    { optionId: "allow", kind: "allow_once", name: "Allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" }
  ];

  const pending = agent.requestUserPermission({
    sessionId: "session-1",
    title: "Run command",
    options
  });
  const [request] = agent.listPermissionRequests();
  assert.equal(request.sessionId, "session-1");
  assert.equal(request.title, "Run command");
  assert.deepEqual(request.options, options);
  agent.resolvePermissionRequest(request.id, { optionId: "allow" });
  assert.deepEqual(await pending, {
    outcome: { outcome: "selected", optionId: "allow" }
  });
  assert.deepEqual(agent.listPermissionRequests(), []);
});

test("disposing ACP while permission is pending does not write to the closed process", async () => {
  const agent = createAgent("/tmp/document.md", "full-access");
  const writes = [];
  agent.process = {
    killed: false,
    stdin: {
      writable: true,
      write(line) {
        writes.push(line);
      }
    },
    kill() {
      this.killed = true;
    }
  };

  const handling = agent.handleClientRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "session/request_permission",
    params: {
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }]
    }
  });
  await Promise.resolve();
  assert.equal(agent.listPermissionRequests().length, 1);

  agent.dispose();

  await assert.doesNotReject(handling);
  assert.deepEqual(writes, []);
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
  const newThread = { id: "thread-new", agentSession: null };
  assert.deepEqual(await newAgent.ensureThreadSession(newThread), {
    sessionId: "new-session",
    documentHash: null,
    historyMode: "fresh"
  });
  assert.deepEqual(newAgent.calls, [{ method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }]);

  const restoredAgent = new StubAgent();
  const restoredThread = {
    id: "thread-restored",
    agentSession: {
      adapter: "acp",
      sessionId: "stored-session",
      turnId: null,
      documentHash: "document-hash"
    }
  };
  assert.deepEqual(await restoredAgent.ensureThreadSession(restoredThread), {
    sessionId: "stored-session",
    documentHash: "document-hash",
    historyMode: "inherited"
  });
  assert.deepEqual(restoredAgent.calls, [
    {
      method: "session/load",
      params: { sessionId: "stored-session", cwd: "/tmp", mcpServers: [] }
    }
  ]);
});

test("creates and persists a new session when a stored session cannot be loaded", async () => {
  class StubAgent extends AcpDocumentAgent {
    constructor(loadSession = true) {
      super({
        documentPath: "/tmp/document.md",
        cwd: "/tmp",
        commandLine: "codex-acp",
        timeoutMs: 1000
      });
      this.calls = [];
      this.agentCapabilities = { loadSession };
    }

    async ensureInitialized() {}

    async request(method, params) {
      this.calls.push({ method, params });
      if (method === "session/load") throw new Error("session/load failed: Internal error");
      return { sessionId: "replacement-session" };
    }
  }

  for (const loadSession of [true, false]) {
    const agent = new StubAgent(loadSession);
    const thread = {
      id: `thread-${loadSession}`,
      agentSession: {
        adapter: "acp",
        sessionId: "stale-session",
        turnId: null,
        documentHash: "old-hash"
      }
    };

    assert.deepEqual(await agent.ensureThreadSession(thread), {
      sessionId: "replacement-session",
      documentHash: null,
      historyMode: "fresh"
    });
    assert.equal(agent.calls.at(-1).method, "session/new");
    assert.equal(agent.calls.filter(({ method }) => method === "session/load").length, loadSession ? 1 : 0);
  }
});

test("sibling conversation nodes use isolated ACP sessions", async () => {
  class StubAgent extends AcpDocumentAgent {
    constructor() {
      super({
        documentPath: "/tmp/document.md",
        cwd: "/tmp",
        commandLine: "codex-acp",
        timeoutMs: 1000
      });
      this.sessionCount = 0;
    }

    async ensureInitialized() {}

    async request() {
      this.sessionCount += 1;
      return { sessionId: `session-${this.sessionCount}` };
    }
  }

  const agent = new StubAgent();
  const left = await agent.ensureThreadSession({
    id: "thread-1",
    sessionKey: "thread-1:left",
    agentSession: null
  });
  const right = await agent.ensureThreadSession({
    id: "thread-1",
    sessionKey: "thread-1:right",
    agentSession: null
  });
  assert.equal(left.sessionId, "session-1");
  assert.equal(right.sessionId, "session-2");
});

test("prompt contains the complete document and every supplied branch message", () => {
  const messages = Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`
  }));
  const prompt = buildPrompt({
    question: "message-13",
    document: {
      path: "/tmp/plan.md",
      title: "plan.md",
      content: "# Complete plan\n\nAll details."
    },
    thread: {
      selectedText: "All details.",
      anchor: { start: 17, end: 29 },
      messages
    }
  });

  assert.match(prompt, /# Complete plan\n\nAll details\./);
  assert.match(prompt, /<message role="user">\nmessage-0/);
  assert.match(prompt, /<message role="assistant">\nmessage-13/);
  assert.match(prompt, /Conversation history required to reconstruct this branch:/);
});

test("prompt identifies the selected conversation excerpt for a focused follow-up", () => {
  const prompt = buildPrompt({
    question: "Why is this important?",
    document: { path: "/tmp/plan.md", title: "plan.md", content: "# Plan" },
    thread: {
      selectedText: "Plan",
      anchor: {},
      messages: [],
      branchSelection: {
        sourceMessageId: "answer-1",
        text: "A precise selected excerpt."
      }
    }
  });

  assert.match(prompt, /<XUANNIAO_BRANCH_SELECTION>\nA precise selected excerpt\.\n<\/XUANNIAO_BRANCH_SELECTION>/);
  assert.match(prompt, /specific subject of the current user question/);
  assert.match(prompt, /Current user question:\nWhy is this important\?/);
});

test("startup fails when the ACP executable does not exist", async () => {
  const agent = createAgent("/tmp/document.md", "full-access");
  agent.commandLine = "xuanniao-missing-codex-acp-command";
  await assert.rejects(agent.start(), /Failed to start ACP command/);
});

test("an ACP timeout invalidates the process and all resumable session state", async () => {
  const agent = createAgent("/tmp/document.md", "full-access");
  const timeout = new Error("ACP request timed out");
  timeout.code = "RPC_REQUEST_TIMEOUT";
  let disposedWith = null;
  agent.initialized = true;
  agent.threadSessions.set("thread-1", { sessionId: "session-1" });
  agent.documentSnapshots.set("session-1", "document");
  agent.rpc = {
    request: async () => {
      throw timeout;
    },
    dispose(error) {
      disposedWith = error;
    }
  };

  await assert.rejects(agent.request("session/prompt", {}), (error) => error === timeout);
  assert.equal(agent.initialized, false);
  assert.equal(agent.threadSessions.size, 0);
  assert.equal(agent.documentSnapshots.size, 0);
  assert.match(disposedWith.message, /restarted after a request timeout/);
});
