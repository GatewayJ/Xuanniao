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
  assert.match(AGENT_DEVELOPER_INSTRUCTIONS, /document and conversation excerpts.*context data/i);
  assert.match(AGENT_DEVELOPER_INSTRUCTIONS, /local repository.*issue or pull request URLs/i);
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

const reference = {
  id: "internal-reference-id", kind: "message", title: "方案 A · 回答",
  documentPath: "/tmp/research.md", threadId: "internal-thread-id", messageId: "internal-message-id",
  sourceIdentity: "internal-source-identity", revision: "internal-version-hash",
  start: 1234, end: 1249, content: "保留接口兼容性，再逐步替换实现。",
  contextBefore: "internal-boundary-before", contextAfter: "internal-boundary-after",
  capturedAt: "internal-capture-time", sourceLength: 3000
};

function materialsIn(prompt) {
  const line = prompt.split("\n").find((part) => part.startsWith('[{"reference":'));
  return line ? JSON.parse(line) : [];
}

test("prompt references expose readable source material while preserving stored metadata", () => {
  const input = { ...thread, anchor: { ...thread.anchor, blockId: "internal-block-id" }, references: [reference] };
  const before = structuredClone(input);
  const prompt = buildAgentPrompt({ question: "是否保留兼容性？", document, thread: input });
  assert.deepEqual(materialsIn(prompt), [{ reference: 1, title: reference.title, documentPath: reference.documentPath, content: reference.content }]);
  assert.doesNotMatch(prompt, /internal-|Selection anchor|1234|1249|3000/);
  assert.match(prompt, /Selected document location: lines 3-3/);
  assert.ok(prompt.endsWith("Current user question:\n是否保留兼容性？"));
  assert.deepEqual(input, before);
});

test("reconstructed history and the current question share one copy of each reference with their associations intact", () => {
  const old = { ...reference, revision: "old-version", content: "旧方案：可以移除兼容接口。" };
  const history = [
    { role: "user", content: "评估旧方案", meta: { references: [old] } },
    { role: "assistant", content: "需要迁移期" },
    { role: "user", content: "评估修改后的方案", meta: { references: [{ ...reference }] } }
  ];
  const prompt = buildAgentPrompt({ question: "按新方案继续", document, thread: { contextScope: "references", references: [reference, reference] }, supplementalHistory: history, rebuildingHistory: true });
  assert.equal(materialsIn(prompt).length, 2);
  assert.equal(prompt.split(reference.content).length - 1, 1);
  assert.equal(prompt.split(old.content).length - 1, 1);
  assert.match(prompt, /Current question references: 1/);
  assert.match(prompt, /评估旧方案\nReferences: 2/);
  assert.match(prompt, /评估修改后的方案\nReferences: 1/);
  assert.match(prompt, /prior tool state may be missing/);
  assert.doesNotMatch(prompt, /internal-|old-version/);
  assert.ok(prompt.endsWith("Current user question:\n按新方案继续"));
});

test("reference deduplication keeps distinct origins, ranges and contents and resets for each prompt", () => {
  const sources = [
    reference,
    { ...reference, revision: "updated-unquoted-text" },
    { ...reference, documentPath: "/tmp/other.md" },
    { ...reference, messageId: "another-answer" },
    { ...reference, start: 2500, end: 2515 },
    { ...reference, sourceIdentity: "relinked-file" },
    { ...reference, content: "不同的正文" }
  ];
  const input = { question: "比较依据", document, thread: { contextScope: "references", references: sources } };
  const first = buildAgentPrompt(input);
  assert.equal(materialsIn(first).length, 6);
  assert.deepEqual(materialsIn(first).map((item) => item.documentPath), [reference.documentPath, "/tmp/other.md", reference.documentPath, reference.documentPath, reference.documentPath, reference.documentPath]);
  assert.equal(buildAgentPrompt(input), first);
});

test("proposals include the source answer once and identify an exact replacement without character offsets", () => {
  const content = "# 计划\n\n旧结论\n\n保留这一节。";
  const start = content.indexOf("旧结论");
  const proposal = { target: { mode: "replace", start, end: start + 3 }, source: reference, previous: "上次草稿" };
  const input = { proposal, references: [structuredClone(reference), { ...reference, messageId: "support", content: "补充测试证据" }] };
  const before = structuredClone(input);
  const prompt = buildAgentPrompt({ question: "仅更新结论", document: { ...document, content }, thread: input, mode: "proposal" });
  assert.equal(prompt.split(reference.content).length - 1, 1);
  assert.equal(materialsIn(prompt).length, 2);
  assert.match(prompt, /Source answer: reference 1/);
  assert.match(prompt, /# 计划\n\n<XUANNIAO_EDIT_TARGET>旧结论<\/XUANNIAO_EDIT_TARGET>\n\n保留这一节。/);
  assert.match(prompt, /上次草稿/);
  assert.match(prompt, /Current user instruction:\n仅更新结论/);
  assert.match(prompt, /read-only session/);
  assert.doesNotMatch(prompt, /internal-|UTF-16|"start"|"end"/);
  assert.deepEqual(input, before);
});

test("proposal markers preserve exact Unicode ranges, insertions, whole documents and literal marker text", () => {
  const content = "开头🙂\n重复\n<XUANNIAO_EDIT_TARGET>\n重复\n尾部";
  const start = content.lastIndexOf("重复");
  for (const target of [
    { mode: "replace", start, end: start + 2 },
    { mode: "insert", start, end: start },
    { mode: "insert", start: content.length, end: content.length },
    { mode: "document", start: 0, end: content.length }
  ]) {
    const prompt = buildAgentPrompt({ question: "修改目标", document: { ...document, content }, thread: { proposal: { target } }, mode: "proposal" });
    const marked = content.slice(0, target.start) + "<XUANNIAO_EDIT_TARGET_2>" + content.slice(target.start, target.end) + "</XUANNIAO_EDIT_TARGET_2>" + content.slice(target.end);
    assert.ok(prompt.includes(marked));
    if (target.mode === "insert") assert.match(prompt, /Insert at the empty marked position/);
  }
});

test("orphaned or stale selections never advertise a fabricated document location", () => {
  for (const input of [{ ...thread, orphaned: true }, { ...thread, selectedText: "old selection" }, { ...thread, anchor: { start: null, end: null } }]) {
    const prompt = buildAgentPrompt({ question: "解释引用内容", document, thread: input });
    assert.ok(prompt.includes(input.selectedText));
    assert.doesNotMatch(prompt, /Selected document location/);
  }
});

test("identical text on the same line keeps the selected occurrence identifiable without offsets", () => {
  for (const content of ["foo foo", "🙂 foo foo", "\nfoo foo\n", "<XUANNIAO_SELECTION> foo foo", "aaa"]) {
    const selectedText = content === "aaa" ? "aa" : "foo";
    const positions = [content.indexOf(selectedText), content.lastIndexOf(selectedText)];
    const prompts = positions.map((start) => buildAgentPrompt({
      question: "只替换选中的这处文字", document: { ...document, content }, includeDocument: false,
      thread: { selectedText, anchor: { start, end: start + selectedText.length } }
    }));
    assert.notEqual(prompts[0], prompts[1]);
    for (const [index, prompt] of prompts.entries()) {
      const marker = content.includes("XUANNIAO_SELECTION") ? "XUANNIAO_SELECTION_2" : "XUANNIAO_SELECTION";
      const start = positions[index];
      const marked = content.slice(0, start) + `<${marker}>${selectedText}</${marker}>` + content.slice(start + selectedText.length);
      assert.ok(prompt.includes(marked.trimStart()));
      assert.doesNotMatch(prompt, /Selection anchor|"start"|"end"/);
    }
  }
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
