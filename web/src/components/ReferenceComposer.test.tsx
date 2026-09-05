import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectReferencePicker } from "./ProjectReferencePicker";
import { ReferenceComposer, ReferenceHistory, ReferenceHistoryEntry } from "./ReferenceComposer";
import { ReferenceContextPreview } from "./ReferenceContextPreview";
import { buildConversationTree, conversationBreadcrumb } from "../thread-tree";
import { discussionSources, snapshotReference } from "../discussion-references";
import type { DocumentPayload, Message, ReferenceSnapshot, Thread } from "../types";

const reference: ReferenceSnapshot = {
  id: "history", kind: "message", documentPath: "/external/decision.md", title: "Decision", threadId: "t", messageId: "m",
  start: 0, end: 12, revision: "original-revision", content: "Original <decision>", sourceLength: 12
};
const checkedAt = "2026-09-05T02:00:00.000Z";
const latest = { ...reference, id: "new", revision: "new-revision", content: "Updated decision" };

test("history preserves both versions and offers new discussion without a historical update action", () => {
  const before = structuredClone(reference);
  const html = renderToStaticMarkup(<ReferenceHistoryEntry reference={reference} check={{ id: reference.id, state: "changed", checkedAt, latest }} onAcknowledge={() => {}} onReevaluate={() => {}} />);
  assert.match(html, /Original &lt;decision&gt;/);
  assert.match(html, /Updated decision/);
  assert.match(html, /依据已更新/);
  assert.match(html, /dateTime="2026-09-05T02:00:00.000Z"/);
  assert.match(html, /保留当前依据/);
  assert.match(html, /用新版发起讨论/);
  assert.doesNotMatch(html, /更新为新版/);
  assert.deepEqual(reference, before);
});

test("acknowledging one revision retains the visible difference and a new revision reminds again", () => {
  const kept = renderToStaticMarkup(<ReferenceHistoryEntry reference={reference} check={{ id: reference.id, state: "changed", checkedAt, latest }} acknowledged={latest.revision} onAcknowledge={() => {}} />);
  assert.match(kept, /已保留当前依据/);
  assert.match(kept, /Updated decision/);
  assert.match(kept, /不表示结论已经重新验证/);
  const changed = renderToStaticMarkup(<ReferenceHistoryEntry reference={reference} check={{ id: reference.id, state: "changed", checkedAt, latest: { ...latest, revision: "next" } }} acknowledged={latest.revision} onAcknowledge={() => {}} />);
  assert.match(changed, /依据已更新/);
});

test("relocation is distinct from changed content and missing sources keep their historical snapshot", () => {
  const moved = renderToStaticMarkup(<ReferenceHistoryEntry reference={reference} check={{ id: reference.id, state: "current", relocated: true, checkedAt, latest }} onAcknowledge={() => {}} />);
  assert.match(moved, /正文未变，引用范围已移动/);
  assert.doesNotMatch(moved, /依据已更新/);
  const missing = renderToStaticMarkup(<ReferenceHistoryEntry reference={reference} check={{ id: reference.id, state: "missing", checkedAt }} onAcknowledge={() => {}} onLocate={() => {}} />);
  assert.match(missing, /来源不可用/);
  assert.match(missing, /Original &lt;decision&gt;/);
  assert.doesNotMatch(missing, /查看原位置/);
});

test("cross-document history is not declared missing from the active document's thread list", () => {
  const html = renderToStaticMarkup(<ReferenceHistory references={[reference]} threads={[]} />);
  assert.match(html, /尚未检查来源版本/);
  assert.doesNotMatch(html, /来源不可用|原位置不可用/);
});

test("an oversized updated source explains how to select a usable excerpt", () => {
  const html = renderToStaticMarkup(<ReferenceHistoryEntry reference={reference}
    check={{ id: reference.id, state: "changed", checkedAt, sourceRevision: "large", latestUnavailableReason: "reference_too_large" }}
    onAcknowledge={() => {}} onReevaluate={() => {}} />);
  assert.match(html, /160,000 字符/);
  assert.match(html, /选择更小的片段/);
  assert.match(html, /保留当前依据/);
  assert.match(html, /Original &lt;decision&gt;/);
  assert.doesNotMatch(html, /用新版发起讨论/);
});

test("the existing source picker exposes a document selector and saved source sections without navigation actions", () => {
  const html = renderToStaticMarkup(<ProjectReferencePicker document={{ path: "/plan.md", title: "Plan", content: "# Plan\nBody", revision: "v1", blocks: [{ id: "h", type: "heading", content: "Plan", depth: 1, lineStart: 1, lineEnd: 1 }] }} threads={[]} onAdd={() => {}} />);
  assert.match(html, /选择引用来源文档/);
  assert.match(html, /当前文档/);
  assert.match(html, /刷新来源/);
  assert.match(html, /搜索参考资料/);
  assert.doesNotMatch(html, /打开文档处理|开始执行/);
});

const document: DocumentPayload = { path: "/plan.md", title: "Plan", content: "# Plan\nBody", revision: "v1", blocks: [] };

test("implicit context entries are keyboard-accessible disclosure buttons", () => {
  const html = renderToStaticMarkup(<ReferenceComposer document={document} threads={[]} references={[]} onChange={() => {}} inheritsHistory selectedText="Body" />);
  for (const label of ["完整文档背景", "分支历史", "原文选区"]) {
    assert.match(html, new RegExp(`<button[^>]+aria-expanded="false"[^>]*>.*?${label}</button>`));
  }
  const independent = renderToStaticMarkup(<ReferenceComposer document={document} threads={[]} references={[]} onChange={() => {}} scope="references" selectedText="不应隐式附加" />);
  assert.match(independent, /仅所选资料/);
  assert.doesNotMatch(independent, /原文选区|分支历史|不应隐式附加/);
});

test("the original selection disclosure preserves the full text and reports a lost position", () => {
  const selectedText = "长选区。".repeat(100) + "选区末尾";
  const html = renderToStaticMarkup(<ReferenceContextPreview id="selection" kind="selection" selectedText={selectedText} selectionUnavailable onClose={() => {}} />);
  assert.ok(html.includes(selectedText));
  assert.match(html, /完整原文选区|原位置已变化/);
  assert.match(html, /收起参考说明/);
});

test("branch history shows the selected path's saved questions and answers without sibling content", () => {
  const messages: Message[] = [
    { id: "root", nodeId: "root", parentId: null, role: "user", content: "原始目标", createdAt: "now" },
    { id: "root-answer", nodeId: "root", parentId: "root", role: "assistant", content: "原始结论", createdAt: "now" },
    { id: "selected", nodeId: "selected", parentId: "root", role: "user", content: "当前问题", createdAt: "now" },
    { id: "selected-answer", nodeId: "selected", parentId: "selected", role: "assistant", content: "当前回答", createdAt: "now" },
    { id: "sibling", nodeId: "sibling", parentId: "root", role: "user", content: "其他分支不应出现", createdAt: "now" }
  ];
  const html = renderToStaticMarkup(<ReferenceContextPreview id="history" kind="history" inheritsHistory history={conversationBreadcrumb(buildConversationTree(messages), "selected")} onClose={() => {}} />);
  for (const content of ["原始目标", "原始结论", "当前问题", "当前回答"]) assert.ok(html.includes(content));
  assert.doesNotMatch(html, /其他分支不应出现/);
  assert.match(html, /原生会话还可能包含工具调用/);
});

test("reference chips distinguish the source label from the quoted body and preserve existing snapshots", async () => {
  const thread: Thread = { id: "thread", title: "本文以当前工作区代码为准，描述已经实现的能力。", selectedText: "Body", anchor: { start: 7, end: 11, lineStart: 2, lineEnd: 2, blockId: null }, createdAt: "now", updatedAt: "now", messages: [
    { id: "q", nodeId: "q", parentId: null, role: "user", content: "测试", createdAt: "now" },
    { id: "a", nodeId: "q", parentId: "q", role: "assistant", content: "测试成功，我已收到选中文本和问题。", createdAt: "now" }
  ] };
  const source = discussionSources(document, [thread]).find((item) => item.messageId === "a")!;
  const snapshot = { ...await snapshotReference(source), title: `${thread.title} / 测试 · 回答` };
  const before = structuredClone(snapshot);
  const html = renderToStaticMarkup(<ReferenceComposer document={document} threads={[thread]} references={[snapshot]} onChange={() => {}} />);
  assert.match(html, /测试 · 回答/);
  assert.match(html, /测试成功，我已收到选中文本和问题。/);
  assert.match(html, /引用正文/);
  assert.doesNotMatch(html, /本文以当前工作区代码为准/);
  assert.deepEqual(snapshot, before);
});
