import assert from "node:assert/strict";
import test from "node:test";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentPayload, Message, OutcomeRecord, ReferenceSnapshot, Thread } from "../types";
import { discussionSources, snapshotReference } from "../discussion-references";
import { outcomeApi } from "../outcome-api";
import { hasPendingOutcomeMessages, mergeOutcomeThreads, outcomeControls, OutcomeWorkspace, prepareOutcomeChange, reevaluationReferences } from "./OutcomeWorkspace";
import { DiscussionWorkspaceContext, useDiscussionWorkspace } from "./DiscussionWorkspaceContext";
import type { DiscussionWorkspaceActions } from "./DiscussionWorkspaceContext";
import { assertPreparationTarget, confirmPreparationTarget, initialPreparationValue, OutcomePreparation, preparationDraftKey, preparationTargetIsCurrent, preparationSourceNeedsUpdate } from "./OutcomePreparation";
import { ThreadMessageDetail } from "./ThreadRail";
import { clearOutcomeDraft, OutcomeDetail, outcomeOrigin, saveOutcomeDraft, targetOptions } from "./OutcomeReview";

const date = "2026-09-05T10:00:00.000Z";
const doc: DocumentPayload = { path: "/workspace/plan.md", title: "Plan", content: "Old chapter\n", revision: "doc-v1", blocks: [], referenceIdentity: "identity-after-relink", referenceIdentityRequired: true };
const question: Message = { id: "question", nodeId: "question", role: "user", content: "Should we use A?", createdAt: date };
const answer: Message = { id: "answer", nodeId: question.id, parentId: question.id, role: "assistant", content: "Old conclusion: use A.", createdAt: date };
const thread: Thread = { id: "thread", title: "Design", selectedText: "", anchor: { start: 0, end: 0, blockId: null, lineStart: 1, lineEnd: 1 }, messages: [question, answer], createdAt: date, updatedAt: date };
const source: ReferenceSnapshot = { id: "primary", kind: "message", title: "Answer", documentPath: doc.path, threadId: thread.id, messageId: answer.id, content: answer.content, start: 0, end: answer.content.length, revision: "answer-v1", sourceIdentity: doc.referenceIdentity };
const record = (patch: Partial<OutcomeRecord> = {}): OutcomeRecord => ({ id: "run", title: "Prior execution", documentPath: doc.path, kind: "execution", status: "unknown", recoveryAcknowledged: true, source, references: [source], instruction: "Continue implementing", revision: 1, createdAt: date, updatedAt: date, result: "Partial output: wrote the first section.", ...patch });
const noop = () => {};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Read the real component's handlers under React's server dispatcher, with no browser globals.
function capturePreparation(props: Parameters<typeof OutcomePreparation>[0]) {
  let form!: ReturnType<typeof OutcomePreparation>;
  function Probe() { form = OutcomePreparation(props); return form; }
  const html = renderToStaticMarkup(<Probe />);
  return { form, html };
}
function descendants(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...descendants(node.props.children as ReactNode)];
}
function submitButton(html: string) { return html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0] || ""; }

for (const mode of ["insert", "replace"] as const) {
  test(`reopening a ${mode} draft after document edits blocks the actual submit until the target is reconfirmed`, async () => {
    let value = initialPreparationValue("proposal", doc, source, []);
    value = { ...value, target: mode === "insert" ? targetOptions(doc).find((target) => target.mode === "insert")! : { mode, start: 0, end: 3, label: "自选原文范围" } };
    const current = { ...doc, revision: "doc-v2", content: "Inserted prefix\n" + doc.content };
    const key = preparationDraftKey(doc.path, "proposal", source.id);
    saveOutcomeDraft(key, value);
    let submitted = 0;
    const props = { kind: "proposal" as const, document: current, source, threads: [thread], busy: false, cwd: "/workspace", permission: "read-only", onStart: async () => { submitted++; return false; } };
    const reopened = capturePreparation(props);
    assert.match(reopened.html, /原版本目标，需重新确认/);
    assert.match(submitButton(reopened.html), /disabled/);
    reopened.form.props.onSubmit({ preventDefault: noop });
    await tick(); assert.equal(submitted, 0);
    assert.throws(() => assertPreparationTarget(value, current), /重新核对并确认写入目标/);
    if (mode === "insert") {
      // Selecting the visible end-of-document option recalculates its coordinate.
      const picker = descendants(reopened.form).find((element) => typeof element.props.requiresConfirmation === "boolean")!;
      const target = targetOptions(current).find((target) => target.label === "追加到文档末尾")!;
      assert.equal(target.start, current.content.length);
      assert.notEqual(target.start, value.target.start);
      assert.equal(picker.props.requiresConfirmation, true);
      value = confirmPreparationTarget(value, current, target);
    } else value = confirmPreparationTarget(value, current);
    assert.doesNotThrow(() => assertPreparationTarget(value, current));
    saveOutcomeDraft(key, value);
    const confirmed = capturePreparation(props);
    assert.doesNotMatch(submitButton(confirmed.html), /disabled/);
    confirmed.form.props.onSubmit({ preventDefault: noop });
    await tick(); assert.equal(submitted, 1);
    clearOutcomeDraft(key, value.requestKey);
  });
}

test("target verification compares content even while an unsaved editor retains the old revision; legacy drafts require confirmation", () => {
  const value = initialPreparationValue("proposal", doc, source, []);
  assert.equal(preparationTargetIsCurrent(value, { ...doc, content: doc.content + "Unsaved text" }), false);
  assert.equal(preparationTargetIsCurrent(value, { ...doc, path: "/workspace/other.md" }), false);
  const legacy = { ...value, targetDocument: undefined };
  assert.equal(preparationTargetIsCurrent(legacy, doc), false);
  assert.throws(() => assertPreparationTarget(legacy, doc), /正文已变化/);
  assert.notEqual(confirmPreparationTarget(legacy, doc).requestKey, legacy.requestKey);
});

test("an acknowledged unknown history permits completion sync and merges the next execution's question and answer", () => {
  for (const meta of [{ outcomeUnknown: true }, { agentRun: { id: "lost", status: "unknown", events: [] } }]) {
    const unknown = { ...answer, error: true, meta };
    const local = { ...thread, messages: [question, unknown] };
    const followup = { ...question, id: "new-question", nodeId: "new-question", parentId: question.id };
    const finished = { ...answer, id: "new-answer", nodeId: followup.id, parentId: followup.id, content: "New completed result" };
    const remote = { ...local, messages: [...local.messages, followup, finished] };
    assert.equal(outcomeControls(null, false, [record()]).busy, false);
    assert.equal(hasPendingOutcomeMessages([local]), false);
    assert.deepEqual(mergeOutcomeThreads([local], [remote], [local])[0].messages, remote.messages);
  }
  assert.equal(hasPendingOutcomeMessages([{ ...thread, messages: [...thread.messages, { ...answer, id: "pending-new" }] }]), true);
});

for (const action of ["acknowledge", "delete", "verify"]) {
  test(`${action} submits the persisted document path and record CAS without reading or saving a deleted Markdown file`, async () => {
    let reads = 0, saves = 0;
    const dependencies = { flush: async () => { saves++; throw new Error("Save ENOENT"); }, document: async (): Promise<DocumentPayload> => { reads++; throw new Error("Read ENOENT"); } };
    const payload = await prepareOutcomeChange(action, { expectedRevision: 7, confirmed: true, verification: "passed", verificationNote: "Checked files" }, doc.path, dependencies);
    const sent: unknown[] = [];
    const restore = outcomeApi.change;
    outcomeApi.change = async (...args) => { sent.push(args); return {}; };
    try { await outcomeApi.change("record-id", action, payload); } finally { outcomeApi.change = restore; }
    assert.equal(reads, 0); assert.equal(saves, 0);
    assert.equal(sent.length, 1); assert.equal(payload.documentPath, doc.path); assert.equal(payload.expectedRevision, 7);
    assert.equal("documentRevision" in payload, false);
  });
}

test("text-changing actions still save and reject a switched document before dispatch", async () => {
  for (const action of ["apply", "undo", "refine", "rebase"]) {
    await assert.rejects(prepareOutcomeChange(action, {}, doc.path, { flush: async () => false, document: async () => doc }), /保存失败/);
    await assert.rejects(prepareOutcomeChange(action, {}, doc.path, { flush: async () => true, document: async () => ({ ...doc, path: "/other.md" }) }), /活动文档已切换/);
  }
});

test("a delayed refine HTTP response never disables stop on an identified live operation", async () => {
  let resolve!: () => void;
  let acting = false;
  const response = new Promise<void>((done) => { resolve = done; });
  const request = (async () => { acting = true; await response; acting = false; })();
  assert.equal(outcomeControls({ id: "refine-id", label: "生成提案", stopping: false }, acting).canStop, true);
  assert.equal(outcomeControls({ id: "refine-id", label: "生成提案", stopping: false }, acting, [], true).canStop, false);
  assert.equal(outcomeControls({ id: "refine-id", label: "正在停止", stopping: true }, acting).canStop, false);
  resolve(); await request;
});

test("ReferenceHistory's user trigger prepares both original question and associated conclusions, retaining source identity", async () => {
  const siblingQuestion = { ...question, id: "sibling", nodeId: "sibling", content: "An unrelated branch" };
  const siblingAnswer = { ...answer, id: "sibling-answer", nodeId: "sibling", parentId: "sibling", content: "Never include this conclusion" };
  const currentThread = { ...thread, messages: [...thread.messages, siblingQuestion, siblingAnswer] };
  const updated = { ...source, id: "updated-evidence", documentPath: "/evidence.md", threadId: "evidence-thread", messageId: "evidence", content: "New facts" };
  const before = structuredClone(currentThread);
  let actions!: DiscussionWorkspaceActions;
  let refs: ReferenceSnapshot[] | undefined;
  let draft = "", scope = "";
  function Probe() { actions = useDiscussionWorkspace()!; return null; }
  renderToStaticMarkup(<OutcomeWorkspace document={doc} threads={[currentThread]} permission="read-only" flush={async () => true} apply={() => true} setThreads={noop} select={noop} selection={() => null}
    createIndependent={async (_thread, _title, contextScope) => { scope = contextScope; return { ...thread, id: "new-discussion", messages: [] }; }}
    setDraft={(_key, value) => { draft = value; }} setReferences={(_key, value) => { refs = value; }} referenceDrafts={{}} openDocument={async () => {}} setStatus={noop}><Probe /></OutcomeWorkspace>);
  actions.reevaluate(currentThread, question, [updated]);
  for (let attempt = 0; attempt < 50 && !refs; attempt++) await tick();
  assert.ok(refs); assert.equal(scope, "references"); assert.match(draft, /旧结论/);
  assert.deepEqual(refs.map((ref) => ref.content), [updated.content, question.content, answer.content]);
  for (const captured of refs.slice(1)) assert.equal(captured.sourceIdentity, doc.referenceIdentity);
  assert.deepEqual(currentThread, before);
  const byAnswer = await reevaluationReferences(doc, currentThread, answer, [updated]);
  assert.deepEqual(byAnswer.map((ref) => ref.content), refs.map((ref) => ref.content));
  await assert.rejects(reevaluationReferences(doc, { ...thread, messages: [question] }, question, []), /结论尚未完成/);
});

test("ordinary retry preserves its primary question and partial output, requiring a fresh explicit review before start", async () => {
  const questionSource = await snapshotReference(discussionSources(doc, [thread]).find((source) => source.messageId === question.id)!);
  const previous = record({ origin: "discussion", source: questionSource, references: [questionSource], threadId: thread.id, messageId: question.id });
  const before = structuredClone(previous);
  assert.equal(outcomeOrigin(previous), "discussion");
  const value = initialPreparationValue("execution", doc, previous.source, [thread], previous);
  assert.equal(value.instruction, previous.instruction); assert.deepEqual(value.references, []);
  let starts = 0;
  const props = { kind: "execution" as const, document: doc, source: previous.source, threads: [thread], busy: false, cwd: "/workspace", permission: "workspace-write", initialRecord: previous, retryOf: previous.id, onStart: async () => { starts++; return true; } };
  const { form, html } = capturePreparation(props);
  assert.match(html, /将从原问题创建新的子问题/); assert.ok(html.includes(previous.result!));
  assert.match(html, /旧问题与输出保留/); assert.match(submitButton(html), /disabled/);
  form.props.onSubmit({ preventDefault: noop }); await tick(); assert.equal(starts, 0);
  // Closing and opening the form cannot persist a previous acknowledgement.
  assert.match(submitButton(capturePreparation(props).html), /disabled/);
  assert.deepEqual(previous, before);
  const legacy = { ...previous, origin: undefined };
  assert.equal(outcomeOrigin(legacy), "discussion");
  assert.equal(outcomeOrigin(record({ source: { ...source, kind: "document", messageId: undefined }, messageId: undefined })), "unavailable");
  const creation = record({ origin: "document-creation" });
  assert.match(renderToStaticMarkup(<OutcomeDetail record={creation} records={[creation]} busy={false} onRetry={noop} />), /重新准备创建文档/);
});

test("preparation displays and enforces the combined primary plus supplementary source budget", async () => {
  const extras = Array.from({ length: 24 }, (_, index) => ({ ...source, id: `extra-${index}`, messageId: `extra-${index}`, content: "evidence" }));
  const value = { ...initialPreparationValue("execution", doc, source, []), references: extras };
  const key = preparationDraftKey(doc.path, "execution", source.id);
  let starts = 0;
  const props = { kind: "execution" as const, document: doc, source, threads: [thread], busy: false, cwd: "/workspace", permission: "workspace-write", onStart: async () => { starts++; return true; } };
  saveOutcomeDraft(key, value);
  const { html, form } = capturePreparation(props);
  assert.match(html, /最多 24 项（含操作来源/); assert.match(html, /160,000 字符总预算/); assert.match(html, /当前 25 项/);
  form.props.onSubmit({ preventDefault: noop }); await tick(); assert.equal(starts, 0);
  const legal = { ...value, references: extras.slice(0, 23), requestKey: "legal-budget" };
  saveOutcomeDraft(key, legal); assert.doesNotMatch(submitButton(capturePreparation(props).html), /disabled/);
  const oversized = { ...value, references: [{ ...source, id: "large", messageId: "large", content: "x".repeat(160_000) }], requestKey: "oversized-budget" };
  saveOutcomeDraft(key, oversized); assert.match(submitButton(capturePreparation(props).html), /disabled/);
  clearOutcomeDraft(key, oversized.requestKey);
});


test("an unchanged quote still requires a refreshed snapshot after its source revision or coordinates change", () => {
  const current = { id: source.id, state: "current" as const, checkedAt: date, latest: source };
  assert.equal(preparationSourceNeedsUpdate(source, current), false);
  for (const latest of [{ ...source, revision: "edited-outside-quote" }, { ...source, start: source.start + 7, end: source.end + 7 }, { ...source, sourceIdentity: "another-file" }]) {
    assert.equal(preparationSourceNeedsUpdate(source, { ...current, latest }), true);
    assert.equal(preparationSourceNeedsUpdate(latest, { ...current, latest }), false);
  }
});


test("reevaluating a later question inside the same node quotes that turn, not the node's first answer", async () => {
  const followup = { ...question, id: "followup", content: "What about B?" };
  const followupAnswer = { ...answer, id: "followup-answer", parentId: followup.id, content: "Use B for the exception." };
  const current = { ...thread, messages: [...thread.messages, followup, followupAnswer] };
  const references = await reevaluationReferences(doc, current, followup, []);
  assert.deepEqual(references.map((ref) => ref.content), [followup.content, followupAnswer.content]);
});

test("the ordinary unknown answer's own retry button routes to outcomes and cannot replace its partial output", () => {
  const unknown = { ...answer, content: "Keep this partial output", meta: { outcomeUnknown: true }, error: true };
  const current = { ...thread, messages: [question, unknown] };
  const before = structuredClone(current);
  let directRetries = 0;
  const opened: string[] = [];
  const workspace: DiscussionWorkspaceActions = { adopt: noop, execute: noop, referenceTo: noop, reevaluate: noop, openResults: (threadId) => { opened.push(threadId!); }, stop: noop, busy: false, records: [], references: [], document: doc };
  let element!: ReturnType<typeof ThreadMessageDetail>;
  function Probe() {
    element = ThreadMessageDetail({ thread: current, threadId: current.id, message: unknown, editingMessage: null, editText: "", onEdit: noop, onCancelEdit: noop, onSaveEdit: noop, onRetryAssistant: () => { directRetries++; }, onDeleteMessage: noop, setEditText: noop });
    return element;
  }
  renderToStaticMarkup(<DiscussionWorkspaceContext value={workspace}><Probe /></DiscussionWorkspaceContext>);
  const retry = descendants(element).find((node) => node.type === "button" && node.props.children === "执行记录")!;
  assert.ok(retry); (retry.props.onClick as () => void)();
  assert.deepEqual(opened, [thread.id]); assert.equal(directRetries, 0); assert.deepEqual(current, before);
  workspace.busy = true;
  renderToStaticMarkup(<DiscussionWorkspaceContext value={workspace}><Probe /></DiscussionWorkspaceContext>);
  const recovery = descendants(element).find((node) => node.type === "button" && node.props.children === "执行记录")!;
  assert.equal(recovery.props.disabled, false);
  (recovery.props.onClick as () => void)();
  assert.deepEqual(opened, [thread.id, thread.id]); assert.equal(directRetries, 0);
});
