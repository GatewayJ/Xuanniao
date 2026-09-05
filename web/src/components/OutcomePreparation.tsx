import { useEffect, useRef, useState } from "react";
import type { DocumentPayload, OutcomeRecord, ProposalTarget, ReferenceSnapshot, Thread } from "../types";
import type { ReferenceCheck } from "../project-api";
import { useReferenceChecks } from "../hooks/useReferenceChecks";
import { appendReference } from "../discussion-references";
import { ReferenceComposer } from "./ReferenceComposer";
import { buildConversationTree, conversationBreadcrumb } from "../thread-tree";
import { clearOutcomeDraft, readOutcomeDraft, saveOutcomeDraft, OutcomeReferenceState, SourceSnapshot, TargetPicker, targetOptions, validOutcomeTarget, outcomeOrigin } from "./OutcomeReview";

export type OutcomePreparationValue = {
  instruction: string; restrictions: string; acceptance: string; target: ProposalTarget; references: ReferenceSnapshot[]; requestKey: string;
  targetDocument?: { path: string; revision: string; content: string };
};

export function preparationTargetIsCurrent(value: OutcomePreparationValue, document: DocumentPayload): boolean {
  return value.targetDocument?.path === document.path && value.targetDocument.content === document.content;
}

export function confirmPreparationTarget(value: OutcomePreparationValue, document: DocumentPayload, target = value.target): OutcomePreparationValue {
  if (!validOutcomeTarget(target, document)) throw new Error("目标范围无效，请重新选择。");
  return { ...value, target, targetDocument: { path: document.path, revision: document.revision, content: document.content }, requestKey: crypto.randomUUID() };
}

export function assertPreparationTarget(value: OutcomePreparationValue, document: DocumentPayload) {
  if (!preparationTargetIsCurrent(value, document) || !validOutcomeTarget(value.target, document)) {
    throw new Error("正文已变化，请重新核对并确认写入目标；要求草稿已保留。");
  }
}

export function preparationSourceNeedsUpdate(source: ReferenceSnapshot, check?: ReferenceCheck): boolean {
  if (!check) return false;
  if (check.state !== "current") return true;
  const latest = check.latest;
  return Boolean(latest && (latest.revision !== source.revision || latest.start !== source.start || latest.end !== source.end || latest.sourceIdentity !== source.sourceIdentity));
}

export function preparationDraftKey(documentPath: string, kind: string, sourceId: string, retryOf?: string) {
  return `xuanniao:operation-draft:${documentPath}:${kind}:${sourceId}:${retryOf || ""}`;
}
export function initialPreparationValue(kind: "proposal" | "execution", document: DocumentPayload, source: ReferenceSnapshot, threads: Thread[], initialRecord?: OutcomeRecord): OutcomePreparationValue {
  return {
    instruction: initialRecord?.instruction ?? (kind === "proposal" ? "将来源中的结论整理为适合写入目标位置的 Markdown 内容。" : source.content),
    restrictions: initialRecord?.restrictions || "", acceptance: initialRecord?.acceptance || "",
    target: initialRecord?.target || targetOptions(document, threads.find((thread) => thread.id === source.threadId))[0],
    references: (initialRecord?.references || []).filter((reference) => !(reference.kind === source.kind && reference.documentPath === source.documentPath && reference.threadId === source.threadId && reference.messageId === source.messageId && reference.start === source.start && reference.end === source.end && reference.revision === source.revision && reference.sourceIdentity === source.sourceIdentity)),
    targetDocument: { path: document.path, revision: document.revision, content: document.content }, requestKey: crypto.randomUUID()
  };
}

export function OutcomePreparation({ kind, document, source, threads, busy, cwd, permission, retryOf, initialRecord, onUpdateSource, onStart }: {
  kind: "proposal" | "execution"; document: DocumentPayload; source: ReferenceSnapshot; threads: Thread[];
  busy: boolean; cwd: string; permission: string; retryOf?: string; initialRecord?: OutcomeRecord;
  onUpdateSource?(source: ReferenceSnapshot): void; onStart(value: OutcomePreparationValue): Promise<boolean>;
}) {
  const key = preparationDraftKey(document.path, kind, source.id, retryOf);
  const [value, setValue] = useState<OutcomePreparationValue>(() => {
    const stored = readOutcomeDraft<OutcomePreparationValue>(key);
    if (stored && typeof stored.instruction === "string" && typeof stored.requestKey === "string" && stored.target && Array.isArray(stored.references)) return stored;
    return initialPreparationValue(kind, document, source, threads, initialRecord);
  });
  const { checks, checking, error: checkError, refresh } = useReferenceChecks([source]);
  const sourceCheck = checks[source.id];
  const sourceThread = threads.find((thread) => thread.id === source.threadId);
  const sourceMessage = sourceThread?.messages.find((message) => message.id === source.messageId);
  const history = kind === "execution" && sourceThread && sourceMessage
    ? conversationBreadcrumb(buildConversationTree(sourceThread.messages), sourceMessage.nodeId || sourceMessage.id) : [];
  const sourceBlocked = preparationSourceNeedsUpdate(source, sourceCheck);
  const [retryReviewed, setRetryReviewed] = useState(false);
  const retryBlocked = Boolean(retryOf) && !retryReviewed;
  const discussionRetry = initialRecord && outcomeOrigin(initialRecord) === "discussion";
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [error, setError] = useState("");
  const targetValid = kind === "execution" || validOutcomeTarget(value.target, document);
  const targetStale = kind === "proposal" && !preparationTargetIsCurrent(value, document);
  const allReferences = value.references.reduce(appendReference, [source]);
  const referenceChars = allReferences.reduce((sum, reference) => sum + reference.content.length, 0);
  const budgetExceeded = allReferences.length > 24 || referenceChars > 160_000;
  useEffect(() => { saveOutcomeDraft(key, value); }, [key, value]);
  const change = (patch: Partial<OutcomePreparationValue>) => setValue((previous) => ({ ...previous, ...patch, requestKey: crypto.randomUUID() }));
  return <form className="outcomePreparation" onSubmit={(event) => {
    event.preventDefault(); if (startingRef.current || busy || retryBlocked || sourceBlocked || targetStale || budgetExceeded || !targetValid || !value.instruction.trim()) return;
    startingRef.current = true; setStarting(true); setError("");
    void onStart(value).then((saved) => { if (saved) clearOutcomeDraft(key, value.requestKey); else refresh(); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => { startingRef.current = false; setStarting(false); });
  }}>
    <SourceSnapshot source={discussionRetry ? { ...source, title: `原问题 · ${source.title}` } : source} status={<OutcomeReferenceState check={sourceCheck} />} />
    {checkError && <p role="alert">来源检查失败：{checkError}<button type="button" disabled={checking} onClick={refresh}>重新检查</button></p>}
    {sourceBlocked && <div className="outcomeError" role="status"><p>来源版本、位置已变化或当前不可用，原快照和要求草稿均保留。请查看新版后明确选择来源。</p>
      {sourceCheck?.latest && <details><summary>查看新版来源</summary><pre>{sourceCheck.latest.content}</pre></details>}
      {sourceCheck?.latest && onUpdateSource ? <button type="button" disabled={starting} onClick={() => {
        const updated = sourceCheck.latest!;
        const nextValue = { ...value, references: value.references.map((reference) => reference.id === source.id ? updated : reference), requestKey: crypto.randomUUID() };
        saveOutcomeDraft(preparationDraftKey(document.path, kind, updated.id, retryOf), nextValue);
        onUpdateSource(updated);
      }}>使用已查看的新版来源</button> : <p>无法唯一定位新版选段，请返回来源回答重新选择。</p>}
    </div>}
    {error && <p className="outcomeError" role="alert">{error}</p>}
    {targetStale && <p role="status">目标来自旧版正文或尚未确认。请重新选择目标，或核对下方原文后确认当前范围。要求草稿已保留。</p>}
    {!targetValid && <p className="outcomeError" role="alert">目标范围无效，请选择当前文档中的有效位置。</p>}
    <fieldset disabled={starting}>
    <p>{kind === "proposal" ? "生成提案使用只读会话；审核并采纳后写入当前 Markdown。" : `直接执行 · ${cwd || "当前工作目录"} · 权限：${permission}。开始后可能修改本地文件。`}</p>
    {retryOf && <section aria-label="前次执行核对"><p>开始后创建新的执行记录，旧问题与输出保留。Agent 将先检查当前文件与前次结果，已有文件修改不会撤销。</p>
      <details open><summary>前次要求与输出 · 请核对部分结果</summary><pre>{initialRecord?.instruction || source.content}</pre><pre>{initialRecord?.result || initialRecord?.error || "前次未保存输出，请核对当前文件与运行记录。"}</pre></details>
      <label><input type="checkbox" checked={retryReviewed} onChange={(event) => setRetryReviewed(event.target.checked)} />已核对前次输出和当前文件，准备开始新的执行</label>
    </section>}
    <label>{kind === "proposal" ? "整理要求" : "执行目标"}<textarea data-outcome-goal="true" autoFocus rows={5} value={value.instruction} onChange={(event) => change({ instruction: event.target.value })} required /></label>
    {kind === "proposal" ? <><TargetPicker document={document} source={threads.find((thread) => thread.id === source.threadId)} value={value.target} requiresConfirmation={targetStale} onChange={(target) => {
      if (validOutcomeTarget(target, document)) setValue((previous) => confirmPreparationTarget(previous, document, target));
      else change({ target });
    }} />{targetStale && <button type="button" disabled={!targetValid} onClick={() => setValue((previous) => confirmPreparationTarget(previous, document))}>已核对当前正文与目标范围</button>}</> : <>
      <label>限制条件<textarea rows={2} value={value.restrictions} onChange={(event) => change({ restrictions: event.target.value })} placeholder="例如：只改上传模块，保留现有接口" /></label>
      <label>验收条件<textarea rows={3} value={value.acceptance} onChange={(event) => change({ acceptance: event.target.value })} placeholder="例如：断点恢复测试通过，并记录验证命令与结果" /></label>
      <p>{discussionRetry ? "将从原问题创建新的子问题，继承原分支历史，保留旧回答与部分输出。" : "将从来源回答继续追问，继承其祖先分支历史；这里添加的资料是本轮补充资料。"}</p>
    </>}
    <ReferenceComposer document={document} threads={threads} references={value.references} onChange={(references) => change({ references })} inheritsHistory={kind === "execution"} history={history} />
    <p role={budgetExceeded ? "alert" : undefined}>资料：最多 24 项（含操作来源），160,000 字符总预算。当前 {allReferences.length} 项、{referenceChars.toLocaleString()} 字符。{budgetExceeded && "请缩小来源范围或移除部分补充资料后再开始。"}</p>
    </fieldset>
    <footer><span>{busy ? "当前执行结束后可开始，草稿已保留" : "准备完成后再开始"}</span><button className="primary" disabled={busy || starting || retryBlocked || sourceBlocked || targetStale || budgetExceeded || !targetValid || !value.instruction.trim()} type="submit">{starting ? "正在提交…" : kind === "proposal" ? "生成修改提案" : "开始执行"}</button></footer>
  </form>;
}

export function OutcomeSourcePicker({ source, selectedText, busy, onConfirm }: {
  source: ReferenceSnapshot; selectedText: string; busy: boolean; onConfirm(start: number, end: number): Promise<void>;
}) {
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [error, setError] = useState("");
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  async function confirm(start: number, end: number) {
    if (busy || pendingRef.current || start < 0 || end <= start || end > source.content.length) return;
    pendingRef.current = true; setPending(true); setError("");
    try { await onConfirm(start, end); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { pendingRef.current = false; setPending(false); }
  }
  return <section className="outcomeSourcePicker">
    <p>该选段无法唯一对应到 Markdown 原文。请在下面的原文中重新选择范围，再继续操作。</p>
    <blockquote>{selectedText}</blockquote>
    <label>来源 Markdown 原文<textarea readOnly rows={14} value={source.content} aria-label="重新选择来源原文片段" onSelect={(event) => setRange({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} /></label>
    <p role="status">{range.end > range.start ? `已选 ${range.end - range.start} 字符 · ${range.start}–${range.end}` : "尚未选择原文片段"}</p>
    {error && <p className="outcomeError" role="alert">{error}</p>}
    <div className="outcomeButtons"><button type="button" className="primary" disabled={busy || pending || range.end <= range.start} onClick={() => void confirm(range.start, range.end)}>使用明确选段</button><button type="button" disabled={busy || pending} onClick={() => void confirm(0, source.content.length)}>改为使用整条回答</button></div>
  </section>;
}
