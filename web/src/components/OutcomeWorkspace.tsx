import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { api } from "../api";
import { agentRunForMessage } from "../agent-run";
import { appendReference, discussionSources, messageReferences, selectedReferenceRange, snapshotReference } from "../discussion-references";
import { outcomeApi } from "../outcome-api";
import type { OutcomeSnapshot } from "../outcome-api";
import { projectApi, type IncomingCitation } from "../project-api";
import { threadNodeDraftKey } from "../thread-drafts";
import type { DocumentPayload, Message, OutcomeRecord, PermissionRequest, ReferenceSnapshot, SelectionContext, Thread } from "../types";
import { DiscussionWorkspaceContext } from "./DiscussionWorkspaceContext";
import type { DiscussionWorkspaceActions } from "./DiscussionWorkspaceContext";
import { assertPreparationTarget, preparationSourceNeedsUpdate, OutcomePreparation, OutcomeSourcePicker } from "./OutcomePreparation";
import { OutcomeDetail, SourceSnapshot, WorkspaceDialog, outcomeStatus, outcomeOrigin } from "./OutcomeReview";
import { PermissionRequestPanel } from "./PermissionRequestPanel";
import { ProjectOverview } from "./ProjectOverview";
import { ReferencePreview } from "./ReferencePreview";
import { restoredDiscussionNode, stableMessage } from "./discussion-view-state";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

type Props = {
  permissionRequests?: PermissionRequest[]; resolvingPermissionIds?: Set<string>; onResolvePermission?(requestId: string, optionId: string | null): void;
  children: ReactNode; document: DocumentPayload | null; threads: Thread[]; permission: string;
  flush(): Promise<boolean>; apply(document: DocumentPayload): boolean; setThreads: Dispatch<SetStateAction<Thread[]>>;
  select(thread: Thread): void; selection(): SelectionContext | null;
  createIndependent(thread: Thread, title: string, scope: "full" | "references"): Promise<Thread>;
  setDraft(key: string, content: string): void; setReferences(key: string, references: ReferenceSnapshot[]): void;
  referenceDrafts: Record<string, ReferenceSnapshot[]>; openDocument(path: string): Promise<void>;
  onRetryCreation?(record: OutcomeRecord): void;
  setStatus(message: string): void;
};
type Panel = "records" | "proposal" | "execution" | "reference" | "project" | "source" | "reference-preview" | null;
type ProjectNavigation = { path: string; recordId?: string; threadId?: string; messageId?: string; reference?: ReferenceSnapshot; nonce: number; ready: boolean };
export type OutcomeFilter = { threadId?: string; messageId?: string };
const emptySnapshot: OutcomeSnapshot = { records: [], activity: null, cwd: "" };
function streamingMessage(message: Message): boolean {
  const run = agentRunForMessage(message);
  return run ? ["waiting", "running", "stopping"].includes(run.status) : message.id.startsWith("pending-");
}
export const hasPendingOutcomeMessages = (threads: Thread[]) => threads.some((thread) => thread.messages.some(streamingMessage));

/** A poll owns server anchors, but must not replace messages added or streamed since it started. */
export function mergeOutcomeThreads(current: Thread[], incoming: Thread[], baseline: Thread[]): Thread[] {
  const base = new Map(baseline.map((thread) => [thread.id, thread]));
  const live = new Map(current.map((thread) => [thread.id, thread]));
  const result = incoming.flatMap((remote) => {
    const local = live.get(remote.id);
    const previous = base.get(remote.id);
    if (!local) return previous ? [] : [remote];
    if (local.messages.some(streamingMessage)) return [{ ...remote, messages: local.messages }];
    const before = new Map(previous?.messages.map((message) => [message.id, message]) || []);
    const now = new Map(local.messages.map((message) => [message.id, message]));
    const messages = remote.messages.flatMap((message) => {
      const currentMessage = now.get(message.id);
      if (!currentMessage) return before.has(message.id) ? [] : [message];
      return [currentMessage !== before.get(message.id) ? currentMessage : message];
    });
    const remoteIds = new Set(remote.messages.map((message) => message.id));
    messages.push(...local.messages.filter((message) => !remoteIds.has(message.id) && message !== before.get(message.id)));
    return [{ ...remote, messages }];
  });
  const incomingIds = new Set(incoming.map((thread) => thread.id));
  result.push(...current.filter((thread) => !incomingIds.has(thread.id) && (!base.has(thread.id) || thread.messages !== base.get(thread.id)?.messages)));
  return result;
}
export function filterOutcomeRecords(records: OutcomeRecord[], filter: OutcomeFilter) {
  return records.filter((item) => (!filter.threadId || item.source.threadId === filter.threadId) && (!filter.messageId || item.source.messageId === filter.messageId));
}
export function citationKey(citation: IncomingCitation): string {
  return JSON.stringify([citation.documentPath, citation.targetThreadId, citation.targetMessageId, citation.reference.id]);
}
export function filterIncomingCitations(citations: IncomingCitation[], path: string | undefined, filter: OutcomeFilter) {
  return [...new Map(citations.filter((item) => item.reference.documentPath === path && (!filter.threadId || item.reference.threadId === filter.threadId)
    && (!filter.messageId || item.reference.messageId === filter.messageId)).map((item) => [citationKey(item), item])).values()];
}

export function outcomeControls(activity: OutcomeSnapshot["activity"], mutating: boolean, records: OutcomeRecord[] = [], stopping = false) {
  return {
    busy: Boolean(activity) || mutating || records.some((record) => record.status === "unknown" && !record.recoveryAcknowledged),
    canStop: Boolean(activity?.id) && !activity?.stopping && !activity?.recoveryRequired && !stopping,
    canAcknowledge: !mutating && (!activity || activity.recoveryRequired === true)
  };
}

export async function prepareOutcomeChange(action: string, body: Record<string, unknown>, documentPath: string, dependencies: {
  flush(): Promise<boolean>; document(): Promise<DocumentPayload>;
}): Promise<Record<string, unknown>> {
  if (!["apply", "undo", "rebase", "refine"].includes(action)) return { ...body, documentPath };
  if (!await dependencies.flush()) throw new Error("文档保存失败，正文未修改。");
  const document = await dependencies.document();
  if (document.path !== documentPath) throw new Error("活动文档已切换，操作未提交。");
  return { ...body, documentPath, documentRevision: document.revision };
}

export async function reevaluationReferences(document: DocumentPayload, thread: Thread, message: Message, updated: ReferenceSnapshot[]) {
  const current = thread.messages.find((item) => item.id === message.id);
  if (!current || current.content !== message.content) throw new Error("原问题或结论已变化，请重新打开后操作。");
  const questionId = current.role === "user" ? current.id : current.parentId || current.nodeId;
  const question = thread.messages.find((item) => item.role === "user" && item.id === questionId);
  const answers = thread.messages.filter((item) => item.role === "assistant" && (item.parentId || item.nodeId) === questionId);
  if (!question || !answers.length || answers.some((item) => !stableMessage(item)) || !answers.some((item) => !item.error && item.content.trim())) {
    throw new Error("原问题的结论尚未完成或不可用，请先打开原讨论核对。");
  }
  const messages = [question, ...answers.filter((item) => !item.error && item.content.trim())];
  const sources = discussionSources(document, [thread]);
  const snapshots = await Promise.all(messages.map(async (item) => {
    const source = sources.find((source) => source.messageId === item.id);
    if (!source) throw new Error("原问题或结论不可用。");
    const snapshot = await snapshotReference(source);
    return { ...snapshot, title: `${item.role === "user" ? "原问题" : "待重新评估的旧结论"} · ${snapshot.title}` };
  }));
  const references = snapshots.reduce(appendReference, updated);
  if (references.length > 24 || references.reduce((sum, reference) => sum + reference.content.length, 0) > 160_000) throw new Error("新版资料与原问题、旧结论合计超过资料预算，请缩小资料范围。");
  return references;
}

export function outcomeActivityLabel(activity: OutcomeSnapshot["activity"], waitingPermissions = 0): string {
  if (waitingPermissions) return `等待权限 · ${waitingPermissions} 项请求`;
  if (activity?.recoveryRequired) return "结果未知 · 请核对原进程和文件";
  if (activity?.stopping) return "正在停止并协调文件变化…";
  return activity?.label || "";
}
export function OutcomePermissions({ requests, resolvingIds, onResolve }: {
  requests: PermissionRequest[]; resolvingIds?: Set<string>; onResolve?(requestId: string, optionId: string | null): void;
}) {
  if (!requests.length) return null;
  return <section className="outcomePermissions" aria-label="等待权限"><h3 role="status">等待权限 · {requests.length} 项请求</h3>
    {requests.map((request) => <PermissionRequestPanel key={request.id} request={request} resolving={!onResolve || Boolean(resolvingIds?.has(request.id))} onResolve={(id, option) => onResolve?.(id, option)} />)}
  </section>;
}

export function OutcomeWorkspace(props: Props) {
  const [snapshot, setSnapshot] = useState<OutcomeSnapshot>(emptySnapshot);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [source, setSource] = useState<ReferenceSnapshot | null>(null);
  const [previewReference, setPreviewReference] = useState<ReferenceSnapshot | null>(null);
  const [sourcePicker, setSourcePicker] = useState<{ kind: "proposal" | "execution" | "reference"; source: ReferenceSnapshot; text: string } | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [filter, setFilter] = useState<OutcomeFilter>({});
  const [targetThreadId, setTargetThreadId] = useState("");
  const [targetNodeId, setTargetNodeId] = useState("");
  const [retryOf, setRetryOf] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [stoppingRequest, setStoppingRequest] = useState(false);
  const stopRequest = useRef<Promise<void> | null>(null);
  const [navigation, setNavigation] = useState<DiscussionWorkspaceActions["navigation"]>();
  const [projectNavigation, setProjectNavigation] = useState<ProjectNavigation | null>(null);
  const pendingNavigation = useRef<ProjectNavigation | null>(null);
  const [citations, setCitations] = useState<IncomingCitation[]>([]);
  const [citationError, setCitationError] = useState("");
  const [citationRefresh, setCitationRefresh] = useState(0);
  const [selectedCitation, setSelectedCitation] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const path = props.document?.path;
  const epoch = useRef({ path, version: 0 });
  if (epoch.current.path !== path) epoch.current = { path, version: epoch.current.version + 1 };
  const panelVersion = useRef(0);
  const refreshVersion = useRef(0);
  const previousActivity = useRef(false);
  const needsDocumentSync = useRef(false);
  const operationActive = useRef(false);
  const navigationNonce = useRef(0);
  const controls = outcomeControls(snapshot.activity, acting, snapshot.records, stoppingRequest);
  const { canStop, canAcknowledge } = controls;
  const permissionRequests = props.permissionRequests || [];
  const busy = controls.busy || permissionRequests.length > 0;
  const activityLabel = outcomeActivityLabel(snapshot.activity, permissionRequests.length) || (snapshot.records.some((record) => record.status === "unknown" && !record.recoveryAcknowledged) ? "结果未知 · 请核对原进程和文件" : "");
  const permissionPanel = <OutcomePermissions requests={permissionRequests} resolvingIds={props.resolvingPermissionIds} onResolve={props.onResolvePermission} />;

  function showPanel(value: Panel) { panelVersion.current++; setPanel(value); }
  function closePanel() { pendingNavigation.current = null; setProjectNavigation(null); showPanel(null); }
  function assertCurrent(origin: typeof epoch.current) {
    if (origin !== epoch.current) throw new Error("活动文档已切换，旧操作没有继续提交。");
  }
  function reportCurrent(origin: typeof epoch.current, caught: unknown) {
    if (origin === epoch.current) latest.current.setStatus(caught instanceof Error ? caught.message : String(caught));
  }
  function mergeThreads(threads: Thread[], baseline: Thread[], origin: typeof epoch.current) {
    latest.current.setThreads((current) => origin === epoch.current ? mergeOutcomeThreads(current, threads, baseline) : current);
  }
  async function refresh(syncDocument = false) {
    const origin = epoch.current;
    const request = ++refreshVersion.current;
    const next = await outcomeApi.list();
    if (origin !== epoch.current || request !== refreshVersion.current) return;
    setSnapshot(next);
    needsDocumentSync.current ||= syncDocument || (previousActivity.current && !next.activity);
    previousActivity.current = Boolean(next.activity);
    if (!needsDocumentSync.current || next.activity || hasPendingOutcomeMessages(latest.current.threads)) return;
    const baseline = latest.current.threads;
    const [document, { threads }] = await Promise.all([api.document(), api.threads()]);
    if (origin !== epoch.current || request !== refreshVersion.current || document.path !== origin.path) return;
    if (latest.current.apply(document)) {
      mergeThreads(threads, baseline, origin);
      needsDocumentSync.current = hasPendingOutcomeMessages(latest.current.threads);
    }
  }
  function keepRecord(record: OutcomeRecord) {
    refreshVersion.current++;
    needsDocumentSync.current ||= record.kind === "execution" || record.status === "generating";
    setSnapshot((current) => ({ ...current, records: [...current.records.filter((item) => item.id !== record.id), record] }));
  }
  useEffect(() => {
    showPanel(null); setSource(null); setSourcePicker(null); setPreviewReference(null); setFilter({}); setSelectedRecord(null); setSelectedCitation(null); setError("");
    setSnapshot(emptySnapshot); previousActivity.current = false; needsDocumentSync.current = false; setCitations([]);
    if (!path) return;
    let cancelled = false;
    const origin = epoch.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!cancelled) await refresh(); } catch (caught) { if (!cancelled && origin === epoch.current) setError(caught instanceof Error ? caught.message : String(caught)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); refreshVersion.current++; };
  }, [path]);

  // Only persisted message/reference changes invalidate the project-wide incoming index.
  const citationSignature = JSON.stringify(props.threads.map((thread) => [thread.id, thread.title, thread.messages.filter(stableMessage).map((message) => [message.id, message.content, messageReferences(message.meta).map((reference) => [reference.id, reference.revision, reference.start, reference.end])])]));
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const origin = epoch.current;
    const timer = setTimeout(() => {
      setCitationError("");
      projectApi.incoming().then((result) => { if (!cancelled && origin === epoch.current) setCitations(result); })
        .catch((caught) => { if (!cancelled && origin === epoch.current) setCitationError(caught instanceof Error ? caught.message : "无法读取引用记录"); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, citationSignature, citationRefresh]);

  async function perform(operation: () => Promise<void>): Promise<boolean> {
    if (operationActive.current) return false;
    operationActive.current = true;
    const origin = epoch.current;
    setError(""); setActing(true);
    try { await operation(); return true; }
    catch (caught) {
      if (origin === epoch.current) { const message = caught instanceof Error ? caught.message : String(caught); setError(message); latest.current.setStatus(message); }
      return false;
    } finally { operationActive.current = false; setActing(false); }
  }
  function locate(thread: Thread, nodeId: string | null, reference?: ReferenceSnapshot, focusComposer = true) {
    latest.current.select(thread);
    setNavigation({ threadId: thread.id, nodeId, reference, focusComposer, nonce: ++navigationNonce.current });
  }
  async function openProjectDocument(documentPath: string, recordId?: string, threadId?: string, messageId?: string, reference?: ReferenceSnapshot) {
    if (busy && documentPath !== latest.current.document?.path) throw new Error("请等待当前执行结束，再打开目标文档。");
    const origin = epoch.current;
    const intent: ProjectNavigation = { path: documentPath, recordId, threadId, messageId, reference, nonce: ++navigationNonce.current, ready: false };
    pendingNavigation.current = intent;
    try {
      if (documentPath !== latest.current.document?.path) await latest.current.openDocument(documentPath);
      if (pendingNavigation.current !== intent) return;
      const ready = { ...intent, ready: true };
      pendingNavigation.current = ready; setProjectNavigation(ready);
    } catch (caught) {
      if (pendingNavigation.current !== intent || (origin !== epoch.current && epoch.current.path !== documentPath)) return;
      pendingNavigation.current = null; throw caught;
    }
  }
  useEffect(() => {
    const intent = projectNavigation;
    if (!intent?.ready || intent.path !== path || pendingNavigation.current?.nonce !== intent.nonce) return;
    // This effect runs after the path reset, even when openDocument resolves before React commits.
    pendingNavigation.current = null; setProjectNavigation(null); setFilter({}); setSelectedCitation(null);
    if (intent.threadId) {
      const thread = latest.current.threads.find((thread) => thread.id === intent.threadId);
      const message = thread?.messages.find((message) => message.id === intent.messageId);
      if (thread && (!intent.messageId || message)) { locate(thread, !message ? restoredDiscussionNode(path, thread) : message.role === "user" ? message.nodeId || message.id : message.nodeId || message.parentId || null, intent.reference, false); showPanel(null); }
      else { setError("目标讨论或消息已不可用，引用快照仍保留。"); showPanel("records"); }
    } else { setSelectedRecord(intent.recordId || null); showPanel(intent.recordId ? "records" : null); }
    setCitationRefresh((value) => value + 1);
    const origin = epoch.current;
    void refresh().catch((caught) => reportCurrent(origin, caught));
  }, [path, projectNavigation]);

  async function capture(thread: Thread, message: Message, text?: string) {
    const document = latest.current.document;
    const current = latest.current.threads.find((item) => item.id === thread.id)?.messages.find((item) => item.id === message.id);
    if (!document) throw new Error("文档尚未加载");
    if (!current || !stableMessage(current) || !current.content.trim()) throw new Error("请等待回答结束后再操作");
    if (current.content !== message.content) throw new Error("来源回答已变化，请重新选择内容。");
    const item = discussionSources(document, [thread]).find((candidate) => candidate.messageId === message.id)!;
    const range = selectedReferenceRange(item, text);
    return snapshotReference(item, range.start, range.end);
  }
  function prepare(kind: "proposal" | "execution" | "reference", thread: Thread, message: Message, text?: string) {
    const origin = epoch.current;
    const version = panelVersion.current;
    void perform(async () => {
      let captured: ReferenceSnapshot;
      try { captured = await capture(thread, message, text); }
      catch (caught) {
        if (!text || !(caught instanceof Error) || !caught.message.includes("无法唯一对应")) throw caught;
        const full = await capture(thread, message);
        assertCurrent(origin);
        if (panelVersion.current !== version) return;
        setSourcePicker({ kind, source: full, text }); showPanel("source"); return;
      }
      assertCurrent(origin);
      if (panelVersion.current !== version) return;
      setSource(captured); setRetryOf(undefined); showPanel(kind); setTargetThreadId(""); setTargetNodeId("");
    });
  }
  function prepareRetry(record: OutcomeRecord) {
    if (busy) return;
    const origin = outcomeOrigin(record);
    if (origin === "document-creation") {
      if (!props.onRetryCreation) { setError("创建文档入口暂不可用，请稍后重试。"); return; }
      closePanel(); props.onRetryCreation(record); return;
    }
    if (origin === "unavailable") { setError("无法识别历史执行入口，请重新准备。"); return; }
    setSource(record.source); setRetryOf(record.id); showPanel("execution");
  }
  function openResults(threadId?: string, messageId?: string) {
    pendingNavigation.current = null; setProjectNavigation(null); setFilter({ threadId, messageId }); setSelectedRecord(null); setSelectedCitation(null); showPanel("records"); setCitationRefresh((value) => value + 1);
  }
  const actions: DiscussionWorkspaceActions = {
    openProject: () => showPanel("project"), onDiscussionVisibilityChange: setDiscussionOpen, activityLabel,
    adopt: (thread, message, text) => prepare("proposal", thread, message, text),
    execute: (thread, message, text) => prepare("execution", thread, message, text),
    referenceTo: (thread, message, text) => prepare("reference", thread, message, text),
    previewReference: (reference) => { setPreviewReference(reference); showPanel("reference-preview"); },
    reevaluate: (thread, message, refs) => { const origin = epoch.current; void perform(async () => {
      const document = latest.current.document;
      const currentThread = latest.current.threads.find((item) => item.id === thread.id);
      if (!document || !currentThread) throw new Error("原讨论已不可用。");
      const references = await reevaluationReferences(document, currentThread, message, refs); assertCurrent(origin);
      const target = await latest.current.createIndependent(thread, "重新评估依据", "references"); assertCurrent(origin);
      const key = threadNodeDraftKey(target.id, null);
      latest.current.setReferences(key, references);
      latest.current.setDraft(key, "请根据新版资料重新评估引用中的旧结论，说明哪些仍然成立、哪些需要调整，以及尚缺少的验证证据。");
      locate(target, null); closePanel();
    }); },
    openResults, stop: () => {
      if (!canStop || !snapshot.activity?.id || stopRequest.current) return;
      const origin = epoch.current;
      const identity = { documentPath: props.document?.path, operationId: snapshot.activity.id };
      setStoppingRequest(true); setError("");
      const request = Promise.resolve().then(async () => {
        const next = await outcomeApi.stop(identity); assertCurrent(origin);
        refreshVersion.current++; setSnapshot(next);
        await refresh(true);
      }).catch((caught) => {
        if (origin === epoch.current) { setError(caught instanceof Error ? caught.message : String(caught)); reportCurrent(origin, caught); }
      }).finally(() => {
        if (stopRequest.current === request) { stopRequest.current = null; setStoppingRequest(false); }
      });
      stopRequest.current = request;
    },
    reanchor: (thread) => { const selection = latest.current.selection(); const origin = epoch.current; void perform(async () => {
      if (!selection) throw new Error("请先在文档中选择新片段，再点击重新定位。");
      if (!await latest.current.flush()) throw new Error("文档未保存，定位未修改。"); assertCurrent(origin);
      const document = await api.document(); assertCurrent(origin);
      const baseline = latest.current.threads;
      const result = await outcomeApi.reanchor(thread.id, { start: selection.anchor.start, end: selection.anchor.end, expectedRevision: document.revision }); assertCurrent(origin);
      mergeThreads(result.threads, baseline, origin); latest.current.setStatus("讨论已重新定位");
    }); },
    busy, canStop, records: snapshot.records, references: props.threads.flatMap((thread) => thread.messages.flatMap((message) => messageReferences(message.meta))), document: props.document, navigation, citations
  };
  const record = snapshot.records.find((item) => item.id === selectedRecord);
  const visibleRecords = filterOutcomeRecords(snapshot.records, filter);
  const visibleCitations = filterIncomingCitations(citations, path, filter);
  const citation = citations.find((item) => citationKey(item) === selectedCitation);
  const targetThread = props.threads.find((thread) => thread.id === targetThreadId);

  return <DiscussionWorkspaceContext value={actions}>
    <div className="workspaceNavigationShell">
      <div className="workspaceNavigationContent">{props.children}</div>
      <WorkspaceNavigation placement="workspace" hidden={discussionOpen} />
    </div>
    {panel === "project" && <ProjectOverview permissions={permissionPanel} waitingPermissions={permissionRequests.length} busy={busy} canStop={canStop} currentPath={path} onClose={closePanel} onStop={actions.stop} onOpen={openProjectDocument} />}
    {panel === "reference-preview" && previewReference && <ReferencePreview key={previewReference.id} reference={previewReference} busy={busy} onClose={closePanel}
      onOpen={(reference, locate) => openProjectDocument(reference.documentPath, undefined, reference.threadId, reference.messageId, locate ? reference : undefined)} />}
    {panel === "source" && sourcePicker && <WorkspaceDialog title="重新选择来源片段" onClose={closePanel}>
      {permissionPanel}
      <OutcomeSourcePicker source={sourcePicker.source} selectedText={sourcePicker.text} busy={acting} onConfirm={async (start, end) => {
        const origin = epoch.current; const version = panelVersion.current;
        const thread = latest.current.threads.find((thread) => thread.id === sourcePicker.source.threadId);
        const message = thread?.messages.find((message) => message.id === sourcePicker.source.messageId);
        if (!thread || !message || message.content !== sourcePicker.source.content || !stableMessage(message)) throw new Error("来源已变化，请返回回答重新选取。");
        const item = discussionSources(latest.current.document!, [thread]).find((item) => item.messageId === message.id)!;
        const captured = await snapshotReference(item, start, end); assertCurrent(origin);
        if (version !== panelVersion.current) return;
        setSource(captured); setRetryOf(undefined); setTargetThreadId(""); setTargetNodeId(""); showPanel(sourcePicker.kind);
      }} />
    </WorkspaceDialog>}
    {(panel === "proposal" || panel === "execution") && source && props.document && <WorkspaceDialog title={panel === "proposal" ? "采纳到文档" : "据此执行"} onClose={closePanel}>
      {permissionPanel}
      {error && <p className="outcomeError" role="alert">{error}</p>}
      <OutcomePreparation key={`${panel}:${source.id}:${retryOf || ""}`} kind={panel} source={source} document={props.document} threads={props.threads} busy={busy} cwd={snapshot.cwd} permission={props.permission} retryOf={retryOf} initialRecord={snapshot.records.find((record) => record.id === retryOf)} onUpdateSource={setSource} onStart={(value) => {
        const origin = epoch.current; const version = panelVersion.current;
        return perform(async () => {
          if (!await latest.current.flush()) throw new Error("请先处理文档保存失败，再开始操作。"); assertCurrent(origin);
          const saved = await api.document(); assertCurrent(origin);
          if (panel === "proposal") assertPreparationTarget(value, saved);
          const checks = await projectApi.checkReferences([source]); assertCurrent(origin);
          if (checks[0]?.state !== "current" || preparationSourceNeedsUpdate(source, checks[0])) throw new Error("来源版本已变化或不可用，请明确选择新版来源后再开始。");
          const { targetDocument: _targetDocument, ...input } = value;
          const result = await outcomeApi.start({ kind: panel, source, ...input, retryOf, documentPath: saved.path, documentRevision: saved.revision }); assertCurrent(origin);
          keepRecord(result.record);
          if (version === panelVersion.current) { setSelectedRecord(result.record.id); setSelectedCitation(null); setFilter({}); showPanel("records"); }
          void refresh().catch((caught) => reportCurrent(origin, caught));
        });
      }} />
    </WorkspaceDialog>}
    {panel === "reference" && source && <WorkspaceDialog title="引用到其他讨论" onClose={closePanel}>
      {permissionPanel}
      {error && <p className="outcomeError" role="alert">{error}</p>}<SourceSnapshot source={source} /><p>将来源加入目标输入框，确认资料和问题后发送。</p>
      <label>目标讨论<select value={targetThreadId} onChange={(event) => { setTargetThreadId(event.target.value); setTargetNodeId(""); }}><option value="">新建独立讨论</option>{props.threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}</select></label>
      {targetThread && <label>目标节点<select value={targetNodeId} onChange={(event) => setTargetNodeId(event.target.value)}><option value="">{targetThread.messages.length ? "选择要继续追问的节点" : "根问题"}</option>{targetThread.messages.filter((message) => message.role === "user" && message.id === (message.nodeId || message.id)).map((message) => <option key={message.id} value={message.id}>{message.content.slice(0, 80)}</option>)}</select></label>}
      <button className="primary" disabled={busy || Boolean(targetThread?.messages.length && !targetNodeId)} onClick={() => { const origin = epoch.current; void perform(async () => {
        const from = latest.current.threads.find((thread) => thread.id === source.threadId);
        if (!from) throw new Error("来源讨论已删除，请重新选择。");
        const target = targetThread || await latest.current.createIndependent(from, "基于引用的新讨论", "references"); assertCurrent(origin);
        const key = threadNodeDraftKey(target.id, targetNodeId || null);
        latest.current.setReferences(key, appendReference(latest.current.referenceDrafts[key] || [], source));
        locate(target, targetNodeId || null); closePanel(); latest.current.setStatus("引用已加入目标输入框，尚未发送");
      }); }}>加入输入框</button>
    </WorkspaceDialog>}
    {panel === "records" && <WorkspaceDialog title="成果记录" wide onClose={closePanel}>
      {permissionPanel}
      {error && <p className="outcomeError" role="alert">{error}</p>}
      {citationError && <p className="outcomeError" role="alert">引用列表：{citationError}<button onClick={() => setCitationRefresh((value) => value + 1)}>重试读取引用</button></p>}
      {activityLabel && <p className="outcomeActivity">{activityLabel}<button disabled={!canStop} onClick={actions.stop}>停止当前执行</button></p>}
      <div className="outcomeRecords"><aside aria-label="成果与引用列表"><details className="outcomeRecordPicker" open><summary>成果与引用 · {visibleRecords.length + visibleCitations.length} 项</summary><div className="outcomeRecordRows"><button onClick={() => { setFilter({}); setSelectedRecord(null); setSelectedCitation(null); }}>全部记录</button>{(filter.threadId || filter.messageId) && <small>当前仅看所选来源 · {visibleRecords.length} 项成果 / {visibleCitations.length} 次引用</small>}
        {!visibleRecords.length && !visibleCitations.length && <p>没有匹配的成果或引用。可以切换“全部记录”。</p>}
        {visibleRecords.map((item) => <button aria-pressed={record?.id === item.id && !citation} className={record?.id === item.id && !citation ? "active" : ""} key={item.id} onClick={() => { setSelectedRecord(item.id); setSelectedCitation(null); }}><span>{item.title}</span><small>{outcomeStatus[item.status]} · {new Date(item.createdAt).toLocaleDateString()}</small></button>)}
        {visibleCitations.length > 0 && <h3>已保存引用 · {visibleCitations.length}</h3>}{visibleCitations.map((item) => <button key={citationKey(item)} aria-pressed={selectedCitation === citationKey(item)} onClick={() => { setSelectedCitation(citationKey(item)); setSelectedRecord(null); }}><span>引用到：{item.title}</span><small>{item.documentPath}</small></button>)}
      </div></details></aside>
        {citation ? <article className="outcomeDetail" aria-label="引用详情"><h3>引用到：{citation.title}</h3><p>来源快照与目标消息均来自已保存记录。</p><SourceSnapshot source={citation.reference} /><h4>目标讨论中的消息</h4><pre>{citation.targetContent}</pre><p>{citation.documentPath}</p><button disabled={!citation.available || (busy && citation.documentPath !== path)} onClick={() => { void openProjectDocument(citation.documentPath, undefined, citation.targetThreadId, citation.targetMessageId).catch((caught) => setError(String(caught))); }}>打开目标讨论</button><button disabled={busy && citation.reference.documentPath !== path} onClick={() => { void openProjectDocument(citation.reference.documentPath, undefined, citation.reference.threadId, citation.reference.messageId).catch((caught) => setError(String(caught))); }}>打开来源讨论</button>{!citation.available && <p>目标文档当前不可用，已保存的引用仍可回看。</p>}</article>
          : record ? <OutcomeDetail key={`${record.documentPath}:${record.id}`} record={record} records={snapshot.records} document={props.document} sourceThread={props.threads.find((thread) => thread.id === record.source.threadId)} busy={busy} mutating={acting} canAcknowledge={canAcknowledge} onLocate={() => { const thread = props.threads.find((item) => item.id === record.source.threadId); const message = thread?.messages.find((item) => item.id === record.source.messageId); if (thread && message) { locate(thread, message.role === "user" ? message.nodeId || message.id : message.nodeId || message.parentId || null); closePanel(); } }} onRetry={() => prepareRetry(record)} onAction={async (action, body) => {
            const origin = epoch.current; const version = panelVersion.current;
            await perform(async () => {
              const command = await prepareOutcomeChange(action, body || {}, record.documentPath, { flush: latest.current.flush, document: api.document }); assertCurrent(origin);
              const baseline = latest.current.threads;
              const result = await outcomeApi.change(record.id, action, command); assertCurrent(origin);
              if (result.document && latest.current.apply(result.document) && result.threads) mergeThreads(result.threads, baseline, origin);
              if (result.record) { keepRecord(result.record); if (version === panelVersion.current) setSelectedRecord(result.record.id); }
              if (action === "delete") { refreshVersion.current++; setSnapshot((current) => ({ ...current, records: current.records.filter((item) => item.id !== record.id) })); if (version === panelVersion.current) setSelectedRecord(null); }
              void refresh().catch((caught) => reportCurrent(origin, caught));
            });
          }} /> : <div className="outcomeEmpty"><span>◇</span><h3>{selectedRecord ? "正在定位指定成果" : "把讨论变成可追溯的成果"}</h3><p>{selectedRecord ? "记录可能已删除或尚未刷新。当前筛选不会隐藏指定记录。" : "选择记录，查看提案、实际执行与来源快照。"}</p>{selectedRecord && <button onClick={() => void refresh().catch((caught) => setError(String(caught)))}>重新读取</button>}</div>}
      </div>
    </WorkspaceDialog>}
  </DiscussionWorkspaceContext>;
}
