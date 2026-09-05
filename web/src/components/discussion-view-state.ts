import { agentRunForMessage } from "../agent-run";
import { appendReference, discussionSources, snapshotReference } from "../discussion-references";
import { buildConversationTree, conversationBreadcrumb, flattenConversationTree } from "../thread-tree";
import type { DocumentPayload, Message, ReferenceSnapshot, Thread } from "../types";

export type DiscussionView = "discussion" | "focus" | "compare" | "review" | "overview";
export type CanvasViewport = { width: number; height: number };
export type CanvasTransform = { x: number; y: number; scale: number };
export type DiscussionPosition = {
  view: DiscussionView;
  selectedNodeId: string | null;
  inspectorOpen: boolean;
  pinnedNodeId: string | null;
  selection: string[];
  selecting: boolean;
  pair: [string, string];
  documentOpen: boolean;
  transform: { x: number; y: number; scale: number };
  overviewTransform: { x: number; y: number; scale: number } | null;
  paneWidths: { document: number; content: number };
  scroll: Record<string, number>;
  viewport?: CanvasViewport;
};

const memory = new Map<string, unknown>();
export function workspaceStorageKey(documentPath: string | undefined, threadId: string): string {
  return `xuanniao:discussion-view:v1:${documentPath || ""}:${threadId}`;
}
export function readWorkspaceDraft<T>(key: string): T | null {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    if (typeof window === "undefined") return null;
    const text = window.sessionStorage.getItem(key);
    return text ? JSON.parse(text) as T : null;
  } catch { return null; }
}
export function saveWorkspaceDraft(key: string, value: unknown): void {
  memory.set(key, value);
  try { if (typeof window !== "undefined") window.sessionStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Keep the in-memory draft when browser storage is unavailable or full. */ }
}

// Resizing changes the viewport, not the world point the reader was looking at.
export function reframeCanvas(transform: CanvasTransform, previous: CanvasViewport | null, next: CanvasViewport, center?: { x: number; y: number }): CanvasTransform {
  if (!(next.width > 0 && next.height > 0)) return transform;
  if (center) return { ...transform, x: next.width / 2 - center.x * transform.scale, y: next.height / 2 - center.y * transform.scale };
  if (!previous || !(previous.width > 0 && previous.height > 0)) return transform;
  if (previous.width === next.width && previous.height === next.height) return transform;
  return { ...transform, x: transform.x + (next.width - previous.width) / 2, y: transform.y + (next.height - previous.height) / 2 };
}

export function restoredDiscussionNode(documentPath: string | undefined, thread: Thread): string | null {
  const saved = readWorkspaceDraft<DiscussionPosition>(workspaceStorageKey(documentPath, thread.id));
  const tree = buildConversationTree(thread.messages);
  if (saved?.selectedNodeId && flattenConversationTree(tree).some((node) => node.id === saved.selectedNodeId)) return saved.selectedNodeId;
  return tree[0]?.id || null;
}
export function stableMessage(message: Message): boolean {
  const run = agentRunForMessage(message);
  return !message.id.startsWith("pending-") && run?.status !== "waiting" && run?.status !== "running" && run?.status !== "stopping" && run?.status !== "unknown";
}
export function comparisonPair(selection: string[], pair: readonly string[]): [string, string] {
  const left = selection.includes(pair[0]) ? pair[0] : selection[0] || "";
  const right = selection.includes(pair[1]) && pair[1] !== left ? pair[1] : selection.find((id) => id !== left) || "";
  return [left, right];
}
export function chooseComparisonSide(selection: string[], pair: [string, string], side: 0 | 1, id: string): [string, string] {
  if (!selection.includes(id)) return pair;
  if (id === pair[1 - side]) return [pair[1], pair[0]];
  const next: [string, string] = [...pair];
  next[side] = id;
  return comparisonPair(selection, next);
}
export function synthesisSources(thread: Thread, selection: string[]) {
  const tree = buildConversationTree(thread.messages);
  const nodes = flattenConversationTree(tree);
  const selected = [...new Set(selection)].map((id) => nodes.find((node) => node.id === id)).filter((node) => node !== undefined);
  const paths = selected.map((node) => conversationBreadcrumb(tree, node.id));
  const rootIds = [...new Set(paths.map((path) => path[0]?.question.id).filter((id) => id !== undefined))];
  const messageIds = [...new Set([...rootIds, ...selected.flatMap((node) => node.messages.filter(stableMessage).map((message) => message.id))])];
  return {
    selected, paths, rootIds, messageIds,
    generating: selected.some((node) => node.messages.some((message) => !stableMessage(message))),
    incomplete: selected.filter((node) => !node.messages.some((message) => message.role === "assistant" && stableMessage(message) && message.content.trim() && !message.error))
  };
}
export async function synthesisReferences(document: DocumentPayload, thread: Thread, selection: string[]): Promise<ReferenceSnapshot[]> {
  const plan = synthesisSources(thread, selection);
  if (plan.selected.length < 2) throw new Error("至少选择两个节点才能比较或综合。");
  if (plan.generating) throw new Error("所选节点仍在生成，请等待回答完成后再准备资料。");
  const sources = discussionSources(document, [thread]);
  const references = await Promise.all(plan.messageIds.map(async (id) => {
    const source = sources.find((item) => item.messageId === id);
    if (!source) return null;
    const reference = await snapshotReference(source);
    return plan.rootIds.includes(id) ? { ...reference, title: `原始目标 · ${reference.title}` } : reference;
  }));
  return references.reduce<ReferenceSnapshot[]>((items, reference) => reference ? appendReference(items, reference) : items, []);
}

export function workspaceEscapeTarget(selectionOpen: boolean, selecting: boolean, view: DiscussionView): "selection" | "multiselect" | "view" | "modal" {
  if (selectionOpen) return "selection";
  if (selecting) return "multiselect";
  return view === "discussion" ? "modal" : "view";
}

type OutcomeSourceRecord = { id: string; kind: string; status: string; inverseOf?: string; source: { threadId?: string; messageId?: string } };
export function nodeOutcomeCounts(records: readonly OutcomeSourceRecord[], threadId: string, messageIds: string[]) {
  const matching = [...new Map(records.filter((record) => record.source.threadId === threadId && Boolean(record.source.messageId && messageIds.includes(record.source.messageId))).map((record) => [record.id, record])).values()];
  return {
    total: matching.length,
    applied: matching.filter((record) => record.kind === "proposal" && record.status === "applied" && !record.inverseOf).length,
    executions: matching.filter((record) => record.kind === "execution").length
  };
}
