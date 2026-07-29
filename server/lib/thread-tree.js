import { createHash } from "node:crypto";

export function branchThreadForQuestion(thread, questionMessageId) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const question = messages.find((message) => message.id === questionMessageId && message.role === "user");
  if (!question) {
    throw new Error(`question message not found: ${questionMessageId}`);
  }

  const currentNodeId = question.nodeId || question.id;
  const nodeRoots = new Map();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const nodeId = message.nodeId || message.id;
    if (message.id === nodeId || !nodeRoots.has(nodeId)) nodeRoots.set(nodeId, message);
  }
  const currentRoot = nodeRoots.get(currentNodeId) || question;

  const lineage = [];
  const visited = new Set();
  let current = currentRoot;
  while (current && !visited.has(current.nodeId || current.id)) {
    const nodeId = current.nodeId || current.id;
    lineage.push(nodeId);
    visited.add(nodeId);
    current = current.parentId ? nodeRoots.get(current.parentId) : null;
  }
  lineage.reverse();

  const ancestorMessages = [];
  const currentNodeMessages = [];
  const currentQuestionIndex = messages.findIndex((message) => message.id === questionMessageId);
  for (const nodeId of lineage) {
    const nodeMessages = messages.filter((message, index) => message.nodeId === nodeId && (nodeId !== currentNodeId || index < currentQuestionIndex));
    if (nodeId === currentNodeId) {
      currentNodeMessages.push(...nodeMessages);
    } else {
      ancestorMessages.push(...nodeMessages);
    }
  }
  const parentRoot = currentRoot.parentId ? nodeRoots.get(currentRoot.parentId) : null;
  const agentSession = currentRoot.agentSession || null;
  const lastSyncedMessageIndex = findLastSyncedMessageIndex(currentNodeMessages, agentSession);

  return {
    ...thread,
    sessionKey: `${thread.id}:${currentNodeId}`,
    agentSession,
    parentAgentSession: parentRoot?.agentSession || null,
    branchSelection: normalizeBranchSelection(question.meta?.branchSelection),
    ancestorMessages,
    currentNodeMessages,
    unsyncedCurrentNodeMessages: agentSession ? currentNodeMessages.slice(lastSyncedMessageIndex + 1) : currentNodeMessages,
    messages: [...ancestorMessages, ...currentNodeMessages],
    revision: branchRevision([...ancestorMessages, ...currentNodeMessages, question])
  };
}

export function branchRevisionForQuestion(thread, questionMessageId) {
  return branchThreadForQuestion(thread, questionMessageId).revision;
}

export function parentQuestion(thread, parentMessageId) {
  if (parentMessageId === null || parentMessageId === undefined || parentMessageId === "") return null;
  const parent = conversationNode(thread, parentMessageId);
  if (!parent) {
    throw new Error(`parent question not found: ${parentMessageId}`);
  }
  return parent;
}

export function conversationNode(thread, nodeId) {
  return thread.messages.find((message) => message.role === "user" && message.id === nodeId && (message.nodeId || message.id) === nodeId) || null;
}

export function selectionComesFromNode(thread, selection, nodeId) {
  if (!selection?.sourceMessageId || !nodeId) return false;
  const sourceMessage = thread.messages.find((message) => message.id === selection.sourceMessageId);
  return Boolean(sourceMessage && (sourceMessage.nodeId || sourceMessage.id) === nodeId);
}

function normalizeBranchSelection(value) {
  if (!value || typeof value !== "object") return null;
  const sourceMessageId = typeof value.sourceMessageId === "string" ? value.sourceMessageId : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  return sourceMessageId && text ? { sourceMessageId, text } : null;
}

function findLastSyncedMessageIndex(messages, session) {
  if (!session?.adapter) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && !message.error && message.meta?.transport === session.adapter) {
      return index;
    }
  }
  return -1;
}

function branchRevision(messages) {
  const state = messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    nodeId: message.nodeId || null,
    parentId: message.parentId || null,
    error: Boolean(message.error),
    branchSelection: message.meta?.branchSelection || null
  }));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
