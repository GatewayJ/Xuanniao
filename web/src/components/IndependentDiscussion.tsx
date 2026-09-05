import { useEffect, useRef, useState } from "react";
import { appendReference, discussionSources, snapshotReference } from "../discussion-references";
import type { DocumentPayload, ReferenceSnapshot, Thread } from "../types";
import { ReferenceComposer } from "./ReferenceComposer";
import { readWorkspaceDraft, saveWorkspaceDraft, stableMessage, synthesisReferences, synthesisSources, workspaceStorageKey } from "./discussion-view-state";

export type IndependentDiscussionRequest = {
  content: string;
  scope: "full" | "references";
  references: ReferenceSnapshot[];
};
export type DiscussionPreparation = { mode: "compare" | "synthesize"; nodeIds: string[] };

export function IndependentDiscussion(props: {
  open: boolean;
  document: DocumentPayload;
  threads: Thread[];
  source: Thread;
  messageIds: string[];
  initialContent?: string;
  preparation?: DiscussionPreparation;
  onClose: () => void;
  onStart: (request: IndependentDiscussionRequest) => Promise<void>;
}) {
  const identity = `${workspaceStorageKey(props.document.path, props.source.id)}:prepare:${props.preparation?.mode || "independent"}:${[...(props.preparation?.nodeIds || props.messageIds)].sort().join(",")}`;
  // The keyed inner form keeps separate, resumable drafts for each exact source list and purpose.
  return <IndependentDiscussionForm key={identity} {...props} identity={identity} />;
}

function IndependentDiscussionForm(props: Parameters<typeof IndependentDiscussion>[0] & { identity: string }) {
  const [saved] = useState(() => readWorkspaceDraft<IndependentDiscussionRequest>(props.identity));
  const defaultContent = props.preparation?.mode === "compare"
    ? "请比较所选方案的差异、适用条件、取舍与证据缺口。核对原始目标和明确引用的约束，保留分歧并列出需要验证的事项。"
    : props.preparation ? "请综合所选节点，给出推荐结论及理由、关键取舍、未验证的条件和后续验证项。遵守原始目标与明确引用的约束，并保留来源与分歧。" : "";
  const [content, setContent] = useState(saved?.content ?? props.initialContent ?? defaultContent);
  const [scope, setScope] = useState<"full" | "references">(saved?.scope || "references");
  const [references, setReferences] = useState<ReferenceSnapshot[]>(saved?.references || []);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(!saved);
  const [ancestorId, setAncestorId] = useState("");
  const [range, setRange] = useState({ start: 0, end: 0 });
  const initialized = useRef(Boolean(saved));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const plan = props.preparation ? synthesisSources(props.source, props.preparation.nodeIds) : null;
  const invalidSelection = Boolean(plan && (plan.selected.length < 2 || plan.generating));
  const sources = discussionSources(props.document, [props.source]);
  const ancestors = [...new Map((plan?.paths || []).flatMap((path) => path.slice(0, -1)).map((node) => [node.id, node])).values()];
  const ancestorSources = sources.filter((source) => ancestors.some((node) => node.messages.some((message) => message.id === source.messageId && stableMessage(message))));
  const ancestor = ancestorSources.find((source) => source.key === ancestorId);
  const budgetExceeded = references.length > 24 || references.reduce((sum, item) => sum + item.content.length, 0) > 160_000;

  useEffect(() => {
    if (!props.open) return;
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [props.open]);

  useEffect(() => {
    if (!props.open || initialized.current) return;
    let cancelled = false;
    setLoading(true);
    const initial = props.preparation
      ? synthesisReferences(props.document, props.source, props.preparation.nodeIds)
      : Promise.all(sources.filter((source) => source.messageId && props.messageIds.includes(source.messageId)
        && props.source.messages.some((message) => message.id === source.messageId && stableMessage(message))).map((source) => snapshotReference(source)));
    initial.then((snapshots) => {
      if (cancelled) return;
      setReferences(snapshots);
      initialized.current = true;
    }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "无法读取来源，请重新打开准备面板。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open]);

  useEffect(() => {
    if (initialized.current) saveWorkspaceDraft(props.identity, { content, scope, references });
  }, [props.identity, content, scope, references]);

  if (!props.open) return null;
  return <div className="independentBackdrop" data-discussion-overlay onMouseDown={(event) => { event.stopPropagation(); if (!starting) props.onClose(); }}>
    <form className="independentPanel" role="dialog" aria-modal="true" aria-labelledby="independent-title"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          if (ancestorId) setAncestorId("");
          else if (!starting) props.onClose();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); if (!starting && !loading) event.currentTarget.requestSubmit(); }
        if (event.key === "Tab") {
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary")].filter((element) => element.offsetParent !== null);
          if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
          if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (starting || loading || invalidSelection || budgetExceeded || !initialized.current || !content.trim()) return;
        setStarting(true);
        setError("");
        try {
          await props.onStart({ content: content.trim(), scope, references });
          saveWorkspaceDraft(props.identity, null);
          props.onClose();
        } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setStarting(false); }
      }}>
      <header><div><span className="workbenchEyebrow">独立上下文</span><h2 id="independent-title">{props.preparation ? "综合准备" : "开启独立讨论"}</h2></div><button type="button" aria-label="关闭独立讨论" disabled={starting} onClick={props.onClose}>×</button></header>
      <p className="workbenchDescription">{props.preparation ? "默认带入所选节点问答和去重后的原始根问题。核对下方最终资料清单，点击开始后才创建独立讨论。" : "新讨论有自己的问答树和会话。下方列出将带入的资料，你可以移除或补充。"}</p>
      <div className="independentOrigin">来源讨论 · {props.source.title}</div>
      {plan && <div className="synthesisPaths">
        <strong>祖先路径 · 仅供核对</strong>
        {plan.paths.map((path) => <p key={path.at(-1)?.id}>{path.map((node) => node.question.content.replace(/\s+/g, " ").slice(0, 60)).join(" → ")}</p>)}
        <p>未选祖先的问答不会自动带入。原始目标已单列为可移除的引用。</p>
        {plan.incomplete.length > 0 && <p role="status">{plan.incomplete.length} 个节点资料不完整（空回答或失败），仅引用已有文字。</p>}
        <label>补充此前要求
          <select aria-label="补充此前要求" value={ancestorId} disabled={starting || loading} onChange={(event) => { setAncestorId(event.target.value); setRange({ start: 0, end: 0 }); }}>
            <option value="">选择祖先的问题或回答…</option>
            {ancestorSources.map((source) => <option key={source.key} value={source.key}>{source.title}</option>)}
          </select>
        </label>
        {ancestor && <div className="referencePreview">
          <textarea aria-label="祖先原文，可选择约束片段" readOnly value={ancestor.content} onSelect={(event) => setRange({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} />
          <button type="button" disabled={starting || loading || range.end <= range.start} onClick={async () => {
            setLoading(true);
            try { const reference = await snapshotReference(ancestor, range.start, range.end); setReferences((current) => appendReference(current, reference)); setAncestorId(""); }
            catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
            finally { setLoading(false); }
          }}>明确引用所选约束</button>
        </div>}
      </div>}
      <label className="workbenchField">文档背景
        <select value={scope} disabled={starting} onChange={(event) => setScope(event.target.value as "full" | "references")}>
          <option value="references">仅带入所选资料</option><option value="full">同时附带完整文档背景</option>
        </select>
      </label>
      <ReferenceComposer document={props.document} threads={props.threads} references={references} onChange={setReferences} scope={scope} selectedText={props.source.selectedText} disabled={starting || loading} />
      {loading && <p role="status">正在读取来源…</p>}
      {invalidSelection && <p className="workbenchError" role="alert">至少需要两个有效节点，且所选回答均已停止生成。</p>}
      {budgetExceeded && <p className="workbenchError" role="alert">资料超过 24 项或 160,000 字符。请缩小引用范围；不会自动截断原始目标。</p>}
      <label className="workbenchField" htmlFor="independent-question">{props.preparation ? "本次综合要求" : "这次要解决什么问题？"}</label>
      <textarea ref={inputRef} id="independent-question" className="independentQuestion" value={content} disabled={starting} onChange={(event) => setContent(event.target.value)} placeholder="写下明确目标，以及仍需遵守的约束…" />
      <p className="workbenchDescription">不会继承来源讨论的完整历史和工具状态。需要保留的约束，请从“添加引用”中选入。关闭会保留准备草稿。</p>
      {error && <p className="workbenchError" role="alert">{error}</p>}
      <footer className="workbenchActions"><button type="button" disabled={starting} onClick={props.onClose}>返回讨论</button><button type="submit" className="primaryButton" disabled={starting || loading || invalidSelection || budgetExceeded || !initialized.current || !content.trim()}>{starting ? "正在创建…" : props.preparation ? "开始综合讨论" : "开始独立讨论"}</button></footer>
    </form>
  </div>;
}
