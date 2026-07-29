import { branchRevisionForQuestion, conversationNode, parentQuestion, selectionComesFromNode } from "./thread-tree.js";

export function planConversationQuestion(thread, command) {
  const content = String(command.content || "").trim();
  if (!content) throw new ConversationRuleError("message content is required");

  const requestedNodeId = optionalId(command.nodeId);
  const existingNode = requestedNodeId ? conversationNode(thread, requestedNodeId) : null;
  if (requestedNodeId && !existingNode) {
    throw new ConversationRuleError(`conversation node not found: ${requestedNodeId}`);
  }

  const parentMessageId = existingNode ? existingNode.parentId || null : optionalId(command.parentMessageId);
  if (!existingNode) {
    try {
      parentQuestion(thread, parentMessageId);
    } catch (error) {
      throw new ConversationRuleError(error instanceof Error ? error.message : String(error));
    }
  }

  const placement = normalizePlacement(command);
  if (placement.kind !== "append" && (existingNode || !parentMessageId)) {
    throw new ConversationRuleError("continuing a branch must create a new node after an existing node");
  }
  if (placement.kind === "insert") {
    const insertBeforeNode = conversationNode(thread, placement.insertBeforeNodeId);
    if (!insertBeforeNode || insertBeforeNode.parentId !== parentMessageId) {
      throw new ConversationRuleError("insert target must be a direct child of the parent node");
    }
  }

  const branchSelection = normalizeBranchSelection(command.branchSelection);
  if (branchSelection) {
    const sourceNodeId = existingNode ? requestedNodeId : parentMessageId;
    if (!sourceNodeId) {
      throw new ConversationRuleError("selected message text requires a conversation node");
    }
    if (!selectionComesFromNode(thread, branchSelection, sourceNodeId)) {
      throw new ConversationRuleError("selected message text must come from the target node");
    }
  }

  return {
    askAgent: command.askAgent !== false,
    placement,
    message: {
      role: "user",
      content,
      nodeId: requestedNodeId,
      parentId: parentMessageId,
      meta: branchSelection ? { branchSelection } : {}
    }
  };
}

export function appendConversationMessage(thread, message, { id, now }) {
  const saved = createConversationMessage(message, { id, now });
  thread.messages.push(saved);
  if (saved.role === "user" && saved.nodeId !== saved.id) {
    invalidateDescendantSessions(thread.messages, saved.nodeId);
  }
  thread.updatedAt = now;
  return saved;
}

export function insertConversationNode(thread, parentNodeId, message, insertBeforeNodeId, { id, now }) {
  const parent = thread.messages.find(
    (item) => item.role === "user" && item.id === parentNodeId && (item.nodeId || item.id) === parentNodeId
  );
  if (!parent) throw new Error(`parent question not found: ${parentNodeId}`);

  const saved = createConversationMessage({ ...message, nodeId: null, parentId: parentNodeId }, { id, now });
  const reparentedNodeIds = new Set();
  for (const existing of thread.messages) {
    if (
      existing.role === "user" &&
      existing.id === (existing.nodeId || existing.id) &&
      existing.parentId === parentNodeId &&
      (!insertBeforeNodeId || existing.nodeId === insertBeforeNodeId)
    ) {
      existing.parentId = saved.nodeId;
      reparentedNodeIds.add(existing.nodeId || existing.id);
    }
  }
  invalidateNodeSessions(thread.messages, descendantNodeIdsForRoots(thread.messages, reparentedNodeIds));
  thread.messages.push(saved);
  thread.updatedAt = now;
  return saved;
}

export function completeConversationAgentTurn(
  thread,
  userMessageId,
  message,
  agentSession,
  expectedBranchRevision,
  { id, now }
) {
  const questionIndex = thread.messages.findIndex((item) => item.id === userMessageId && item.role === "user");
  if (questionIndex < 0) throw new Error(`question message not found: ${userMessageId}`);
  if (findAssistantReplyIndex(thread.messages, questionIndex) >= 0) {
    throw new Error(`assistant reply already exists for question: ${userMessageId}`);
  }
  if (expectedBranchRevision && branchRevisionForQuestion(thread, userMessageId) !== expectedBranchRevision) {
    throw new Error("conversation branch changed while the agent was working; retry the question");
  }

  const question = thread.messages[questionIndex];
  const nodeId = question.nodeId || question.id;
  const nodeRoot = thread.messages.find((item) => item.role === "user" && item.id === nodeId);
  if (!nodeRoot) throw new Error(`conversation node not found: ${nodeId}`);

  const saved = createConversationMessage(
    { ...message, nodeId, parentId: userMessageId },
    { id, now }
  );
  thread.messages.splice(questionIndex + 1, 0, saved);
  nodeRoot.agentSession = normalizeAgentSession(agentSession);
  thread.updatedAt = now;
  return saved;
}

export function updateConversationMessage(thread, messageId, patch, now) {
  const message = requireMessage(thread, messageId);
  if (message.role !== "user") throw new Error("only local user comments can be edited");
  message.content = patch.content;
  message.updatedAt = now;
  invalidateNodeAndDescendants(thread.messages, message.nodeId || message.id);
  thread.updatedAt = now;
  return message;
}

export function updateConversationMessageMeta(thread, messageId, metaPatch, now) {
  const message = requireMessage(thread, messageId);
  if (message.role !== "user") throw new Error("only user questions can store planning metadata");
  message.meta = { ...(message.meta || {}), ...metaPatch };
  message.updatedAt = now;
  thread.updatedAt = now;
  return message;
}

export function deleteConversationMessage(thread, messageId, now) {
  const message = requireMessage(thread, messageId);
  let removed;
  if (message.role === "user" && message.nodeId === message.id) {
    const nodeIds = descendantNodeIds(thread.messages, message.nodeId);
    removed = thread.messages.filter((item) => item.nodeId && nodeIds.has(item.nodeId));
    const removedIds = new Set(removed.map((item) => item.id));
    thread.messages = thread.messages.filter((item) => !removedIds.has(item.id));
  } else if (message.role === "user") {
    const invalidatedNodeId = message.nodeId || message.id;
    const messageIndex = thread.messages.findIndex((item) => item.id === message.id);
    const assistantIndex = findAssistantReplyIndex(thread.messages, messageIndex);
    const removedIds = new Set([message.id]);
    if (assistantIndex >= 0) removedIds.add(thread.messages[assistantIndex].id);
    removed = thread.messages.filter((item) => removedIds.has(item.id));
    thread.messages = thread.messages.filter((item) => !removedIds.has(item.id));
    invalidateNodeAndDescendants(thread.messages, invalidatedNodeId);
  } else {
    removed = [message];
    thread.messages = thread.messages.filter((item) => item.id !== message.id);
    invalidateNodeAndDescendants(thread.messages, message.nodeId || null);
  }
  thread.updatedAt = now;
  return removed;
}

export function removeAssistantReply(thread, userMessageId, now) {
  const index = thread.messages.findIndex((item) => item.id === userMessageId);
  if (index < 0) throw new Error(`message not found: ${userMessageId}`);
  const assistantIndex = findAssistantReplyIndex(thread.messages, index);
  if (assistantIndex < 0) return null;
  const [removed] = thread.messages.splice(assistantIndex, 1);
  invalidateNodeAndDescendants(thread.messages, removed.nodeId || null);
  thread.updatedAt = now;
  return removed;
}

export function hasAssistantReply(thread, userMessageId) {
  const index = thread.messages.findIndex((item) => item.id === userMessageId);
  if (index < 0) throw new Error(`message not found: ${userMessageId}`);
  return findAssistantReplyIndex(thread.messages, index) >= 0;
}

export function normalizeAgentSession(value, legacyAcpSessionId = null) {
  if (value && typeof value === "object") {
    const adapter = typeof value.adapter === "string" ? value.adapter.trim() : "";
    const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    if (adapter && sessionId) {
      return {
        adapter,
        sessionId,
        turnId: typeof value.turnId === "string" && value.turnId ? value.turnId : null,
        documentHash: typeof value.documentHash === "string" && value.documentHash ? value.documentHash : null
      };
    }
  }
  if (typeof legacyAcpSessionId === "string" && legacyAcpSessionId) {
    return {
      adapter: "acp",
      sessionId: legacyAcpSessionId,
      turnId: null,
      documentHash: null
    };
  }
  return null;
}

export class ConversationRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationRuleError";
    this.code = "CONVERSATION_RULE";
    this.statusCode = 400;
  }
}

function normalizePlacement(command) {
  const insertBeforeNodeId = optionalId(command.insertBeforeNodeId);
  if (insertBeforeNodeId) return { kind: "insert", insertBeforeNodeId };
  if (command.adoptExistingChildren === true) return { kind: "adopt-children", insertBeforeNodeId: null };
  return { kind: "append", insertBeforeNodeId: null };
}

function normalizeBranchSelection(value) {
  if (!value || typeof value !== "object") return null;
  const sourceMessageId = optionalId(value.sourceMessageId);
  const text = typeof value.text === "string" ? value.text.replace(/\s+/g, " ").trim().slice(0, 2000) : "";
  return sourceMessageId && text ? { sourceMessageId, text } : null;
}

function optionalId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createConversationMessage(message, { id, now }) {
  return {
    id,
    role: message.role,
    content: message.content,
    nodeId: typeof message.nodeId === "string" && message.nodeId ? message.nodeId : message.role === "user" ? id : null,
    parentId: typeof message.parentId === "string" && message.parentId ? message.parentId : null,
    agentSession: normalizeAgentSession(message.agentSession, message.acpSessionId),
    error: Boolean(message.error),
    meta: message.meta || {},
    createdAt: now
  };
}

function requireMessage(thread, messageId) {
  const message = thread.messages.find((item) => item.id === messageId);
  if (!message) throw new Error(`message not found: ${messageId}`);
  return message;
}

function findAssistantReplyIndex(messages, userMessageIndex) {
  const userMessageId = messages[userMessageIndex]?.id;
  const linkedIndex = messages.findIndex(
    (message) => message.role === "assistant" && message.parentId === userMessageId
  );
  if (linkedIndex >= 0) return linkedIndex;
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    if (messages[index].role === "assistant") return index;
    if (messages[index].role === "user") return -1;
  }
  return -1;
}

function descendantNodeIds(messages, rootNodeId) {
  const ids = new Set([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (
        message.role !== "user" ||
        message.id !== message.nodeId ||
        ids.has(message.nodeId) ||
        !message.parentId ||
        !ids.has(message.parentId)
      ) continue;
      ids.add(message.nodeId);
      changed = true;
    }
  }
  return ids;
}

function descendantNodeIdsForRoots(messages, roots) {
  const descendants = new Set();
  for (const root of roots) {
    for (const nodeId of descendantNodeIds(messages, root)) descendants.add(nodeId);
  }
  return descendants;
}

function invalidateNodeAndDescendants(messages, nodeId) {
  if (nodeId) invalidateNodeSessions(messages, descendantNodeIds(messages, nodeId));
}

function invalidateDescendantSessions(messages, nodeId) {
  if (!nodeId) return;
  const descendants = descendantNodeIds(messages, nodeId);
  descendants.delete(nodeId);
  invalidateNodeSessions(messages, descendants);
}

function invalidateNodeSessions(messages, nodeIds) {
  for (const message of messages) {
    if (message.role === "user" && nodeIds.has(message.nodeId || message.id)) {
      message.agentSession = null;
    }
  }
}
