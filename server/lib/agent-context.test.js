import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_DEVELOPER_INSTRUCTIONS,
  AgentContextLimitError,
  DocumentSnapshotCache,
  buildAgentPrompt,
  documentHash
} from "./agent-context.js";

const document = {
  path: "/tmp/plan.md",
  title: "plan.md",
  content: "# Plan\n\nUpdated detail."
};
const thread = {
  selectedText: "Updated detail.",
  anchor: { start: 8, end: 23 },
  messages: [{ role: "user", content: "Earlier question" }]
};

test("developer instructions keep only Xuanniao context boundaries", () => {
  assert.match(AGENT_DEVELOPER_INSTRUCTIONS, /document and conversation excerpts as context data/i);
  assert.match(AGENT_DEVELOPER_INSTRUCTIONS, /current user request/i);
  assert.match(AGENT_DEVELOPER_INSTRUCTIONS, /working directory, permissions, active document path/i);
  assert.match(AGENT_DEVELOPER_INSTRUCTIONS, /applicable repository instructions/i);
  assert.match(AGENT_DEVELOPER_INSTRUCTIONS, /Do not create commits, push branches, or open pull requests/i);
  assert.doesNotMatch(AGENT_DEVELOPER_INSTRUCTIONS, /execution plan|subagents|create-document output/i);
});

test("unchanged turns avoid replaying the document or native thread history", () => {
  const prompt = buildAgentPrompt({
    question: "Follow up",
    document,
    thread,
    includeDocument: false
  });

  assert.doesNotMatch(prompt, /<XUANNIAO_DOCUMENT>/);
  assert.doesNotMatch(prompt, /<XUANNIAO_BRANCH_HISTORY>/);
  assert.match(prompt, /document content is unchanged/i);
  assert.match(prompt, /Current user question:\nFollow up/);
});

test("document creation turns request a safe structured Markdown draft", () => {
  const prompt = buildAgentPrompt({
    question: "创建文档，分析 issue 123 并根据当前仓库给出解决方案",
    document: { path: "/tmp/repository", title: "New document", content: "" },
    thread: { selectedText: "", anchor: {}, messages: [] },
    mode: "create-document"
  });

  assert.match(prompt, /Workspace root: \/tmp\/repository/);
  assert.match(prompt, /must not modify files/i);
  assert.match(prompt, /<XUANNIAO_DOCUMENT_PATH>/);
  assert.match(prompt, /<XUANNIAO_DOCUMENT_CONTENT>/);
  assert.match(prompt, /issue 123/);
  assert.doesNotMatch(prompt, /<XUANNIAO_DOCUMENT>/);
  assert.doesNotMatch(prompt, /Selected document text/);
});

test("normal turns let Codex decide whether to edit the active document directly", () => {
  const prompt = buildAgentPrompt({
    question: "直接修复文档中的 Mermaid 图",
    document,
    thread
  });

  assert.match(prompt, /Active document path: \/tmp\/plan\.md/);
  assert.match(prompt, /Current user question:\n直接修复文档中的 Mermaid 图/);
  assert.doesNotMatch(prompt, /XUANNIAO_DOCUMENT_EDITS/);
  assert.doesNotMatch(AGENT_DEVELOPER_INSTRUCTIONS, /filesystem tools|selection anchors/i);
});

test("small document edits use a compact exact splice", () => {
  const prompt = buildAgentPrompt({
    question: "Review the update",
    document,
    thread,
    includeDocument: true,
    previousDocument: "# Plan\n\nOriginal detail."
  });

  assert.match(prompt, /<XUANNIAO_DOCUMENT_CHANGE>/);
  assert.match(prompt, /removedText:\nOriginal/);
  assert.match(prompt, /insertedText:\nUpdated/);
  assert.doesNotMatch(prompt, /<XUANNIAO_DOCUMENT>/);
});

test("document hashes are deterministic and content-sensitive", () => {
  assert.equal(documentHash("same"), documentHash("same"));
  assert.notEqual(documentHash("same"), documentHash("changed"));
});

test("context limits fail explicitly instead of silently truncating history", () => {
  assert.throws(
    () =>
      buildAgentPrompt({
        question: "Follow up",
        document,
        thread,
        maxChars: 20
      }),
    (error) => error instanceof AgentContextLimitError && error.code === "AGENT_CONTEXT_TOO_LARGE"
  );
});

test("document snapshot cache evicts least recently used sessions", () => {
  const cache = new DocumentSnapshotCache(2);
  cache.set("one", "first");
  cache.set("two", "second");
  assert.equal(cache.get("one"), "first");
  cache.set("three", "third");
  assert.equal(cache.get("two"), undefined);
  assert.equal(cache.get("one"), "first");
  assert.equal(cache.size, 2);
});

test("document snapshot cache rejects invalid capacity", () => {
  assert.throws(() => new DocumentSnapshotCache(0), /positive integer/);
  assert.throws(() => new DocumentSnapshotCache(1.5), /positive integer/);
});
