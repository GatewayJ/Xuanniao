import { agentRunForMessage } from "./agent-run";
import type { ConversationNodeKind, Message } from "./types";

export type ConversationNode = {
  id: string;
  parentId: string | null;
  question: Message;
  messages: Message[];
  children: ConversationNode[];
};

export type ConversationNavigation = {
  left: ConversationNode | null;
  right: ConversationNode | null;
  up: ConversationNode | null;
  down: ConversationNode | null;
};

export type ConversationNodeStatus = "unanswered" | "thinking" | "answered" | "failed" | "interrupted" | "unknown" | "stopping";

export const CONVERSATION_NODE_KINDS: ConversationNodeKind[] = [
  "question",
  "idea",
  "assumption",
  "evidence",
  "risk",
  "decision",
  "task"
];

export function buildConversationTree(messages: Message[]): ConversationNode[] {
  const normalized = inferMessageParents(messages);
  const nodes = new Map<string, ConversationNode>();

  for (const message of normalized) {
    if (message.role !== "user") continue;
    const nodeId = message.nodeId || message.id;
    if (nodes.has(nodeId)) continue;
    nodes.set(nodeId, {
      id: nodeId,
      parentId: message.parentId || null,
      question: message,
      messages: [],
      children: []
    });
  }

  for (const message of normalized) {
    const nodeId = message.nodeId || (message.role === "user" ? message.id : message.parentId);
    if (!nodeId) continue;
    const node = nodes.get(nodeId);
    if (node) node.messages.push(message);
  }

  const roots: ConversationNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent && parent !== node && !parentChainContains(nodes, parent, node.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function flattenConversationTree(roots: ConversationNode[]): ConversationNode[] {
  const flattened: ConversationNode[] = [];
  const visit = (node: ConversationNode) => {
    flattened.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return flattened;
}

export function conversationNodeCanBranch(node: ConversationNode): boolean {
  return node.children.length > 0;
}

export function conversationNavigation(roots: ConversationNode[], nodeId: string): ConversationNavigation {
  const nodes = flattenConversationTree(roots);
  const current = nodes.find((node) => node.id === nodeId) || null;
  if (!current) return { left: null, right: null, up: null, down: null };

  const parent = current.parentId ? nodes.find((node) => node.id === current.parentId) || null : null;
  const siblings = parent ? parent.children : roots;
  const index = siblings.findIndex((node) => node.id === current.id);
  return {
    left: index > 0 ? siblings[index - 1] : null,
    right: index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null,
    up: parent,
    down: current.children[0] || null
  };
}

export function conversationBreadcrumb(roots: ConversationNode[], nodeId: string): ConversationNode[] {
  const nodes = flattenConversationTree(roots);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: ConversationNode[] = [];
  const visited = new Set<string>();
  let current = byId.get(nodeId);
  while (current && !visited.has(current.id)) {
    path.push(current);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function conversationNodeStatus(node: ConversationNode): ConversationNodeStatus {
  const latestAssistant = node.messages.filter((message) => message.role === "assistant").at(-1);
  if (!latestAssistant) return "unanswered";
  const run = agentRunForMessage(latestAssistant);
  if (run?.status === "unknown" || latestAssistant.meta?.outcomeUnknown) return "unknown";
  if (run?.status === "interrupted" || latestAssistant.meta?.interrupted) return "interrupted";
  if (run?.status === "stopping") return "stopping";
  if (latestAssistant.id.startsWith("pending-") || run?.status === "running" || run?.status === "waiting") return "thinking";
  if (latestAssistant.error) return "failed";
  return "answered";
}

export function conversationNodeKind(node: ConversationNode | Message | null | undefined): ConversationNodeKind {
  const message = "question" in (node || {}) ? (node as ConversationNode).question : node as Message | null | undefined;
  const value = message?.meta?.nodeKind;
  return typeof value === "string" && isConversationNodeKind(value) ? value : "question";
}

export function inferMessageParents(messages: Message[]): Message[] {
  let previousQuestionId: string | null = null;
  let previousNodeId: string | null = null;
  return messages.map((message) => {
    const parentId = message.parentId === undefined ? previousQuestionId : message.parentId;
    const nodeId = message.nodeId || (message.role === "user" ? message.id : parentId || previousNodeId);
    const normalized = { ...message, nodeId: nodeId || null, parentId: parentId || null };
    if (message.role === "user") {
      previousQuestionId = message.id;
      previousNodeId = nodeId || null;
    }
    return normalized;
  });
}

function parentChainContains(nodes: Map<string, ConversationNode>, start: ConversationNode, targetId: string): boolean {
  const visited = new Set<string>();
  let current: ConversationNode | undefined = start;
  while (current && !visited.has(current.id)) {
    if (current.id === targetId) return true;
    visited.add(current.id);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return false;
}

function isConversationNodeKind(value: string): value is ConversationNodeKind {
  return (CONVERSATION_NODE_KINDS as string[]).includes(value);
}
