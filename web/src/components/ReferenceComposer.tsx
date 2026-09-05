import { useEffect, useId, useMemo, useRef, useState } from "react";
import { appendReference, discussionSources, snapshotReference, referenceAvailability, REFERENCE_DRAG_TYPE, selectedReferenceRange, referenceAcknowledgementKey, referenceAcknowledgementVersion, isReferenceAcknowledged } from "../discussion-references";
import type { ReferenceSource, ReferenceAvailability } from "../discussion-references";
import type { DocumentPayload, ReferenceSnapshot, Thread } from "../types";
import { ProjectReferencePicker } from "./ProjectReferencePicker";
import { useReferenceChecks } from "../hooks/useReferenceChecks";
import type { ReferenceCheck } from "../project-api";
import type { ConversationNode } from "../thread-tree";
import { ReferenceContextPreview, type ReferenceContextKind } from "./ReferenceContextPreview";

type Props = {
  document: DocumentPayload;
  threads: Thread[];
  references: ReferenceSnapshot[];
  onChange: (references: ReferenceSnapshot[]) => void;
  scope?: "full" | "references";
  inheritsHistory?: boolean;
  history?: ConversationNode[];
  selectedText?: string;
  selectionUnavailable?: boolean;
  disabled?: boolean;
  onLocate?: (reference: ReferenceSnapshot) => void;
};

export function ReferenceComposer(props: Props) {
  const [picking, setPicking] = useState(false);
  const [context, setContext] = useState<ReferenceContextKind | null>(null);
  const contextId = useId();
  const contextTrigger = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [localAvailability, setLocalAvailability] = useState<Record<string, ReferenceAvailability>>({});
  const externalReferences = useMemo(() => props.references.filter((reference) => reference.documentPath !== props.document.path), [props.references, props.document.path]);
  const remote = useReferenceChecks(externalReferences);
  const availability = { ...localAvailability, ...remote.checks };
  const sources = useMemo(() => discussionSources(props.document, props.threads), [props.document, props.threads]);
  useEffect(() => {
    if ((context === "selection" && (!props.selectedText || props.scope === "references")) || (context === "history" && !props.inheritsHistory)) setContext(null);
  }, [context, props.selectedText, props.scope, props.inheritsHistory]);
  function closeContext() {
    setContext(null);
    contextTrigger.current?.focus({ preventScroll: true });
  }
  function contextButton(kind: ReferenceContextKind, label: string) {
    return <button type="button" className="contextToken" aria-expanded={context === kind} aria-controls={contextId} onClick={(event) => {
      contextTrigger.current = event.currentTarget;
      setContext(context === kind ? null : kind);
    }}><span aria-hidden="true">{context === kind ? "▾" : "▸"}</span> {label}</button>;
  }
  useEffect(() => {
    let cancelled = false;
    Promise.all(props.references.filter((reference) => reference.documentPath === props.document.path).map(async (reference) => [reference.id, await referenceAvailability(reference, sources)] as const))
      .then((entries) => { if (!cancelled) setLocalAvailability(Object.fromEntries(entries)); })
      .catch(() => { if (!cancelled) setError("无法核对来源版本，请重新打开资料选择器。"); });
    return () => { cancelled = true; };
  }, [props.references, sources]);
  async function add(source: ReferenceSource, range = { start: 0, end: source.content.length }) {
    setAdding(true);
    setError("");
    try {
      const ref = await snapshotReference(source, range.start, range.end);
      const next = appendReference(props.references, ref);
      if (next.length > 24) throw new Error("最多添加 24 项资料，请先移除不需要的引用。");
      if (next.reduce((sum, item) => sum + item.content.length, 0) > 160_000) {
        throw new Error("资料超过 160,000 字符，请缩小引用范围。");
      }
      props.onChange(next);
      setPicking(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setAdding(false); }
  }
  return (
    <div className="referenceComposer" onDragOver={(event) => {
      if (!props.disabled && event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
    }} onDrop={(event) => {
      const data = event.dataTransfer.getData(REFERENCE_DRAG_TYPE);
      if (!data || props.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        const input = JSON.parse(data);
        const source = sources.find((item) => (!input.documentPath || item.documentPath === input.documentPath) && item.threadId === input.threadId && item.messageId === input.messageId);
        if (!source) throw new Error("来源已不可用，请重新选择。");
        void add(source, selectedReferenceRange(source, input.text));
      } catch (caught) { setError(caught instanceof Error ? caught.message : "无法添加引用"); }
    }} onKeyDown={(event) => {
      if (event.key === "Escape" && picking) { event.preventDefault(); event.stopPropagation(); setPicking(false); }
      else if (event.key === "Escape" && event.target instanceof HTMLElement) {
        const details = event.target.closest("details[open]");
        if (details instanceof HTMLDetailsElement) { event.preventDefault(); event.stopPropagation(); details.open = false; details.querySelector("summary")?.focus(); }
        else if (context) { event.preventDefault(); event.stopPropagation(); closeContext(); }
      }
    }}>
      <div className="referenceBar">
        <span className="referenceLabel"><i /> 本轮参考</span>
        {contextButton("scope", props.scope === "references" ? "仅所选资料" : "完整文档背景")}
        {props.inheritsHistory && contextButton("history", "分支历史")}
        {props.selectedText && props.scope !== "references" && contextButton("selection", "原文选区")}
        <button type="button" className="referenceAdd" disabled={props.disabled || adding} aria-expanded={picking} onClick={() => setPicking(!picking)}>＋ 添加引用</button>
      </div>
      {context && <ReferenceContextPreview id={contextId} kind={context} scope={props.scope} inheritsHistory={props.inheritsHistory}
        history={props.history} selectedText={props.selectedText} selectionUnavailable={props.selectionUnavailable} onClose={closeContext} />}
      {props.references.length > 0 && <div className="referenceChips">
        {props.references.map((reference) => {
          const source = reference.kind === "message" ? sources.find((item) => item.documentPath === reference.documentPath && item.threadId === reference.threadId && item.messageId === reference.messageId
            && item.sourceIdentity === reference.sourceIdentity && item.fullContent.slice(reference.start, reference.end) === reference.content) : null;
          const title = source?.title || reference.title;
          return <div className="referenceChip" key={reference.id}>
          <details><summary><span className="referenceChipTitle">{title}{availability[reference.id]?.state === "changed" && <span className="referenceState"> · 版本有变化</span>}{availability[reference.id]?.state === "missing" && <span className="referenceState"> · 原位置不可用</span>}</span><span className="referenceChipExcerpt">{reference.content.replace(/\s+/g, " ").slice(0, 100)}</span></summary>
            <small className="referenceCoordinates">引用正文 · {reference.content.length} 字符</small>
            <small className="referenceCoordinates">{reference.kind === "document" ? "文档" : "讨论节点"} · 字符 {reference.start + 1}–{reference.end} · 版本 {reference.revision.slice(0, 8)}</small>
            <small className="referenceCoordinates">{reference.documentPath}{availability[reference.id]?.checkedAt && <> · 最近检查 <time dateTime={availability[reference.id].checkedAt}>{new Date(availability[reference.id].checkedAt!).toLocaleString()}</time></>}</small>
            <pre>{reference.content}</pre>
            {props.onLocate && <button type="button" disabled={availability[reference.id]?.state === "missing"} onClick={() => props.onLocate?.(reference)}>查看原位置 ↗</button>}
            {availability[reference.id]?.state === "changed" && <div className="referenceRefresh">
              {availability[reference.id].latest ? <><p>当前版本（更新只影响这份草稿）</p><pre>{availability[reference.id].latest!.content}</pre><button type="button" disabled={props.disabled || adding} onClick={() => props.onChange(props.references.reduce<ReferenceSnapshot[]>((items, item) => appendReference(items, item.id === reference.id ? availability[reference.id].latest! : item), []))}>更新为新版</button></> : <p>{availability[reference.id].latestUnavailableReason === "reference_too_large" ? "新版来源超过 160,000 字符，请移除后选择更小的片段。" : "片段已变化，无法确定新的范围，请移除后重新选择。"}</p>}
            </div>}
            {availability[reference.id]?.state === "current" && availability[reference.id].latest && (availability[reference.id].latest!.revision !== reference.revision || availability[reference.id].latest!.start !== reference.start) && <div className="referenceRefresh">
              <p>{availability[reference.id].relocated ? "引用正文未变，来源范围已移动。" : "引用正文未变，来源其他内容有变化。"}</p>
              <button type="button" disabled={props.disabled || adding} onClick={() => props.onChange(props.references.reduce<ReferenceSnapshot[]>((items, item) => appendReference(items, item.id === reference.id ? availability[reference.id].latest! : item), []))}>同步来源位置与版本</button>
            </div>}
            {availability[reference.id]?.state === "missing" && <p className="referenceRefresh">快照仍保留；发送前请移除这项引用或重新选择来源。</p>}
          </details>
          <button type="button" disabled={props.disabled || adding} aria-label={`移除 ${title}`} onClick={() => props.onChange(props.references.filter((item) => item.id !== reference.id))}>×</button>
        </div>; })}
      </div>}
      {picking && <ProjectReferencePicker document={props.document} threads={props.threads} disabled={props.disabled || adding} onAdd={(source, range) => void add(source, range)} />}
      {externalReferences.length > 0 && <div className="workbenchActions"><button type="button" disabled={remote.checking} onClick={remote.refresh}>{remote.checking ? "正在检查来源…" : "检查来源版本"}</button></div>}
      {remote.error && <p className="workbenchError" role="alert">来源检查失败：{remote.error}，请重试。</p>}
      {error && <p className="workbenchError" role="alert">{error}</p>}
    </div>
  );
}

export function ReferenceHistory({ references, onLocate, onReevaluate }: {
  references: ReferenceSnapshot[];
  threads?: Thread[];
  onLocate?: (reference: ReferenceSnapshot) => void;
  onReevaluate?: (references: ReferenceSnapshot[]) => void;
}) {
  const [acknowledged, setAcknowledged] = useState<Record<string, string>>({});
  const { checks, checking, error, refresh } = useReferenceChecks(references);
  const signature = JSON.stringify(references.map(referenceAcknowledgementKey));
  useEffect(() => {
    const stored: Record<string, string> = {};
    try {
      for (const key of JSON.parse(signature) as string[]) {
        const version = localStorage.getItem(key);
        if (version) stored[key] = version;
      }
    } catch { /* Private browsing may disable persistent preferences. */ }
    setAcknowledged(stored);
  }, [signature]);
  function acknowledge(reference: ReferenceSnapshot, check: ReferenceAvailability) {
    const version = referenceAcknowledgementVersion(check);
    if (!version) return;
    const key = referenceAcknowledgementKey(reference);
    setAcknowledged((current) => ({ ...current, [key]: version }));
    try { localStorage.setItem(key, version); } catch { /* Retain acknowledgement for this mounted view. */ }
  }
  if (references.length === 0) return null;
  const hasChanges = references.some((reference) => checks[reference.id]?.state === "changed" && !isReferenceAcknowledged(checks[reference.id], acknowledged[referenceAcknowledgementKey(reference)]));
  return <details className="referenceHistory"><summary>本轮引用 · {references.length} 项快照{hasChanges && " · 来源有变化"}</summary>
    <button type="button" disabled={checking} onClick={refresh}>{checking ? "正在检查…" : "检查引用版本"}</button>
    {error && <p className="workbenchError" role="alert">本次检查失败：{error}。保留上次检查结果及历史快照。</p>}
    {references.map((reference) => <ReferenceHistoryEntry key={reference.id} reference={reference} check={checks[reference.id]} checking={checking}
      acknowledged={acknowledged[referenceAcknowledgementKey(reference)]} onLocate={onLocate} onReevaluate={onReevaluate}
      onAcknowledge={() => acknowledge(reference, checks[reference.id])} />)}
  </details>;
}

export function ReferenceHistoryEntry({ reference, check, checking, acknowledged, onLocate, onReevaluate, onAcknowledge }: {
  reference: ReferenceSnapshot;
  check?: ReferenceCheck;
  checking?: boolean;
  acknowledged?: string;
  onLocate?: (reference: ReferenceSnapshot) => void;
  onReevaluate?: (references: ReferenceSnapshot[]) => void;
  onAcknowledge: () => void;
}) {
  const kept = check && isReferenceAcknowledged(check, acknowledged);
  const ambiguous = check?.reason === "ambiguous_range";
  return <details>
    <summary>{reference.title}{check?.state === "changed" && <span className="referenceState"> · {kept ? "已保留当前依据" : ambiguous ? "引用范围待确认" : "依据已更新"}</span>}{check?.state === "missing" && <span className="referenceState"> · 来源不可用</span>}</summary>
    <small>{reference.documentPath} · 字符 {reference.start + 1}–{reference.end} · 版本 {reference.revision.slice(0, 8)} · 发送时的内容</small><pre>{reference.content}</pre>
    {check ? <small>最近检查 <time dateTime={check.checkedAt}>{new Date(check.checkedAt).toLocaleString()}</time>{check.relocated ? " · 正文未变，引用范围已移动" : check.state === "current" ? " · 引用内容未变" : ""}</small> : <small>尚未检查来源版本</small>}
    {check?.state === "missing" ? <p>来源不可用，已保留发送时的快照。若文档移动或重命名，请重新关联来源。</p>
      : onLocate && <button type="button" onClick={() => onLocate(check?.latest || reference)}>查看原位置 ↗</button>}
    {check?.state === "changed" && <div className="referenceRefresh">
      {check.latest ? <><p>当前来源 · 版本 {check.latest.revision.slice(0, 8)}</p><pre>{check.latest.content}</pre></> : <p>{check.latestUnavailableReason === "reference_too_large" ? "新版来源超过 160,000 字符，请选择更小的片段。" : ambiguous ? "存在多处相同文本，无法唯一确定引用位置。" : "片段已变化，无法确定新版范围。"}请从“添加引用”重新选择。</p>}
      <p>{kept ? "已查看此次差异并保留原依据；这不表示结论已经重新验证。" : "来源变化不自动判定原结论过时。"}</p>
      <button type="button" disabled={checking || kept || !referenceAcknowledgementVersion(check)} onClick={onAcknowledge}>保留当前依据</button>
      {onReevaluate && check.latest && <button type="button" disabled={checking} onClick={() => onReevaluate([check.latest!])}>用新版发起讨论</button>}
    </div>}
  </details>;
}
