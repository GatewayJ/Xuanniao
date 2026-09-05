import type { Message, Thread } from "../types";
import { useDiscussionWorkspace } from "./DiscussionWorkspaceContext";
import { nodeOutcomeCounts, stableMessage } from "./discussion-view-state";

export function DiscussionAnswerActions({ thread, message, text, onAction }: {
  thread: Thread; message: Message; text?: string; onAction?: () => void;
}) {
  const workspace = useDiscussionWorkspace();
  if (!workspace || message.role !== "assistant") return null;
  const disabled = !stableMessage(message) || !(text ?? message.content).trim();
  const cited = new Set((workspace.citations || []).filter((item) => item.reference.threadId === thread.id && item.reference.messageId === message.id).map((item) => `${item.documentPath}:${item.targetThreadId}:${item.targetMessageId}`)).size;
  const count = nodeOutcomeCounts(workspace.records, thread.id, [message.id]);
  return <div className="discussionAnswerActions" aria-label={text ? "回答选段操作" : "回答操作"}>
    <button type="button" disabled={disabled} onClick={() => { workspace.adopt?.(thread, message, text); onAction?.(); }}>采纳到文档</button>
    <button type="button" disabled={disabled} onClick={() => { workspace.execute?.(thread, message, text); onAction?.(); }}>据此执行</button>
    <button type="button" disabled={disabled} onClick={() => { workspace.referenceTo?.(thread, message, text); onAction?.(); }}>引用到其他讨论</button>
    {cited > 0 && <button type="button" onClick={() => workspace.openResults(thread.id, message.id)}>被 {cited} 段讨论引用</button>}
    {count.total > 0 && <button type="button" onClick={() => workspace.openResults?.(thread.id, message.id)}>成果 {count.total} · 已应用 {count.applied} · 执行 {count.executions}</button>}
    {!stableMessage(message) && <small>生成完成后可使用回答</small>}
  </div>;
}
