import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentRunStatus, DocumentPayload, OutcomeRecord, ProposalTarget, ReferenceSnapshot, Thread } from "../types";
import { resolveThreadAnchor } from "../thread-anchors";
import { appendReference, discussionSources, isReferenceAcknowledged, referenceAcknowledgementVersion } from "../discussion-references";
import type { ReferenceCheck } from "../project-api";
import { useReferenceChecks } from "../hooks/useReferenceChecks";
import { AgentRunTimeline } from "./AgentRunTimeline";

export const outcomeStatus: Record<OutcomeRecord["status"], string> = {
  generating: "正在生成", review: "待审核", applying: "正在应用", applied: "已应用", discarded: "已放弃", conflict: "正文冲突",
  running: "正在执行", stopping: "正在停止", completed: "已结束", failed: "失败", interrupted: "已中断", unknown: "结果未知", undone: "已撤回"
};

const draftMemory = new Map<string, unknown>();
export function readOutcomeDraft<T>(key: string): T | null {
  if (draftMemory.has(key)) return draftMemory.get(key) as T;
  try { return typeof window === "undefined" ? null : JSON.parse(window.localStorage.getItem(key) || "null") as T | null; } catch { return null; }
}
export function saveOutcomeDraft(key: string, value: unknown) {
  draftMemory.set(key, value);
  try { if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* The current session still retains the draft. */ }
}
export function clearOutcomeDraft(key: string, requestKey: string) {
  if (readOutcomeDraft<{ requestKey?: string }>(key)?.requestKey !== requestKey) return;
  draftMemory.delete(key);
  try { if (typeof window !== "undefined") window.localStorage.removeItem(key); } catch { /* A submitted draft is no longer needed in memory. */ }
}

export function WorkspaceDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    // React may reuse this component between preparation, records and reference panels.
    // Capture the element, not the mutable ref, so an old cleanup cannot close its replacement.
    const dialog = ref.current;
    const previous = globalThis.document?.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLElement>("[data-outcome-goal]")?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [title]);
  return <dialog key={title} ref={ref} aria-labelledby={titleId} className={`outcomeDialog ${wide ? "wide" : ""}`} data-discussion-overlay="true" onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape" && event.target instanceof Element) {
      const details = event.target.closest("details[open]");
      if (details instanceof HTMLDetailsElement) { event.preventDefault(); details.open = false; details.querySelector("summary")?.focus(); }
    }
  }}>
    <header><div><span className="outcomeEyebrow">玄鸟 / WORKSPACE</span><h2 id={titleId}>{title}</h2></div><button type="button" aria-label="关闭面板" onClick={onClose}>关闭 ×</button></header>
    {children}
  </dialog>;
}

export function SourceSnapshot({ source, status, children }: { source: ReferenceSnapshot; status?: ReactNode; children?: ReactNode }) {
  return <details className="outcomeSource"><summary>来源 · {source.title} · {source.end - source.start} 字符{status && <span className="outcomeSourceState">{status}</span>}</summary><small>{source.documentPath} · 范围 {source.start}–{source.end} · 快照 {source.revision.slice(0, 8)}</small><pre tabIndex={0} aria-label={`${source.title}的来源快照`}>{source.content}</pre>{children}</details>;
}

export function outcomeReferences(record: OutcomeRecord): ReferenceSnapshot[] {
  return (record.references || []).reduce((items, reference) => appendReference(items, reference), [record.source]);
}
export function appliedOutcomeCount(records: OutcomeRecord[]): number {
  return new Set(records.filter((record) => record.kind === "proposal" && record.status === "applied" && !record.inverseOf).map((record) => `${record.documentPath}:${record.id}`)).size;
}
export function outcomeAcknowledgementKey(record: Pick<OutcomeRecord, "documentPath" | "id">, reference: ReferenceSnapshot): string {
  return `xuanniao:outcome-evidence:${encodeURIComponent(record.documentPath)}:${encodeURIComponent(record.id)}:${encodeURIComponent(reference.id)}`;
}
export function OutcomeReferenceState({ check, acknowledged }: { check?: ReferenceCheck; acknowledged?: string }) {
  return <span>{!check ? "尚未核对" : check.state === "missing" ? "来源不可用 · 快照保留" : check.state === "changed"
    ? isReferenceAcknowledged(check, acknowledged) ? "已保留当前依据" : "依据已更新" : check.relocated ? "原文位置已移动" : "依据未变"}</span>;
}
function OutcomeReferenceBatch({ record, references }: { record: OutcomeRecord; references: ReferenceSnapshot[] }) {
  const { checks, checking, error, refresh } = useReferenceChecks(references);
  const [acknowledged, setAcknowledged] = useState<Record<string, string>>(() => Object.fromEntries(references.map((reference) => [reference.id, readOutcomeDraft<string>(outcomeAcknowledgementKey(record, reference)) || ""])));
  return <div className="outcomeEvidenceBatch">
    <button type="button" disabled={checking} onClick={refresh}>{checking ? "正在核对来源…" : "检查来源版本"}</button>
    {error && <p className="outcomeError" role="alert">{error}。保留快照与上次检查结果。</p>}
    {references.map((reference) => {
      const check = checks[reference.id];
      const kept = check && isReferenceAcknowledged(check, acknowledged[reference.id]);
      return <SourceSnapshot key={reference.id} source={reference} status={<OutcomeReferenceState check={check} acknowledged={acknowledged[reference.id]} />}>
        {check && <small>检查于 {new Date(check.checkedAt).toLocaleString()}</small>}
        {check?.state === "changed" && <>
          <p>{kept ? "你已查看这一版本的差异并保留原依据；这不表示结论已重新验证。" : "来源变化不会改写历史提案或已应用内容。"}</p>
          {check.latest ? <details><summary>查看当前来源 · {check.latest.revision.slice(0, 8)}</summary><pre>{check.latest.content}</pre></details> : <p>新版范围无法唯一定位，请重新选择来源。</p>}
          <button type="button" disabled={checking || kept || !referenceAcknowledgementVersion(check)} onClick={() => {
            const version = referenceAcknowledgementVersion(check);
            if (!version) return;
            saveOutcomeDraft(outcomeAcknowledgementKey(record, reference), version);
            setAcknowledged((current) => ({ ...current, [reference.id]: version }));
          }}>保留当前依据</button>
        </>}
      </SourceSnapshot>;
    })}
  </div>;
}
function OutcomeEvidence({ record }: { record: OutcomeRecord }) {
  const references = outcomeReferences(record);
  return <details className="outcomeEvidence" aria-label="成果来源与版本"><summary>来源与资料 · {references.length} 项历史快照</summary>
    {Array.from({ length: Math.ceil(references.length / 24) }, (_, index) => <OutcomeReferenceBatch key={`${record.documentPath}:${record.id}:${index}`} record={record} references={references.slice(index * 24, (index + 1) * 24)} />)}
  </details>;
}

export function targetOptions(document: DocumentPayload, source?: Thread | null): ProposalTarget[] {
  const location = source && resolveThreadAnchor(document.content, source);
  return [
    ...(location ? [{ mode: "replace" as const, start: location.start, end: location.end, label: "替换讨论关联的原文" }] : []),
    ...discussionSources(document, []).filter((item) => item.key.startsWith("heading:")).flatMap((section) => [
      { mode: "insert" as const, start: section.offset + section.content.length, end: section.offset + section.content.length, label: `追加到章节：${section.title}` },
      { mode: "replace" as const, start: section.offset, end: section.offset + section.content.length, label: `替换章节：${section.title}` }
    ]),
    { mode: "insert", start: document.content.length, end: document.content.length, label: "追加到文档末尾" },
    { mode: "document", start: 0, end: document.content.length, label: "替换整篇文档" }
  ];
}

export function targetOptionKey(target: ProposalTarget): string {
  return JSON.stringify([target.mode, target.start, target.end, target.label]);
}
export function validOutcomeTarget(target: ProposalTarget, document: DocumentPayload): boolean {
  return Number.isInteger(target.start) && Number.isInteger(target.end) && target.start >= 0 && target.end <= document.content.length
    && (target.mode === "insert" ? target.end === target.start : target.mode === "document" ? target.start === 0 && target.end === document.content.length : target.end > target.start);
}

export function TargetPicker({ document, source, value, onChange, requiresConfirmation = false }: { document: DocumentPayload; source?: Thread | null; value: ProposalTarget; requiresConfirmation?: boolean; onChange(value: ProposalTarget): void }) {
  const options = [...new Map(targetOptions(document, source).map((target) => [targetOptionKey(target), target])).values()];
  const key = targetOptionKey;
  const known = options.some((target) => key(target) === key(value));
  return <div className="outcomeTarget"><label>写入目标<select aria-label="写入目标" value={requiresConfirmation ? "unconfirmed" : key(value)} onChange={(event) => { const target = options.find((option) => key(option) === event.target.value); if (target) onChange(target); }}>
    {(!known || requiresConfirmation) && <option value={requiresConfirmation ? "unconfirmed" : key(value)}>{value.label}{requiresConfirmation ? "（原版本目标，需重新确认）" : ""}</option>}
    {options.map((option) => <option key={key(option)} value={key(option)}>{option.label}</option>)}
  </select></label><div className="outcomePositions"><label>起点<input type="number" min={0} max={document.content.length} value={value.start} onChange={(event) => onChange({ ...value, label: "自选原文范围", start: Number(event.target.value), end: value.mode === "insert" ? Number(event.target.value) : value.end })} /></label><label>终点<input type="number" min={value.start} max={document.content.length} disabled={value.mode === "insert"} value={value.end} onChange={(event) => onChange({ ...value, label: "自选原文范围", end: Number(event.target.value) })} /></label></div>
    <details open={requiresConfirmation || undefined}><summary>{value.mode === "insert" ? "查看插入位置附近原文" : "查看将被替换的原文"}</summary><pre>{value.mode === "insert" ? document.content.slice(Math.max(0, value.start - 160), value.start) + "\n┄┄ 在此插入 ┄┄\n" + document.content.slice(value.start, value.start + 160) : document.content.slice(value.start, value.end)}</pre></details>
  </div>;
}

export function DocumentDiff({ before, after }: { before: string; after: string }) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return <div className="outcomeDiff"><section><h3>修改前</h3><pre tabIndex={0} aria-label="修改前全文">{before.slice(0, start)}<del>{before.slice(start, before.length - end)}</del>{end ? before.slice(-end) : ""}</pre></section><section><h3>修改后</h3><pre tabIndex={0} aria-label="修改后全文">{after.slice(0, start)}<ins>{after.slice(start, after.length - end)}</ins>{end ? after.slice(-end) : ""}</pre></section></div>;
}

export type OutcomeEditDraft = { replacement: string; baseReplacement: string; instruction: string; evidence: string; baseEvidence: string; target: ProposalTarget; baseTarget: ProposalTarget; sourceChanged?: boolean };
export function reconcileOutcomeDraft(draft: OutcomeEditDraft, record: OutcomeRecord): OutcomeEditDraft {
  const replacement = record.replacement || "";
  const evidence = record.verificationNote || "";
  const target = record.target || { mode: "insert" as const, start: 0, end: 0, label: "" };
  return { ...draft,
    sourceChanged: draft.replacement !== replacement && (draft.sourceChanged || (draft.replacement !== draft.baseReplacement && replacement !== draft.baseReplacement)),
    replacement: draft.replacement === draft.baseReplacement ? replacement : draft.replacement,
    baseReplacement: replacement,
    evidence: draft.evidence === draft.baseEvidence ? evidence : draft.evidence, baseEvidence: evidence,
    target: JSON.stringify(draft.target) === JSON.stringify(draft.baseTarget) ? target : draft.target, baseTarget: target
  };
}

export function executionTimelineStatus(status: OutcomeRecord["status"]): AgentRunStatus {
  return ["running", "stopping", "completed", "failed", "interrupted", "unknown"].includes(status) ? status as AgentRunStatus : "waiting";
}

export function outcomeOrigin(record: OutcomeRecord): "discussion" | "outcome" | "document-creation" | "unavailable" {
  if (record.origin) return record.origin;
  // Older ordinary-run recovery records used the original question as both identities.
  if (record.kind === "execution" && record.messageId && record.source.messageId === record.messageId) return "discussion";
  return record.source.kind === "document" ? "unavailable" : "outcome";
}

export function OutcomeDetail({ record, records, document, sourceThread, busy, mutating = false, canAcknowledge = !busy, readonly = false, onAction, onRetry, onLocate }: {
  record: OutcomeRecord; records: OutcomeRecord[]; document?: DocumentPayload | null; sourceThread?: Thread;
  busy: boolean; mutating?: boolean; canAcknowledge?: boolean; readonly?: boolean; onAction?(action: string, body?: Record<string, unknown>): Promise<void>; onRetry?(): void; onLocate?(): void;
}) {
  const key = `xuanniao:outcome-edit:${record.documentPath}:${record.id}`;
  const [draft, setDraft] = useState<OutcomeEditDraft>(() => {
    const stored = readOutcomeDraft<OutcomeEditDraft>(key);
    const target = record.target || { mode: "insert" as const, start: 0, end: 0, label: "" };
    return stored && typeof stored.replacement === "string" && stored.target ? reconcileOutcomeDraft(stored, record)
      : { replacement: record.replacement || "", baseReplacement: record.replacement || "", instruction: "", evidence: record.verificationNote || "", baseEvidence: record.verificationNote || "", target, baseTarget: target };
  });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  useEffect(() => { setDraft((current) => reconcileOutcomeDraft(current, record)); }, [record.replacement, record.verificationNote, JSON.stringify(record.target)]);
  useEffect(() => { if (!readonly) saveOutcomeDraft(key, draft); }, [key, draft, readonly]);
  const { replacement, instruction, evidence, target } = draft;
  const change = (patch: Partial<OutcomeEditDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setReplacement = (replacement: string) => change({ replacement });
  const setInstruction = (instruction: string) => change({ instruction });
  const setEvidence = (evidence: string) => change({ evidence });
  const setTarget = (target: ProposalTarget) => change({ target });
  const editable = !readonly && ["review", "conflict", "failed", "interrupted"].includes(record.status);
  const dirty = replacement !== (record.replacement || "");
  const blocked = busy || mutating || pending;
  const acknowledgementBlocked = !canAcknowledge || mutating || pending;
  const action = async (name: string, body = {}) => {
    if (!onAction || pendingRef.current || (name === "acknowledge" ? acknowledgementBlocked : blocked)) return;
    pendingRef.current = true; setPending(true); setActionError("");
    try { await onAction(name, { expectedRevision: record.revision, ...body }); }
    catch (caught) { setActionError(caught instanceof Error ? caught.message : String(caught)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  const retryOrigin = outcomeOrigin(record);
  const createdPath = retryOrigin === "document-creation" ? record.newDocumentPath || record.creationResult?.path : undefined;
  const sourceAvailable = sourceThread?.messages.some((message) => message.id === record.source.messageId);
  return <article className="outcomeDetail" aria-label="成果详情" tabIndex={-1}>
    <div className="outcomeRecordTitle"><h3>{record.title}</h3><span className={`outcomeStatus ${record.status}`}>{outcomeStatus[record.status]}</span></div>
    <small>{new Date(record.createdAt).toLocaleString()} · {record.kind === "proposal" ? "文档提案" : retryOrigin === "document-creation" ? "文档创建" : "执行记录"}</small>
    {record.error && record.error.trim() !== record.result?.trim() && <p className="outcomeError" role="status">{record.error}</p>}
    {actionError && <p className="outcomeError" role="alert">{actionError}</p>}
    {draft.sourceChanged && !readonly && <p role="status">已保存的提案内容有变化；你的调整草稿仍保留，请核对 Diff 后保存。</p>}
    {record.kind === "proposal" && !readonly && <div className="outcomePrimaryActions" aria-label="提案主要操作">
      {editable && <><button disabled={blocked || dirty || record.status !== "review" || Boolean(document && document.revision !== record.baseRevision)} className="primary" onClick={() => action("apply")}>采纳并写入文档</button><button disabled={blocked || !dirty} onClick={() => action("edit", { replacement })}>保存调整并更新 Diff</button></>}
      {record.status === "applied" && !record.inverseOf && <button disabled={blocked} onClick={() => action("undo")}>撤销这次采纳</button>}
      {pending && <span role="status">正在处理 · 关闭不会丢失草稿</span>}
    </div>}
    {record.kind === "proposal" ? <>
      <p>目标：{record.target?.label} · {record.target?.start}–{record.target?.end}</p>
      {record.inverseOf && records.find((item) => item.id === record.inverseOf) && <details><summary>查看原采纳的差异</summary><DocumentDiff before={records.find((item) => item.id === record.inverseOf)?.baseContent || ""} after={records.find((item) => item.id === record.inverseOf)?.proposedContent || ""} /></details>}
      {record.proposedContent !== undefined && <DocumentDiff before={record.baseContent || ""} after={record.proposedContent} />}
      {editable && <><label>调整提案内容<textarea aria-label="调整提案内容" disabled={blocked} rows={10} value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label><div className="outcomeButtons"><button disabled={blocked} onClick={() => action("discard")}>放弃提案</button></div>
        {document && (record.status === "conflict" || document.revision !== record.baseRevision) && <details open><summary>正文已变化 · 重新确认写入目标</summary><p>保留提案内容，在当前正文上重新生成 Diff。请检查目标，避免覆盖后续编辑。</p><TargetPicker document={document} source={sourceThread} value={target} onChange={setTarget} /><button disabled={blocked || dirty || !validOutcomeTarget(target, document)} onClick={() => action("rebase", { target })}>按当前正文重新准备审核</button></details>}
        <label>继续调整要求<input disabled={blocked} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：保留原章节结构，补充验收条件" /></label><button disabled={blocked || dirty || !instruction.trim()} onClick={() => action("refine", { instruction })}>让 AI 继续调整</button>
      </>}
    </> : <>
      {createdPath && <p>已创建文件：<code>{createdPath}</code></p>}
      <p>{retryOrigin === "document-creation" ? "工作目录" : "执行目录"}：<code>{record.cwd || "未记录"}</code> · 权限：{record.permissionMode || "未记录"}</p>
      <details open><summary>目标限制与验收条件</summary><pre>{record.restrictions || "无额外限制"}</pre><pre>{record.acceptance || "未提供验收条件"}</pre></details>
      <AgentRunTimeline message={{ id: record.id, role: "assistant", content: record.result || "", createdAt: record.createdAt, meta: { updates: record.events || [], agentRun: { id: record.id, status: executionTimelineStatus(record.status), events: record.events || [], startedAt: record.createdAt, completedAt: record.updatedAt, error: record.error?.trim() === record.result?.trim() ? null : record.error || null, durationMs: null } } }} />
      {record.result && <pre className="outcomeResult">{record.result}</pre>}
      <p>验收：{record.verification === "passed" ? "已记录通过证据" : record.verification === "failed" ? "检查未通过" : "尚未核对证据"}。运行结束不代表验收通过。</p>
      {!readonly && (["completed", "failed", "interrupted"].includes(record.status) || (record.status === "unknown" && record.recoveryAcknowledged)) && <><label>验证证据<textarea disabled={blocked} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="逐项填写检查方式、命令输出及尚未验证的部分" /></label><div className="outcomeButtons"><button disabled={blocked || !evidence.trim()} onClick={() => action("verify", { verification: "passed", verificationNote: evidence })}>记录检查通过</button><button disabled={blocked || !evidence.trim()} onClick={() => action("verify", { verification: "failed", verificationNote: evidence })}>记录未通过</button></div></>}
      {!readonly && (["completed", "failed", "interrupted"].includes(record.status) || (record.status === "unknown" && record.recoveryAcknowledged)) && <button disabled={blocked || !onRetry || retryOrigin === "unavailable"} onClick={onRetry}>{retryOrigin === "document-creation" ? "重新准备创建文档" : retryOrigin === "discussion" ? "核对原问题并重新执行" : retryOrigin === "unavailable" ? "无法识别原入口，请重新准备" : "准备再次执行"}</button>}
      {readonly && record.verificationNote && <pre>{record.verificationNote}</pre>}
    </>}
    <OutcomeEvidence record={record} />
    {record.source.kind === "document" ? <p>来源文档：<code>{record.source.documentPath}</code> · 操作前快照已保留</p>
      : onLocate && <button disabled={!sourceAvailable} onClick={onLocate}>{sourceAvailable ? "定位来源讨论" : "原讨论已删除 · 已保留快照"}</button>}
    <details><summary>本次要求</summary><pre>{record.instruction}</pre></details>
    {!readonly && record.status === "unknown" && !record.recoveryAcknowledged && <div className="outcomeRecovery"><p>请检查当前文件和原 Agent 进程，确认它不会继续写入后再继续。已有修改不会自动撤销。</p><button disabled={acknowledgementBlocked} onClick={() => { if (window.confirm("已检查当前文件，并确认原 Agent 进程已经结束、不会继续写入？")) action("acknowledge", { confirmed: true }); }}>已核对原进程和文件</button></div>}
    {!readonly && !["running", "stopping", "generating", "applying"].includes(record.status) && <button className="outcomeDelete" disabled={blocked} onClick={() => { if (window.confirm("删除本地成果记录后，将失去这条记录的回看和撤销入口。正文与其他讨论中的引用快照仍保留。确定删除？")) action("delete"); }}>删除本地记录</button>}
  </article>;
}
