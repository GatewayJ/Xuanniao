import {
  branchRevisionForQuestion,
  conversationNode,
  parentQuestion,
  selectionComesFromNode
} from "./thread-tree.js";

export const CONVERSATION_NODE_KINDS = new Set([
  "question",
  "idea",
  "assumption",
  "evidence",
  "risk",
  "decision",
  "task"
]);

export function planConversationQuestion(thread, command) {
  const content = String(command.content || "").trim();
  if (!content) throw new ConversationRuleError("message content is required");
  assertAppendOnlyPlacement(command);

  if (optionalId(command.nodeId)) {
    throw new ConversationRuleError(
      "new questions must create a new conversation node; edit or retry the existing question instead"
    );
  }

  const parentMessageId = optionalId(command.parentMessageId);
  try {
    parentQuestion(thread, parentMessageId);
  } catch (error) {
    throw new ConversationRuleError(error instanceof Error ? error.message : String(error));
  }

  const branchSelection = normalizeBranchSelection(command.branchSelection);
  if (branchSelection) {
    if (!parentMessageId) {
      throw new ConversationRuleError("selected message text requires a conversation node");
    }
    if (!selectionComesFromNode(thread, branchSelection, parentMessageId)) {
      throw new ConversationRuleError("selected message text must come from the target node");
    }
  }

  return {
    askAgent: command.askAgent !== false,
    message: {
      role: "user",
      content,
      nodeId: null,
      parentId: parentMessageId,
      meta: branchSelection ? { branchSelection } : {}
    }
  };
}

export function planConversationRevision(thread, messageId, command) {
  const content = String(command.content || "").trim();
  if (!content) throw new ConversationRuleError("message content is required");

  const revisedMessage = thread.messages.find(
    (message) => message.id === messageId && message.role === "user"
  );
  const revised = revisedMessage
    ? conversationNode(thread, revisedMessage.nodeId || revisedMessage.id)
    : null;
  if (!revisedMessage || !revised) {
    throw new ConversationRuleError(`conversation node not found: ${messageId}`);
  }

  const meta = { revisesMessageId: revisedMessage.id };
  if (Array.isArray(revisedMessage.meta?.references)) meta.references = revisedMessage.meta.references;
  if (CONVERSATION_NODE_KINDS.has(revised.meta?.nodeKind)) {
    meta.nodeKind = revised.meta.nodeKind;
  }
  const branchSelection = normalizeBranchSelection(revised.meta?.branchSelection);
  if (branchSelection) meta.branchSelection = branchSelection;

  return {
    askAgent: command.askAgent !== false,
    message: {
      role: "user",
      content,
      nodeId: null,
      parentId: revised.parentId || null,
      meta
    }
  };
}

export function prepareConversationAgentTurn(thread, questionMessageId) {
  const question = thread.messages.find(
    (message) => message.id === questionMessageId && message.role === "user"
  );
  if (!question) throw new Error(`question message not found: ${questionMessageId}`);

  const nodeId = question.nodeId || question.id;
  const nodeRoot = thread.messages.find(
    (message) => message.role === "user" && message.id === nodeId
  );
  if (!nodeRoot) throw new Error(`conversation node not found: ${nodeId}`);
  if (
    normalizeAgentSession(nodeRoot.agentSession)
    || normalizeAgentSession(nodeRoot.agentSessionClaim)
  ) return false;

  const parentRoot = nodeRoot.parentId
    ? thread.messages.find(
      (message) => message.role === "user"
        && message.id === nodeRoot.parentId
        && (message.nodeId || message.id) === message.id
    )
    : null;
  const parentSession = normalizeAgentSession(parentRoot?.agentSession);
  if (!parentRoot || !parentSession) return false;

  const sessionClaimed = thread.messages.some((message) => (
    message.role === "user"
    && message.id === (message.nodeId || message.id)
    && agentSessionsMatch(message.agentSessionClaim, parentSession)
  ));
  if (sessionClaimed) return false;

  const sessionHead = thread.messages.findLast((message) => (
    message.role === "user"
    && message.id === (message.nodeId || message.id)
    && agentSessionsMatch(message.agentSession, parentSession)
  ));
  if (sessionHead?.id !== parentRoot.id) return false;

  nodeRoot.agentSessionClaim = parentSession;
  return true;
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
    throw new ConversationConflictError("conversation branch changed while the agent was working; retry the question");
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
  const previousSession = normalizeAgentSession(nodeRoot.agentSession)
    || normalizeAgentSession(nodeRoot.agentSessionClaim);
  const completedSession = normalizeAgentSession(agentSession);
  if (!completedSession && previousSession) {
    invalidateAgentSessions(thread.messages, new Set([agentSessionKey(previousSession)]));
  } else {
    nodeRoot.agentSession = completedSession;
    nodeRoot.agentSessionClaim = null;
  }
  thread.updatedAt = now;
  return saved;
}

export function updateConversationMessage(thread, messageId, patch, now) {
  const message = requireMessage(thread, messageId);
  if (message.role !== "user") throw new Error("only local user comments can be edited");
  message.content = patch.content;
  if (Object.hasOwn(patch, "agentRunId")) setMessageAgentRunId(message, patch.agentRunId);
  message.updatedAt = now;
  invalidateNodeAndDescendants(thread.messages, message.nodeId || message.id);
  thread.updatedAt = now;
  return message;
}

export function updateConversationAgentRun(thread, messageId, agentRunId, now) {
  const message = requireMessage(thread, messageId);
  if (message.role !== "user") throw new Error("only user questions can reference an agent run");
  setMessageAgentRunId(message, agentRunId);
  message.updatedAt = now;
  thread.updatedAt = now;
  return message;
}

export function updateConversationMessageMeta(thread, messageId, metaPatch, now) {
  const message = requireMessage(thread, messageId);
  if (message.role !== "user") throw new Error("only user questions can store planning metadata");
  message.meta = { ...(message.meta || {}), ...normalizeConversationMetaPatch(metaPatch) };
  message.updatedAt = now;
  thread.updatedAt = now;
  return message;
}

export function normalizeConversationMetaPatch(value) {
  const patch = value && typeof value === "object" ? value : {};
  const meta = {};
  if (Object.hasOwn(patch, "nodeKind")) {
    if (!CONVERSATION_NODE_KINDS.has(patch.nodeKind)) {
      throw new ConversationRuleError("unsupported node kind");
    }
    meta.nodeKind = patch.nodeKind;
  }
  return meta;
}

function setMessageAgentRunId(message, agentRunId) {
  const meta = { ...(message.meta || {}) };
  if (agentRunId) {
    meta.agentRunId = agentRunId;
  } else {
    delete meta.agentRunId;
  }
  message.meta = meta;
}

export function deleteConversationMessage(thread, messageId, now) {
  const message = requireMessage(thread, messageId);
  let removed;
  if (message.role === "user" && message.nodeId === message.id) {
    const nodeIds = descendantNodeIds(thread.messages, message.nodeId);
    removed = thread.messages.filter((item) => item.nodeId && nodeIds.has(item.nodeId));
    const removedSessionKeys = agentSessionKeys(removed);
    const removedIds = new Set(removed.map((item) => item.id));
    thread.messages = thread.messages.filter((item) => !removedIds.has(item.id));
    invalidateAgentSessions(thread.messages, removedSessionKeys);
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

export function normalizeAgentSession(value) {
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
  return null;
}

function agentSessionsMatch(left, right) {
  const normalizedLeft = normalizeAgentSession(left);
  const normalizedRight = normalizeAgentSession(right);
  return Boolean(
    normalizedLeft
    && normalizedRight
    && normalizedLeft.adapter === normalizedRight.adapter
    && normalizedLeft.sessionId === normalizedRight.sessionId
  );
}

export class ConversationRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationRuleError";
    this.code = "CONVERSATION_RULE";
    this.statusCode = 400;
  }
}

export class ConversationConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationConflictError";
    this.code = "CONVERSATION_CONFLICT";
    this.statusCode = 409;
  }
}

function assertAppendOnlyPlacement(command) {
  if (Object.hasOwn(command, "adoptExistingChildren") || Object.hasOwn(command, "insertBeforeNodeId")) {
    throw new ConversationRuleError(
      "custom node placement is no longer supported; new nodes are always appended directly to their parent"
    );
  }
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
    agentSession: normalizeAgentSession(message.agentSession),
    agentSessionClaim: normalizeAgentSession(message.agentSessionClaim),
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
  const invalidatedSessionKeys = agentSessionKeys(
    messages.filter((message) => (
      message.role === "user" && nodeIds.has(message.nodeId || message.id)
    ))
  );
  for (const message of messages) {
    if (
      message.role === "user"
      && (
        nodeIds.has(message.nodeId || message.id)
        || invalidatedSessionKeys.has(agentSessionKey(message.agentSession))
        || invalidatedSessionKeys.has(agentSessionKey(message.agentSessionClaim))
      )
    ) {
      message.agentSession = null;
      message.agentSessionClaim = null;
    }
  }
}

function agentSessionKeys(messages) {
  return new Set(
    messages
      .flatMap((message) => [
        agentSessionKey(message.agentSession),
        agentSessionKey(message.agentSessionClaim)
      ])
      .filter(Boolean)
  );
}

function invalidateAgentSessions(messages, sessionKeys) {
  if (sessionKeys.size === 0) return;
  for (const message of messages) {
    if (
      message.role === "user"
      && (
        sessionKeys.has(agentSessionKey(message.agentSession))
        || sessionKeys.has(agentSessionKey(message.agentSessionClaim))
      )
    ) {
      message.agentSession = null;
      message.agentSessionClaim = null;
    }
  }
}

function agentSessionKey(value) {
  const session = normalizeAgentSession(value);
  return session ? `${session.adapter}:${session.sessionId}` : "";
}
