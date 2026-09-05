import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentPayload, Message, OutcomeRecord, PermissionRequest, ProposalTarget, ReferenceSnapshot, Thread } from "../types";
import type { IncomingCitation, ProjectPayload, ReferenceCheck } from "../project-api";
import { discussionSources, referenceAcknowledgementVersion, selectedReferenceRange } from "../discussion-references";
import { citationKey, filterIncomingCitations, filterOutcomeRecords, mergeOutcomeThreads, outcomeActivityLabel, outcomeControls, OutcomePermissions } from "./OutcomeWorkspace";
import { clearOutcomeDraft, DocumentDiff, executionTimelineStatus, outcomeAcknowledgementKey, OutcomeDetail, outcomeReferences, OutcomeReferenceState, readOutcomeDraft, reconcileOutcomeDraft, saveOutcomeDraft, SourceSnapshot, TargetPicker, targetOptionKey, targetOptions, validOutcomeTarget, WorkspaceDialog, appliedOutcomeCount } from "./OutcomeReview";
import type { OutcomeEditDraft } from "./OutcomeReview";
import { initialPreparationValue, OutcomePreparation, OutcomeSourcePicker, preparationDraftKey } from "./OutcomePreparation";
import { filterProjectRows, normalizeProjectFilter, projectReferences, projectRows, projectScrollKey, projectSelectionKey, projectViewKey } from "./ProjectOverview";

const date = "2026-09-05T10:00:00.000Z";
const document: DocumentPayload = { path: "/project/plan.md", title: "Plan", content: "# H1\n\nExisting plan.\n", revision: "document-v1", blocks: [{ id: "heading", type: "heading", content: "# H1", depth: 1, lineStart: 1, lineEnd: 1 }] };
const answer: Message = { id: "answer", nodeId: "question", parentId: "question", role: "assistant", content: "Keep **the plan**.\n", createdAt: date };
const question: Message = { id: "question", nodeId: "question", parentId: null, role: "user", content: "What should we do?", createdAt: date };
const thread: Thread = { id: "source-thread", title: "Plan discussion", selectedText: "Existing plan.", anchor: { start: 6, end: 20, lineStart: 3, lineEnd: 3, blockId: null }, createdAt: date, updatedAt: date, messages: [question, answer] };
const source: ReferenceSnapshot = { id: "source-reference", documentPath: document.path, kind: "message", threadId: thread.id, messageId: answer.id, title: "Answer source", content: answer.content, start: 0, end: answer.content.length, revision: "answer-v1", sourceScope: "full", sourceLength: answer.content.length };
const reference: ReferenceSnapshot = { ...source, id: "extra-reference", messageId: "another-answer", title: "Additional source", content: "Unchanged evidence", end: 18, revision: "extra-v1" };
const target: ProposalTarget = { mode: "insert", start: document.content.length, end: document.content.length, label: "追加到文档末尾" };
function record(patch: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return { id: "outcome", kind: "proposal", status: "review", documentPath: document.path, title: "An outcome", source, references: [source, reference], instruction: "Make the existing plan concrete", createdAt: date, updatedAt: date, revision: 1, target, baseContent: document.content, baseRevision: document.revision, replacement: "\nNew result.\n", proposedContent: document.content + "\nNew result.\n", ...patch };
}
const renderDetail = (item: OutcomeRecord, props: Partial<Parameters<typeof OutcomeDetail>[0]> = {}) => renderToStaticMarkup(<OutcomeDetail record={item} records={[item]} document={document} sourceThread={thread} busy={false} onAction={async () => {}} onRetry={() => {}} {...props} />);
function button(html: string, label: string) {
  const result = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].find((match) => match[2] === label);
  assert.ok(result, `Missing button: ${label}`); return result[1];
}

// Poll responses race local streaming, message creation and explicit local deletion.
test("poll merge preserves pending messages and still updates server-owned anchors", () => {
  const pending = { ...answer, id: "pending-answer", content: "Still streaming" };
  const current = { ...thread, messages: [...thread.messages, pending] };
  const remote = { ...thread, anchor: { ...thread.anchor, start: 20, end: 34 } };
  const [merged] = mergeOutcomeThreads([current], [remote], [thread]);
  assert.equal(merged.messages, current.messages);
  assert.equal(merged.anchor, remote.anchor);
});
test("poll merge protects durable running and stopping messages", () => {
  for (const status of ["running", "stopping"] as const) {
    const streaming = { ...answer, content: "Partial progress", meta: { agentRun: { id: "run", status, events: [] } } };
    const current = { ...thread, messages: [question, streaming] };
    assert.equal(mergeOutcomeThreads([current], [thread], [thread])[0].messages, current.messages);
  }
});
test("poll merge keeps local edits and new branches, accepts remote additions and does not resurrect deletions", () => {
  const edited = { ...answer, content: "New final text" };
  const added = { ...question, id: "new-local", nodeId: "new-local" };
  const serverAdded = { ...answer, id: "new-server" };
  const current = { ...thread, messages: [edited, added] };
  const incoming = { ...thread, messages: [...thread.messages, serverAdded] };
  const [merged] = mergeOutcomeThreads([current], [incoming], [thread]);
  assert.deepEqual(merged.messages.map((message) => message.id), [answer.id, serverAdded.id, added.id]);
  assert.equal(merged.messages[0], edited);
  const localThread = { ...thread, id: "new-thread" };
  assert.deepEqual(mergeOutcomeThreads([localThread], [thread], [thread]), [localThread]);
  assert.deepEqual(mergeOutcomeThreads([thread], [], [thread]), []);
});
test("unchanged local messages accept a new saved server version", () => {
  const final = { ...answer, content: "Server final" };
  assert.equal(mergeOutcomeThreads([thread], [{ ...thread, messages: [question, final] }], [thread])[0].messages[1], final);
});

test("same document offset preserves end-of-document and section intent as distinct options", () => {
  const options = targetOptions(document);
  const atEnd = options.filter((option) => option.mode === "insert" && option.start === document.content.length);
  assert.ok(atEnd.length >= 2);
  assert.equal(new Set(atEnd.map(targetOptionKey)).size, atEnd.length);
  const html = renderToStaticMarkup(<TargetPicker document={document} value={target} onChange={() => {}} />);
  const selected = [...html.matchAll(/<option\b[^>]*selected=""[^>]*>(.*?)<\/option>/g)].map((match) => match[1]);
  assert.deepEqual(selected, ["追加到文档末尾"]);
});
test("write ranges reject truncation, fractional offsets and empty replacement", () => {
  assert.equal(validOutcomeTarget(target, document), true);
  assert.equal(validOutcomeTarget({ ...target, start: 2.5, end: 2.5 }, document), false);
  assert.equal(validOutcomeTarget({ ...target, start: -1, end: -1 }, document), false);
  assert.equal(validOutcomeTarget({ ...target, start: 100, end: 100 }, document), false);
  assert.equal(validOutcomeTarget({ ...target, mode: "replace" }, document), false);
});
test("review puts primary actions and exact Diff before collapsed evidence", () => {
  const html = renderDetail(record());
  assert.ok(html.indexOf('aria-label="提案主要操作"') < html.indexOf('class="outcomeDiff"'));
  assert.ok(html.indexOf('class="outcomeDiff"') < html.indexOf('class="outcomeEvidence"'));
  assert.match(html, /<details class="outcomeEvidence"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*class="outcome(?:Evidence|Source)"[^>]*open/);
  assert.doesNotMatch(button(html, "采纳并写入文档"), /disabled/);
  assert.match(renderDetail(record(), { document: { ...document, revision: "new-doc-version" } }), /正文已变化/);
});
test("diff preserves whitespace and escaped content on both sides", () => {
  const before = "# Title\n\n  keep <old>\t\n";
  const after = "# Title\n\n  keep <new>\t\n";
  const html = renderToStaticMarkup(<DocumentDiff before={before} after={after} />);
  const texts = [...html.matchAll(/<pre\b[^>]*>(.*?)<\/pre>/gs)].map((match) => match[1].replace(/<\/?(?:del|ins)>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
  assert.deepEqual(texts, [before, after]);
});
test("draft reconciliation retains dirty edits across refresh and accepts server changes only in clean fields", () => {
  const base = record();
  const draft: OutcomeEditDraft = { replacement: "Local edit", baseReplacement: base.replacement!, instruction: "Keep my instruction", evidence: "Local evidence", baseEvidence: "", target: { ...target, label: "Local target" }, baseTarget: target };
  const changed = record({ replacement: "New server content", verificationNote: "Server evidence", target: { ...target, start: 0, end: 0 } });
  const merged = reconcileOutcomeDraft(draft, changed);
  assert.equal(merged.replacement, draft.replacement); assert.equal(merged.evidence, draft.evidence); assert.deepEqual(merged.target, draft.target); assert.equal(merged.instruction, draft.instruction);
  assert.equal(merged.sourceChanged, true);
  assert.equal(reconcileOutcomeDraft(merged, changed).sourceChanged, true);
  const clean = reconcileOutcomeDraft({ ...draft, replacement: base.replacement!, evidence: "", target }, changed);
  assert.equal(clean.replacement, changed.replacement); assert.equal(clean.evidence, changed.verificationNote); assert.equal(clean.target, changed.target);
  assert.equal(reconcileOutcomeDraft(merged, { ...changed, replacement: merged.replacement }).sourceChanged, false);
});
test("finishing an old submission cannot delete a newer preparation draft", () => {
  const key = preparationDraftKey(document.path, "execution", source.id, "prior");
  saveOutcomeDraft(key, { requestKey: "new-key", instruction: "Edits made after closing" });
  clearOutcomeDraft(key, "old-key");
  assert.equal(readOutcomeDraft<{ instruction: string }>(key)?.instruction, "Edits made after closing");
  clearOutcomeDraft(key, "new-key"); assert.equal(readOutcomeDraft(key), null);
});
test("retry retains the old instruction, restrictions, acceptance and references with a fresh request key", () => {
  const prior = record({ kind: "execution", status: "interrupted", instruction: "Implement resumable uploads", restrictions: "Only upload module", acceptance: "Resume test passes" });
  const value = initialPreparationValue("execution", document, source, [thread], prior);
  assert.equal(value.instruction, prior.instruction); assert.equal(value.restrictions, prior.restrictions); assert.equal(value.acceptance, prior.acceptance);
  assert.deepEqual(value.references, [reference]);
  assert.notEqual(value.references, prior.references);
  assert.notEqual(value.requestKey, initialPreparationValue("execution", document, source, [thread], prior).requestKey);
  const html = renderToStaticMarkup(<OutcomePreparation kind="execution" document={document} source={source} threads={[thread]} busy cwd="/project" permission="workspace-write" retryOf="prior" initialRecord={prior} onStart={async () => true} />);
  for (const text of [prior.instruction, prior.restrictions!, prior.acceptance!]) assert.ok(html.includes(text));
  assert.match(button(html, "开始执行"), /disabled/);
  assert.match(html, /data-outcome-goal="true"/);
  assert.ok(html.includes(source.content));
});
test("ambiguous rendered Markdown recovers through explicit raw-range selection", () => {
  const raw = discussionSources(document, [thread]).find((item) => item.messageId === answer.id)!;
  assert.throws(() => selectedReferenceRange(raw, "Keep the plan."), /无法唯一对应/);
  const repeated = { ...raw, content: "same and same", fullContent: "same and same" };
  assert.throws(() => selectedReferenceRange(repeated, "same"), /无法唯一对应/);
  const html = renderToStaticMarkup(<OutcomeSourcePicker source={source} selectedText="Keep the plan." busy={false} onConfirm={async () => {}} />);
  assert.match(button(html, "使用明确选段"), /disabled/);
  assert.doesNotMatch(button(html, "改为使用整条回答"), /disabled/);
  assert.match(html, /尚未选择原文片段/);
});

test("unknown recovery allows explicit acknowledgement despite busy while delete and start stay gated", () => {
  const unknown = record({ kind: "execution", status: "unknown", recoveryAcknowledged: false });
  const controls = outcomeControls({ id: "operation-old", label: "Unknown", stopping: true, recoveryRequired: true }, false, [unknown]);
  assert.deepEqual(controls, { busy: true, canStop: false, canAcknowledge: true });
  const html = renderDetail(unknown, controls);
  assert.doesNotMatch(button(html, "已核对原进程和文件"), /disabled/);
  assert.match(button(html, "删除本地记录"), /disabled/);
  assert.doesNotMatch(html, /记录检查通过|记录未通过|准备再次执行/);
  assert.match(button(renderDetail(unknown, { ...controls, mutating: true }), "已核对原进程和文件"), /disabled/);
  assert.deepEqual(outcomeControls(null, false, [unknown]), { busy: true, canStop: false, canAcknowledge: true });
  const acknowledged = { ...unknown, recoveryAcknowledged: true };
  assert.equal(outcomeControls(null, false, [acknowledged]).busy, false);
  const ackHtml = renderDetail(acknowledged);
  assert.doesNotMatch(button(ackHtml, "准备再次执行"), /disabled/);
  assert.match(ackHtml, /记录检查通过/);
  assert.doesNotMatch(ackHtml, /已核对原进程和文件/);
});
test("stop requires a live operation id and never substitutes for unknown recovery", () => {
  assert.equal(outcomeControls({ label: "No identity", stopping: false }, false).canStop, false);
  assert.equal(outcomeControls({ id: "new-op", label: "Running", stopping: false }, false).canStop, true);
  assert.equal(outcomeControls({ id: "new-op", label: "Running", stopping: false }, true).canStop, true);
  assert.equal(outcomeControls({ id: "new-op", label: "Running", stopping: false }, true, [], true).canStop, false);
  assert.equal(outcomeControls({ id: "new-op", label: "Running", stopping: false }, false).canAcknowledge, false);
});
test("execution timelines retain interrupted, unknown and stopping states without a contradictory failure label", () => {
  for (const [status, label] of [["interrupted", "已中断"], ["unknown", "结果未知"], ["stopping", "正在停止"]] as const) {
    assert.equal(executionTimelineStatus(status), status);
    const html = renderDetail(record({ kind: "execution", status }));
    assert.match(html, new RegExp(label)); assert.doesNotMatch(html, /执行失败|agentRunTimeline[^>]*floating/);
  }
  const html = renderDetail(record({ kind: "execution", status: "interrupted", result: "Execution was interrupted.", error: "Execution was interrupted." }));
  assert.equal((html.match(/Execution was interrupted\./g) || []).length, 1);
});
test("source checks include primary snapshot and acknowledge each outcome and source version independently", () => {
  const a = record(), b = record({ id: "another-record" });
  assert.deepEqual(outcomeReferences(a).map((item) => item.id), [source.id, reference.id]);
  assert.notEqual(outcomeAcknowledgementKey(a, source), outcomeAcknowledgementKey(b, source));
  const changed: ReferenceCheck = { id: source.id, state: "changed", sourceRevision: "v2", checkedAt: date };
  const v2 = referenceAcknowledgementVersion(changed);
  assert.equal(v2, "v2");
  assert.match(renderToStaticMarkup(<OutcomeReferenceState check={changed} acknowledged={v2} />), /已保留当前依据/);
  assert.match(renderToStaticMarkup(<OutcomeReferenceState check={{ ...changed, sourceRevision: "v3" }} acknowledged={v2} />), /依据已更新/);
  const readonly = renderDetail(a, { readonly: true });
  assert.match(readonly, /检查来源版本/); assert.doesNotMatch(readonly, /采纳并写入文档|删除本地记录/);
});
test("applied count excludes inverse records and duplicate records", () => {
  const applied = record({ status: "applied" });
  assert.equal(appliedOutcomeCount([applied, applied, record({ id: "inverse", status: "applied", inverseOf: applied.id }), record({ id: "execution", kind: "execution", status: "completed" }), record({ id: "undone", status: "undone" })]), 1);
});
test("incoming citation filtering preserves distinct targets and filters by the exact source answer", () => {
  const first: IncomingCitation = { reference: source, documentPath: "/project/target.md", targetThreadId: "target", targetMessageId: "target-message", title: "Target discussion", targetContent: "Saved target preview", available: true };
  const second = { ...first, targetMessageId: "second-target" };
  const missing = { ...first, documentPath: "/project/missing.md", available: false };
  const unrelated = { ...first, reference: { ...reference, documentPath: "/project/other.md" } };
  const citations = filterIncomingCitations([first, first, second, missing, unrelated], document.path, { threadId: thread.id, messageId: answer.id });
  assert.deepEqual(citations, [first, second, missing]);
  assert.notEqual(citationKey(first), citationKey(second));
  assert.equal(filterIncomingCitations([first], document.path, { messageId: "no-match" }).length, 0);
  assert.equal(filterOutcomeRecords([record(), record({ id: "other", source: reference })], { threadId: thread.id, messageId: answer.id }).length, 1);
});

test("project rows check record source, preserve missing/external records and use document-scoped selection", () => {
  const primaryOnly = record({ references: [] });
  const external = { ...primaryOnly, documentPath: "/other/plan.md" };
  const project: ProjectPayload = { root: "/project", checkedAt: date, documents: [
    { path: document.path, title: document.title, available: false, external: false, threads: [thread], records: [primaryOnly] },
    { path: external.documentPath, title: "External", available: true, external: true, threads: [], records: [external] }
  ] };
  assert.ok(projectReferences(project).some((item) => item.id === source.id));
  const rows = projectRows(project, [{ id: source.id, state: "changed", checkedAt: date }]);
  assert.equal(rows.length, 3);
  const filtered = filterProjectRows(rows, { ...normalizeProjectFilter(), kind: "proposal", changed: true });
  assert.equal(filtered.length, 2); assert.notEqual(projectSelectionKey(filtered[0]), projectSelectionKey(filtered[1]));
  const staleFilter = { ...normalizeProjectFilter(), kind: "proposal" as const, path: "/deleted/filter.md" };
  assert.equal(filterProjectRows(rows, staleFilter).length, 0);
  assert.equal(filterProjectRows(rows, { ...staleFilter, path: "" }).length, 2);
  assert.equal(rows.find((row) => row.record?.id === primaryOnly.id)?.record, primaryOnly);
});
test("project applied view excludes inverse and all views preserve distinct saved scroll positions", () => {
  const filter = { ...normalizeProjectFilter(), kind: "applied" as const };
  const project: ProjectPayload = { root: "/project", checkedAt: date, documents: [{ path: document.path, title: "Plan", available: true, external: false, threads: [], records: [record({ status: "applied" }), record({ id: "inverse", status: "applied", inverseOf: "outcome" })] }] };
  assert.equal(filterProjectRows(projectRows(project, []), filter).length, 1);
  assert.notEqual(projectScrollKey("/project", filter), projectScrollKey("/project", { ...filter, query: "plan" }));
  assert.notEqual(projectViewKey("/project"), projectViewKey("/other"));
  assert.deepEqual(normalizeProjectFilter({ query: "  Plan  " }), { kind: "discussion", path: "", status: "", changed: false, query: "  Plan  " });
});
test("native dialogs have an accessible title and permission requests are actionable inside the dialog", () => {
  const request: PermissionRequest = { id: "permission", sessionId: "session", threadId: thread.id, toolCallId: "tool", title: "Write upload module", kind: "edit", status: "pending", rawInput: "Only the selected module", createdAt: date, options: [{ optionId: "allow-id", name: "Allow", kind: "allow_once" }, { optionId: "reject-id", name: "Reject", kind: "reject_once" }] };
  const html = renderToStaticMarkup(<WorkspaceDialog title="成果记录" onClose={() => {}}><OutcomePermissions requests={[request]} onResolve={() => {}} /></WorkspaceDialog>);
  const id = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"/)?.[1]; assert.ok(id); assert.ok(html.includes(`<h2 id="${id}">成果记录</h2>`));
  assert.ok(html.indexOf("等待权限") > html.indexOf("<dialog"));
  assert.doesNotMatch(button(html, "允许一次"), /disabled/);
  assert.doesNotMatch(button(html, "拒绝一次"), /disabled/);
  assert.doesNotMatch(button(html, "取消"), /disabled/);
  const resolving = renderToStaticMarkup(<OutcomePermissions requests={[request]} resolvingIds={new Set([request.id])} onResolve={() => {}} />);
  assert.match(button(resolving, "允许一次"), /disabled/);
  assert.equal(outcomeActivityLabel({ id: "run", label: "正在执行", stopping: false }, 2), "等待权限 · 2 项请求");
  assert.equal(outcomeActivityLabel(null, 1), "等待权限 · 1 项请求");
});
test("standalone source snapshot starts collapsed and remains keyboard-readable", () => {
  const html = renderToStaticMarkup(<SourceSnapshot source={source} />);
  assert.doesNotMatch(html, /<details[^>]*open/); assert.match(html, /<pre tabindex="0"/);
});
