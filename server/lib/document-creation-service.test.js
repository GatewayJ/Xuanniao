import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunBroker } from "./agent-run-broker.js";
import { DocumentWorkspace } from "./document-workspace.js";
import { ThreadStore } from "./thread-store.js";
import {
  DocumentCreationService,
  extractCreatedDocument,
  resolveCreatedDocumentRelativePath,
  writeNewDocument
} from "./document-creation-service.js";

test("natural-language creation generates, saves, and reports a new Markdown document", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "xuanniao-create-document-"));
  const calls = [];
  const documentCalls = [];
  const agentRuns = new AgentRunBroker({ retentionMs: 60_000 });
  const agent = {
    async runTurn(input) {
      calls.push(input);
      input.onUpdate({ type: "plan", itemId: "plan", plan: [{ step: "分析仓库", status: "completed" }] });
      return {
        content: [
          "<XUANNIAO_DOCUMENT_PATH>",
          "docs/issue-123-solution.md",
          "</XUANNIAO_DOCUMENT_PATH>",
          "<XUANNIAO_DOCUMENT_CONTENT>",
          "# Issue 123 解决方案",
          "",
          "## 意图分析",
          "修复边界条件。",
          "</XUANNIAO_DOCUMENT_CONTENT>"
        ].join("\n")
      };
    }
  };
  const document = {
    async createAgentSnapshot() {
      documentCalls.push("snapshot");
      return { revision: "revision-1" };
    },
    async verifyAgentSnapshot(snapshot) {
      documentCalls.push(`verify:${snapshot.revision}`);
      return null;
    }
  };

  try {
    const service = new DocumentCreationService({ workspaceRoot, agent, document, agentRuns });
    const created = await service.create({
      instruction: "创建文档，分析 Issue 123 并根据当前仓库给出解决方案",
      agentRunId: "document_run_12345678"
    });

    assert.equal(created.relativePath, path.join("docs", "issue-123-solution.md"));
    assert.match(await readFile(created.path, "utf8"), /^# Issue 123 解决方案/);
    assert.equal(calls[0].mode, "create-document");
    assert.equal(calls[0].document.path, workspaceRoot);
    assert.equal(calls[0].thread.id, "document-creation-document_run_12345678");
    assert.deepEqual(documentCalls, ["snapshot", "verify:revision-1"]);
    assert.equal(agentRuns.snapshot("document_run_12345678").status, "completed");
    assert.equal(agentRuns.snapshot("document_run_12345678").events[0].type, "plan");
  } finally {
    agentRuns.dispose();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("document draft parsing requires both protocol blocks", () => {
  assert.deepEqual(
    extractCreatedDocument([
      "<XUANNIAO_DOCUMENT_PATH>plan.md</XUANNIAO_DOCUMENT_PATH>",
      "<XUANNIAO_DOCUMENT_CONTENT># Plan</XUANNIAO_DOCUMENT_CONTENT>"
    ].join("\n")),
    { relativePath: "plan.md", content: "# Plan\n" }
  );
  assert.throws(() => extractCreatedDocument("# unstructured answer"), /complete Xuanniao document block/);
});

test("selected directories and file names override only the requested path parts", () => {
  const workspaceRoot = path.resolve("/tmp/xuanniao-destination");
  assert.equal(
    resolveCreatedDocumentRelativePath(workspaceRoot, "generated/issue-solution.md", {
      directory: path.join(workspaceRoot, "selected"),
      fileName: "chosen-name"
    }),
    path.join("selected", "chosen-name.md")
  );
  assert.equal(
    resolveCreatedDocumentRelativePath(workspaceRoot, "generated/issue-solution.md", {
      fileName: "chosen.md"
    }),
    path.join("generated", "chosen.md")
  );
  assert.equal(
    resolveCreatedDocumentRelativePath(workspaceRoot, "generated/issue-solution.md", {
      directory: workspaceRoot
    }),
    "issue-solution.md"
  );
});

test("selected destinations reject unsafe directories and file names", () => {
  const workspaceRoot = path.resolve("/tmp/xuanniao-destination");
  assert.throws(
    () => resolveCreatedDocumentRelativePath(workspaceRoot, "generated.md", { directory: "../outside" }),
    (error) => error.code === "DOCUMENT_DIRECTORY_OUTSIDE_WORKSPACE" && error.statusCode === 400
  );
  assert.throws(
    () => resolveCreatedDocumentRelativePath(workspaceRoot, "generated.md", { fileName: "nested/name.md" }),
    (error) => error.code === "INVALID_DOCUMENT_FILE_NAME" && error.statusCode === 400
  );
  assert.throws(
    () => resolveCreatedDocumentRelativePath(workspaceRoot, "generated.md", { fileName: "notes.txt" }),
    (error) => error.code === "INVALID_DOCUMENT_EXTENSION" && error.statusCode === 400
  );
});

test("invalid creation requests complete reserved agent runs as failed", async () => {
  const agentRuns = new AgentRunBroker({ retentionMs: 60_000 });
  const agentRunId = "invalid_document_run";
  agentRuns.reserve(agentRunId);
  let agentCalled = false;
  const service = new DocumentCreationService({
    workspaceRoot: "/tmp/xuanniao-invalid-document",
    agent: {
      async runTurn() {
        agentCalled = true;
        throw new Error("agent must not be called");
      }
    },
    agentRuns
  });

  try {
    await assert.rejects(
      service.create({ instruction: "", agentRunId }),
      (error) => error.code === "DOCUMENT_INSTRUCTION_REQUIRED" && error.statusCode === 400
    );
    assert.equal(agentCalled, false);
    assert.equal(agentRuns.snapshot(agentRunId).status, "failed");
    assert.match(agentRuns.snapshot(agentRunId).error, /Describe the document/);
  } finally {
    agentRuns.dispose();
  }
});

test("new document writes reject traversal, protected paths, and overwrites", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "xuanniao-safe-document-"));
  try {
    await assert.rejects(
      writeNewDocument(workspaceRoot, "../outside.md", "unsafe"),
      (error) => error.code === "DOCUMENT_PATH_OUTSIDE_WORKSPACE" && error.statusCode === 502
    );
    await assert.rejects(
      writeNewDocument(workspaceRoot, ".git/notes.md", "unsafe"),
      (error) => error.code === "DOCUMENT_PATH_PROTECTED"
    );

    const existing = path.join(workspaceRoot, "existing.md");
    await writeFile(existing, "original", "utf8");
    await assert.rejects(
      writeNewDocument(workspaceRoot, "existing.md", "replacement"),
      (error) => error.code === "DOCUMENT_ALREADY_EXISTS" && error.statusCode === 409
    );
    assert.equal(await readFile(existing, "utf8"), "original");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("new document writes reject directories that escape through a symlink", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "xuanniao-symlink-document-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "xuanniao-symlink-target-"));
  try {
    await symlink(outsideRoot, path.join(workspaceRoot, "linked"));
    await assert.rejects(
      writeNewDocument(workspaceRoot, "linked/escape.md", "unsafe"),
      (error) => error.code === "DOCUMENT_PATH_OUTSIDE_WORKSPACE"
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("stopping while the source snapshot is pending never submits a native turn", async (t) => {
  const { workspaceRoot, document, agentRuns } = await creationFixture(t);
  let releaseSnapshot;
  let snapshotStarted;
  const started = new Promise((resolve) => { snapshotStarted = resolve; });
  const waiting = new Promise((resolve) => { releaseSnapshot = resolve; });
  const readSnapshot = document.createAgentSnapshot.bind(document);
  document.createAgentSnapshot = async () => { snapshotStarted(); await waiting; return readSnapshot(); };
  let stopping = false;
  let nativeCalls = 0;
  const service = new DocumentCreationService({ workspaceRoot, document, agentRuns, agent: {
    async runTurn() { nativeCalls++; return { content: documentDraft }; }
  } });
  const creation = service.create({ instruction: "Create a plan", agentRunId: "stop-during-snapshot" }, { isStopping: () => stopping });
  const rejected = assert.rejects(creation, { code: "AGENT_INTERRUPTED" });
  await started;
  stopping = true;
  releaseSnapshot();
  await rejected;
  assert.equal(nativeCalls, 0);
  assert.equal(agentRuns.snapshot("stop-during-snapshot").status, "interrupted");
  await assert.rejects(readFile(path.join(workspaceRoot, "created.md")), { code: "ENOENT" });
});

test("stopping during final source verification preserves the draft without writing a document", async (t) => {
  const { workspaceRoot, document, agentRuns } = await creationFixture(t);
  let stopping = false;
  const verify = document.verifyAgentSnapshot.bind(document);
  document.verifyAgentSnapshot = async (snapshot) => { await verify(snapshot); stopping = true; };
  const updates = [];
  const service = new DocumentCreationService({ workspaceRoot, document, agentRuns, agent: {
    async runTurn(input) {
      assert.equal(input.runId, "stop-before-write");
      input.onUpdate({ type: "plan", status: "completed" });
      return { content: documentDraft, updates: [{ type: "agentMessage", status: "completed" }] };
    }
  } });
  await assert.rejects(service.create({ instruction: "Create a plan", agentRunId: "stop-before-write" }, {
    isStopping: () => stopping, onUpdate: (update) => updates.push(update)
  }), (error) => error.code === "AGENT_INTERRUPTED" && error.content === documentDraft && error.updates.length === 1);
  assert.equal(updates.length, 1);
  assert.equal(agentRuns.snapshot("stop-before-write").status, "interrupted");
  await assert.rejects(readFile(path.join(workspaceRoot, "created.md")), { code: "ENOENT" });
});

test("native loss remains unknown even when the source disappears before verification", async (t) => {
  const { workspaceRoot, document, agentRuns } = await creationFixture(t);
  const failure = Object.assign(new Error("native connection lost"), {
    code: "AGENT_RUNTIME_LOST", content: "partial draft", updates: [{ type: "commandExecution", status: "inProgress" }]
  });
  const service = new DocumentCreationService({ workspaceRoot, document, agentRuns, agent: {
    async runTurn() { await rm(document.filePath); throw failure; }
  } });
  await assert.rejects(service.create({ instruction: "Create a plan", agentRunId: "source-lost-run" }), (error) => {
    assert.equal(error, failure);
    assert.equal(error.code, "AGENT_RUNTIME_LOST");
    assert.equal(error.content, "partial draft");
    assert.match(error.verificationError, /ENOENT/);
    return true;
  });
  assert.equal(agentRuns.snapshot("source-lost-run").status, "unknown");
});

test("stop during asynchronous destination validation prevents the final file write", async (t) => {
  const { workspaceRoot } = await creationFixture(t);
  let stopping = false;
  const writing = writeNewDocument(workspaceRoot, "created.md", "draft", { isStopping: () => stopping });
  stopping = true;
  await assert.rejects(writing, { code: "AGENT_INTERRUPTED" });
  await assert.rejects(readFile(path.join(workspaceRoot, "created.md")), { code: "ENOENT" });
});

const documentDraft = "<XUANNIAO_DOCUMENT_PATH>created.md</XUANNIAO_DOCUMENT_PATH>\n<XUANNIAO_DOCUMENT_CONTENT>\n# Created\n</XUANNIAO_DOCUMENT_CONTENT>";

async function creationFixture(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "xuanniao-create-regression-"));
  const documentPath = path.join(workspaceRoot, "source.md");
  await writeFile(documentPath, "# Source\n");
  const document = new DocumentWorkspace(documentPath, new ThreadStore(path.join(workspaceRoot, "threads.json")));
  const agentRuns = new AgentRunBroker();
  t.after(async () => { agentRuns.dispose(); await rm(workspaceRoot, { recursive: true, force: true }); });
  return { workspaceRoot, document, agentRuns };
}
