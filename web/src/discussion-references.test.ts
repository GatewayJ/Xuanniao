import assert from "node:assert/strict";
import test from "node:test";
import { appendReference, discussionSources, referenceAvailability, snapshotReference, selectedReferenceRange, referenceAcknowledgementKey, referenceAcknowledgementVersion, isReferenceAcknowledged, locateReferenceRange } from "./discussion-references";
import { findThreadForSelection } from "./thread-utils";
import type { DocumentPayload, Thread } from "./types";

const document: DocumentPayload = {
  path: "/plan.md", title: "Plan", content: "# 第一章\n\n目标\n\n## 第二章\n\n内容", revision: "v1",
  blocks: [
    { id: "h1", type: "heading", content: "第一章", lineStart: 1, lineEnd: 1 },
    { id: "h2", type: "heading", content: "第二章", lineStart: 5, lineEnd: 5 }
  ]
};
const thread: Thread = {
  id: "original", title: "方案", selectedText: "目标", anchor: { start: 8, end: 10, lineStart: 3, lineEnd: 3, blockId: null }, createdAt: "now", updatedAt: "now",
  messages: [
    { id: "q", role: "user", content: "是否兼容", nodeId: "q", parentId: null, createdAt: "now" },
    { id: "a", role: "assistant", content: "兼容旧客户端", nodeId: "q", parentId: "q", createdAt: "now" },
    { id: "pending-a", role: "assistant", content: "尚未生成完", nodeId: "q", parentId: "q", createdAt: "now" }
  ]
};

test("reference ranges preserve source offsets and avoid unfinished answers", async () => {
  const sources = discussionSources(document, [thread]);
  assert.equal(sources.filter((source) => source.kind === "message").length, 2);
  const section = sources.find((source) => source.key === "heading:h2")!;
  const ref = await snapshotReference(section, 3, 6);
  assert.equal(document.content.slice(ref.start, ref.end), ref.content);
  assert.match(sources.find((source) => source.messageId === "a")!.title, /是否兼容.*回答/);
  assert.equal(appendReference([ref], { ...ref, id: "another-display-id" }).length, 1);
});

test("draft references show changes without rewriting the historical snapshot", async () => {
  const ref = await snapshotReference(discussionSources(document, [thread]).find((source) => source.messageId === "a")!);
  const updated = { ...thread, messages: thread.messages.map((message) => message.id === "a" ? { ...message, content: "需要验证旧客户端" } : message) };
  const availability = await referenceAvailability(ref, discussionSources(document, [updated]));
  assert.equal(availability.state, "changed");
  assert.equal(availability.latest?.content, "需要验证旧客户端");
  assert.equal(ref.content, "兼容旧客户端");
  assert.equal((await referenceAvailability(ref, discussionSources(document, []))).state, "missing");
});

test("normal selection reopens the original discussion, not an independent discussion at the same range", () => {
  assert.equal(findThreadForSelection([{ ...thread, id: "independent", independent: true }, thread], { selectedText: thread.selectedText, anchor: thread.anchor })?.id, thread.id);
});

test("quotation refuses ambiguous rendered selections and relocates unchanged draft excerpts", async () => {
  const source = discussionSources(document, [thread]).find((item) => item.messageId === "a")!;
  assert.deepEqual(selectedReferenceRange(source, "旧客户端"), { start: 2, end: 6 });
  assert.throws(() => selectedReferenceRange({ ...source, content: "重复，重复" }, "重复"), /无法唯一对应/);
  const ref = await snapshotReference(source, 2, 6);
  const moved = { ...source, content: "必须兼容旧客户端", fullContent: "必须兼容旧客户端" };
  const availability = await referenceAvailability(ref, [moved]);
  assert.equal(availability.state, "current");
  assert.equal(availability.relocated, true);
  assert.equal(availability.latest?.start, 4);
  assert.equal(availability.latest?.content, ref.content);
  assert.equal(ref.start, 2);
});

test("unrelated document edits and legacy full-source revisions do not invalidate quoted content", async () => {
  const source = discussionSources(document, [thread])[0];
  const offset = source.content.indexOf("目标");
  const ref = await snapshotReference(source, offset, offset + 2);
  const { sourceScope, contextBefore, contextAfter, ...legacy } = ref;
  const content = `${source.content}\n\nNew unrelated section`;
  for (const reference of [ref, legacy]) {
    const check = await referenceAvailability(reference, [{ ...source, content, fullContent: content }]);
    assert.equal(check.state, "current");
    assert.equal(check.latest?.content, reference.content);
    assert.notEqual(check.latest?.revision, reference.revision);
    assert.ok(check.checkedAt);
  }
  assert.equal((await referenceAvailability(await snapshotReference(source), [{ ...source, content, fullContent: content }])).state, "changed");
});

test("changed excerpts require unique boundaries and duplicate relocation remains unresolved", async () => {
  const source = discussionSources(document, [thread])[0];
  const offset = source.content.indexOf("目标");
  const ref = await snapshotReference(source, offset, offset + 2);
  const content = source.content.replace("目标", "重新定义目标范围");
  const check = await referenceAvailability(ref, [{ ...source, content, fullContent: content }]);
  // The old quote still occurs once, so the exact unchanged quote is preserved.
  assert.equal(check.state, "current");
  const replaced = source.content.replace("目标", "新的范围");
  assert.equal((await referenceAvailability(ref, [{ ...source, content: replaced, fullContent: replaced }])).latest?.content, "新的范围");
  const ambiguous = "移动目标，重复目标";
  const result = await referenceAvailability(ref, [{ ...source, content: ambiguous, fullContent: ambiguous }]);
  assert.equal(result.state, "changed");
  assert.equal(result.reason, "ambiguous_range");
  assert.equal(result.latest, undefined);
});

test("same message IDs in distinct documents stay distinct and acknowledgements expire with the source revision", async () => {
  const source = discussionSources(document, [thread]).find((item) => item.messageId === "a")!;
  const first = await snapshotReference(source);
  const second = await snapshotReference({ ...source, documentPath: "/another/plan.md" });
  assert.notEqual(first.id, second.id);
  assert.equal(appendReference([first], second).length, 2);
  assert.notEqual(referenceAcknowledgementKey(first), referenceAcknowledgementKey(second));
  const changed = { state: "changed" as const, sourceRevision: "v2" };
  assert.equal(referenceAcknowledgementVersion(changed), "v2");
  assert.equal(isReferenceAcknowledged(changed, "v2"), true);
  assert.equal(isReferenceAcknowledged({ ...changed, sourceRevision: "v3" }, "v2"), false);
  assert.equal(isReferenceAcknowledged({ state: "missing" }, "v2"), false);
  await assert.rejects(snapshotReference(source, -1, 2), /范围无效/);
});

test("client and server agree on whole sources, legacy excerpts, moves, changes and ambiguous ranges", async () => {
  // The server file is deliberately outside the browser TypeScript build.
  const serverModule = "../../server/lib/discussion-context.js";
  const { locateReferenceRange: serverLocate } = await import(serverModule);
  const source = discussionSources(document, [thread])[0];
  const offset = source.content.indexOf("目标");
  const range = await snapshotReference(source, offset, offset + 2);
  const { sourceScope, contextBefore, contextAfter, ...legacy } = range;
  const variants = [await snapshotReference(source), range, legacy];
  const contents = [source.content, `前言\n${source.content}`, source.content.replace("目标", "新内容"), "移动目标，重复目标", "", "no source"];
  for (const ref of variants) for (const content of contents) assert.deepEqual(locateReferenceRange(ref, content), serverLocate(ref, content));
});

test("local checks report an oversized new source while retaining the historical snapshot", async () => {
  const source = discussionSources(document, [thread])[0];
  const reference = await snapshotReference(source);
  const content = "x".repeat(160_001);
  const check = await referenceAvailability(reference, [{ ...source, content, fullContent: content }]);
  assert.equal(check.state, "changed");
  assert.equal(check.latest, undefined);
  assert.equal(check.latestUnavailableReason, "reference_too_large");
  assert.ok(check.sourceRevision);
  assert.equal(reference.content, document.content);
});

test("relinked sources remain distinct even when their text and message IDs are identical", async () => {
  const original = discussionSources({ ...document, referenceIdentity: "original" }, [thread]);
  const reference = await snapshotReference(original.find((item) => item.messageId === "a")!);
  const relinked = discussionSources({ ...document, referenceIdentity: "new", referenceIdentityRequired: true }, [thread]);
  assert.equal(reference.sourceIdentity, "original");
  for (const old of [reference, { ...reference, sourceIdentity: undefined }]) {
    const check = await referenceAvailability(old, relinked);
    assert.equal(check.state, "missing");
    assert.equal(check.reason, "document_identity_changed");
    assert.equal(check.latest, undefined);
  }
  const updated = await snapshotReference(relinked.find((item) => item.messageId === "a")!);
  assert.equal((await referenceAvailability(updated, relinked)).state, "current");
  assert.equal(appendReference([reference], updated).length, 2);
  assert.notEqual(reference.id, updated.id);
});

test("message source labels use the actual question summary while snapshots retain the complete body and identity", async () => {
  const question = { ...thread.messages[0], content: "  是否支持\n\t旧客户端？ " };
  const answer = { ...thread.messages[1], content: "完整回答\n\n" + "保留全部依据与限制。".repeat(20) };
  const input = { ...thread, title: "无关原文长段落".repeat(200), messages: [question, answer] };
  const doc = { ...document, referenceIdentity: "source-identity" };
  const before = structuredClone(input);
  const sources = discussionSources(doc, [input]).filter((source) => source.kind === "message");
  assert.deepEqual(sources.map((source) => source.title), ["是否支持 旧客户端？ · 问题", "是否支持 旧客户端？ · 回答"]);
  assert.equal(sources[1].content, answer.content); assert.equal(sources[1].fullContent, answer.content);
  const snapshot = await snapshotReference(sources[1], 2, answer.content.length - 2);
  const renamed = discussionSources(doc, [{ ...input, title: "另一个讨论名" }]).find((source) => source.messageId === answer.id)!;
  assert.deepEqual(await snapshotReference(renamed, 2, answer.content.length - 2), snapshot);
  assert.equal(snapshot.content, answer.content.slice(2, -2));
  assert.equal(snapshot.sourceLength, answer.content.length); assert.equal(snapshot.sourceIdentity, doc.referenceIdentity);
  assert.equal(snapshot.threadId, thread.id); assert.equal(snapshot.messageId, answer.id);
  assert.equal(snapshot.start, 2); assert.equal(snapshot.end, answer.content.length - 2);
  assert.deepEqual(input, before);
});

test("question labels are bounded without splitting Unicode or truncating reference content", () => {
  const content = "🙂".repeat(49) + "保留在正文中的结尾";
  const input = { ...thread, messages: [{ ...thread.messages[0], content }] };
  const source = discussionSources(document, [input]).find((source) => source.kind === "message")!;
  assert.equal(source.title, "🙂".repeat(48) + "… · 问题");
  assert.equal(source.content, content);
  assert.equal(source.fullContent, content);
});

test("frontend and authoritative backend agree on follow-up, legacy and unavailable-question labels", async () => {
  const serverModule = "../../server/lib/discussion-context.js";
  const { captureReferences } = await import(serverModule);
  const q = thread.messages[0], a = thread.messages[1];
  const followup = { ...q, id: "followup", nodeId: q.id, content: "这次追问" };
  const fixtures: Array<{ messages: Thread["messages"]; messageId: string; title: string }> = [
    { messages: [q, a, followup], messageId: followup.id, title: "这次追问 · 问题" },
    { messages: [q, a, followup, { ...a, id: "followup-answer", parentId: followup.id }], messageId: "followup-answer", title: "这次追问 · 回答" },
    { messages: [q, { ...a, parentId: undefined }], messageId: a.id, title: "是否兼容 · 回答" },
    { messages: [{ ...q, nodeId: undefined }, { ...a, nodeId: undefined, parentId: undefined }], messageId: a.id, title: "是否兼容 · 回答" },
    { messages: [q, { ...a, parentId: "deleted-question" }], messageId: a.id, title: "原问题不可用 · 回答" },
    { messages: [{ ...a, nodeId: undefined, parentId: undefined }], messageId: a.id, title: "原问题不可用 · 回答" },
    { messages: [{ ...q, content: "  \n  " }, a], messageId: a.id, title: "未命名问题 · 回答" },
    { messages: [{ ...q, content: "长问题".repeat(50) }, a], messageId: a.id, title: "长问题".repeat(16) + "… · 回答" }
  ];
  for (const fixture of fixtures) {
    const input = { ...thread, title: "绝不能借用的原文段落".repeat(100), messages: fixture.messages };
    const source = discussionSources(document, [input]).find((source) => source.messageId === fixture.messageId)!;
    const snapshot = await snapshotReference(source);
    const before = structuredClone(snapshot);
    const [captured] = await captureReferences([snapshot], { document, threadStore: { list: async () => [input] } });
    assert.equal(source.title, fixture.title); assert.equal(captured.title, fixture.title);
    assert.equal(captured.content, source.content); assert.equal(captured.revision, snapshot.revision);
    assert.deepEqual(snapshot, before);
  }
});
