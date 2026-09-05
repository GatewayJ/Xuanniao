import { useLayoutEffect, useRef, useState } from "react";
import { renderMessageMarkdown } from "../markdown";
import { buildConversationTree, conversationBreadcrumb, type ConversationNode } from "../thread-tree";
import type { Thread } from "../types";
import { DiscussionAnswerActions } from "./DiscussionAnswerActions";
import { useDiscussionWorkspace } from "./DiscussionWorkspaceContext";
import { chooseComparisonSide, comparisonPair, stableMessage, type DiscussionView } from "./discussion-view-state";

export const DISCUSSION_VIEWS: { value: DiscussionView; label: string }[] = [
  { value: "discussion", label: "讨论" }, { value: "focus", label: "专注" },
  { value: "compare", label: "比较" }, { value: "review", label: "审核" }, { value: "overview", label: "总览" }
];
export function DiscussionViewSwitcher({ view, onChange, canCompare }: {
  view: DiscussionView; onChange: (view: DiscussionView) => void; canCompare: boolean;
}) {
  return <nav className="discussionViewSwitcher" aria-label="讨论视图">
    {DISCUSSION_VIEWS.map((item) => <button type="button" key={item.value} aria-pressed={view === item.value}
      disabled={item.value === "compare" && !canCompare} title={item.value === "compare" && !canCompare ? "至少选择两个节点" : undefined}
      onClick={() => onChange(item.value)}>{item.label}</button>)}
  </nav>;
}
export function DiscussionContentTabs({ value, onChange }: { value: "work" | "reference"; onChange: (value: "work" | "reference") => void }) {
  return <div className="discussionContentTabs" role="tablist" aria-label="工作与参考内容" onKeyDown={(event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? "work" : event.key === "End" ? "reference" : value === "work" ? "reference" : "work";
    onChange(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-content-tab='${next}']`)?.focus();
  }}>
    <button type="button" role="tab" data-content-tab="work" aria-selected={value === "work"} tabIndex={value === "work" ? 0 : -1} onClick={() => onChange("work")}>工作内容</button>
    <button type="button" role="tab" data-content-tab="reference" aria-selected={value === "reference"} tabIndex={value === "reference" ? 0 : -1} onClick={() => onChange("reference")}>参考内容</button>
  </div>;
}

export function DiscussionNodeReader(props: {
  thread: Thread; node: ConversationNode; label: string; scrollKey: string; visibilityKey?: string;
  scroll: Record<string, number>; onSaveScroll: () => void;
  onOpen: (id: string) => void; onQuote?: (messageId: string, text?: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ messageId: string; text: string } | null>(null);
  const path = conversationBreadcrumb(buildConversationTree(props.thread.messages), props.node.id);
  useLayoutEffect(() => {
    if (scroller.current?.clientHeight) scroller.current.scrollTop = props.scroll[props.scrollKey] || 0;
    setSelection(null);
  }, [props.scrollKey, props.visibilityKey]);
  function captureSelection() {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) { setSelection(null); return; }
    const range = selected.getRangeAt(0);
    const start = range.startContainer.parentElement?.closest<HTMLElement>("[data-reader-message]");
    const end = range.endContainer.parentElement?.closest<HTMLElement>("[data-reader-message]");
    if (!start || start !== end || !scroller.current?.contains(start) || !selected.toString().trim()) { setSelection(null); return; }
    setSelection({ messageId: start.dataset.readerMessage!, text: selected.toString() });
  }
  const selectedMessage = props.node.messages.find((message) => message.id === selection?.messageId);
  return <section className="discussionNodeReader" aria-label={props.label} onKeyDown={(event) => {
    if (event.key === "Escape" && selection) { event.preventDefault(); event.stopPropagation(); setSelection(null); window.getSelection()?.removeAllRanges(); }
  }}>
    <div className="discussionReaderPath">{path.map((node) => node.question.content.replace(/\s+/g, " ").slice(0, 60)).join(" → ")}</div>
    <button type="button" className="discussionLocateNode" onClick={() => props.onOpen(props.node.id)}>定位到工作节点 ↗</button>
    {selection && selectedMessage && <div className="discussionReaderSelection" data-discussion-selection>
      <small>已选回答片段 · {selection.text.length} 字</small>
      <button type="button" aria-label="关闭参考选区操作" onClick={() => setSelection(null)}>×</button>
      {props.onQuote && <button type="button" disabled={!stableMessage(selectedMessage)} onClick={() => { props.onQuote?.(selectedMessage.id, selection.text); setSelection(null); }}>引用片段到输入框</button>}
      <DiscussionAnswerActions thread={props.thread} message={selectedMessage} text={selection.text} onAction={() => setSelection(null)} />
    </div>}
    <div ref={scroller} className="discussionReaderScroll" tabIndex={0} aria-label={`${props.label}，可独立滚动`}
      onMouseUp={captureSelection} onKeyUp={captureSelection}
      onScroll={(event) => { if (!event.currentTarget.clientHeight) return; props.scroll[props.scrollKey] = event.currentTarget.scrollTop; props.onSaveScroll(); setSelection(null); }}>
      {props.node.messages.map((message) => <article key={message.id} className="discussionReaderMessage">
        <header><strong>{message.role === "user" ? "问题" : "回答"}</strong>
          {!stableMessage(message) && <small>生成中 · 暂不可引用</small>}
          {message.error && <small>回答失败 · 资料不完整</small>}
          {props.onQuote && <button type="button" disabled={!stableMessage(message) || !message.content.trim()} onClick={() => props.onQuote?.(message.id)}>引用到输入框</button>}
        </header>
        <div className="messageContent" data-reader-message={message.id} dangerouslySetInnerHTML={{ __html: renderMessageMarkdown(message.content) }} />
        <DiscussionAnswerActions thread={props.thread} message={message} />
      </article>)}
      {!props.node.messages.some((message) => message.role === "assistant") && <p>尚无回答 · 资料不完整</p>}
    </div>
  </section>;
}

export function DiscussionComparison(props: {
  thread: Thread; nodes: ConversationNode[]; selectedIds: string[]; pair: [string, string];
  onPairChange: (pair: [string, string]) => void; scroll: Record<string, number>; onSaveScroll: () => void;
  onOpen: (id: string) => void; onQuote?: (messageId: string, text?: string) => void;
}) {
  const [tab, setTab] = useState<"work" | "reference">("work");
  const selected = props.selectedIds.map((id) => props.nodes.find((node) => node.id === id)).filter((node) => node !== undefined);
  const ids = selected.map((node) => node.id);
  const pair = comparisonPair(ids, props.pair);
  return <div className={`discussionComparison mobile-${tab}`}>
    <header className="discussionComparisonHeader"><strong>共选 {selected.length} 项 · 两栏切换不改变资料清单</strong>
      <button type="button" disabled={selected.length < 2} onClick={() => props.onPairChange([pair[1], pair[0]])}>交换左右</button>
    </header>
    <ol className="discussionComparisonList" aria-label="完整比较选择列表">
      {selected.map((node) => <li key={node.id}>{node.question.content.replace(/\s+/g, " ").slice(0, 90)}{node.messages.some((message) => !stableMessage(message)) && " · 生成中"}</li>)}
    </ol>
    <DiscussionContentTabs value={tab} onChange={setTab} />
    <div className="discussionComparisonColumns">
      {([0, 1] as const).map((side) => {
        const node = selected.find((item) => item.id === pair[side]);
        return <div key={side} className={`discussionComparisonColumn ${side === 0 ? "workingColumn" : "referenceColumn"}`}>
          <label>{side === 0 ? "工作内容" : "参考内容"}
            <select aria-label={side === 0 ? "左栏节点" : "右栏节点"} value={pair[side]} onChange={(event) => props.onPairChange(chooseComparisonSide(ids, pair, side, event.target.value))}>
              {selected.map((item) => <option key={item.id} value={item.id}>{item.question.content.slice(0, 90)}</option>)}
            </select>
          </label>
          {node && <DiscussionNodeReader {...props} node={node} label={side === 0 ? "左栏问答" : "右栏问答"} scrollKey={`compare:${node.id}`} visibilityKey={tab} />}
        </div>;
      })}
    </div>
  </div>;
}

export function DiscussionReviewView({ thread, onBack }: { thread: Thread; onBack: () => void }) {
  const workspace = useDiscussionWorkspace();
  const records = workspace?.records.filter((record) => record.source.threadId === thread.id && record.kind === "proposal") || [];
  return <div className="discussionReviewView">
    <header><h3>文档修改审核</h3><button type="button" onClick={onBack}>返回此前视图</button></header>
    <p>从实际提案打开 Diff，核对来源结论和文档范围后处理。</p>
    {records.length ? records.map((record) => <button type="button" key={record.id} onClick={() => workspace?.openResults?.(thread.id, record.source.messageId)}>
      <strong>{thread.messages.find((message) => message.id === record.source.messageId)?.content.slice(0, 100) || "来源回答已删除"}</strong>
      <span>{record.status === "applied" ? "已应用" : record.status === "review" ? "待审核" : record.status} · 查看提案 Diff ↗</span>
    </button>) : <p>暂无修改提案。可在回答上点击“采纳到文档”准备提案。</p>}
    {workspace && <button type="button" onClick={() => workspace.openResults?.(thread.id)}>查看本讨论全部成果</button>}
  </div>;
}
