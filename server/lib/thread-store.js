import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText } from "./atomic-file.js";
import { orphanThread } from "./thread-anchor-remap.js";
import {
  appendConversationMessage,
  completeConversationAgentTurn,
  deleteConversationMessage,
  hasAssistantReply,
  normalizeAgentSession,
  prepareConversationAgentTurn,
  removeAssistantReply,
  updateConversationMessage,
  updateConversationAgentRun,
  updateConversationMessageMeta
} from "./conversation-model.js";

const mutationLocks = new Map();

export class ThreadStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async list() {
    await this.waitForMutations();
    const data = await this.read();
    return data.threads;
  }

  async get(id) {
    await this.waitForMutations();
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === id);
    if (!thread) {
      throw new Error(`thread not found: ${id}`);
    }
    return thread;
  }

  async create({ title, selectedText, anchor, independent = false, contextScope = "full", sourceThreadId = null, orphaned = false }) {
    return this.withMutation(async () => {
      const data = await this.read();
      const existing = findExistingThread(data.threads, {
        selectedText,
        anchor
      });
      if (existing && !independent && !orphaned) {
        return existing;
      }

      const now = new Date().toISOString();
      const thread = {
        id: randomUUID(),
        title,
        selectedText,
        anchor: orphaned ? orphanThread({ anchor }).anchor : anchor,
        orphaned,
        contextScope,
        independent,
        sourceThreadId,
        messages: [],
        createdAt: now,
        updatedAt: now
      };
      data.threads.unshift(thread);
      await this.write(data);
      return thread;
    });
  }

  async addMessage(threadId, message) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const now = new Date().toISOString();
      const saved = appendConversationMessage(thread, message, { id: randomUUID(), now });
      await this.write(data);
      return saved;
    });
  }

  async prepareAgentTurn(threadId, userMessageId) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const changed = prepareConversationAgentTurn(thread, userMessageId);
      if (changed) await this.write(data);
      return thread;
    });
  }

  async completeAgentTurn(threadId, userMessageId, message, agentSession, expectedBranchRevision = null) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const now = new Date().toISOString();
      const saved = completeConversationAgentTurn(
        thread,
        userMessageId,
        message,
        agentSession,
        expectedBranchRevision,
        { id: randomUUID(), now }
      );
      await this.write(data);
      return saved;
    });
  }

  async completeAgentTurnWithAnchorReconciliation({
    threadId,
    userMessageId,
    message,
    agentSession,
    expectedBranchRevision,
    reconcile
  }) {
    return this.withMutation(async () => {
      const data = await this.read();
      const update = await reconcile(data.threads);
      const thread = requireThread(data, threadId);
      const assistantMessage = completeConversationAgentTurn(
        thread,
        userMessageId,
        message,
        agentSession,
        expectedBranchRevision,
        { id: randomUUID(), now: new Date().toISOString() }
      );
      applyAnchorUpdates(
        data,
        Array.isArray(update?.patches) ? update.patches : [],
        Array.isArray(update?.deletedThreadIds) ? update.deletedThreadIds : []
      );
      await this.write(data);
      return { assistantMessage, threads: data.threads };
    });
  }

  async updateMessage(threadId, messageId, patch) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const message = updateConversationMessage(thread, messageId, patch, new Date().toISOString());
      await this.write(data);
      return message;
    });
  }

  async prepareQuestionRerun(threadId, messageId, patch) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const now = new Date().toISOString();
      const message = updateConversationMessage(thread, messageId, patch, now);
      const removedAssistant = removeAssistantReply(thread, messageId, now);
      await this.write(data);
      return { message, removedAssistant };
    });
  }

  async setAgentRunId(threadId, messageId, agentRunId) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const message = updateConversationAgentRun(
        thread,
        messageId,
        agentRunId,
        new Date().toISOString()
      );
      await this.write(data);
      return message;
    });
  }

  async updateMessageMeta(threadId, messageId, metaPatch) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const now = new Date().toISOString();
      const message = updateConversationMessageMeta(thread, messageId, metaPatch, now);
      await this.write(data);
      return message;
    });
  }

  async deleteMessage(threadId, messageId) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const removed = deleteConversationMessage(thread, messageId, new Date().toISOString());
      await this.write(data);
      return removed;
    });
  }

  async removeAssistantAfter(threadId, userMessageId) {
    return this.withMutation(async () => {
      const data = await this.read();
      const thread = requireThread(data, threadId);
      const removed = removeAssistantReply(thread, userMessageId, new Date().toISOString());
      if (!removed) return null;
      await this.write(data);
      return removed;
    });
  }

  async hasAssistantAfter(threadId, userMessageId) {
    await this.waitForMutations();
    const data = await this.read();
    return hasAssistantReply(requireThread(data, threadId), userMessageId);
  }

  async updateAnchors(patches, deletedThreadIds = [], { allowReanchor = false } = {}) {
    return this.withMutation(async () => {
      const data = await this.read();
      const changed = applyAnchorUpdates(data, patches, deletedThreadIds, allowReanchor);
      if (changed) await this.write(data);
      return data.threads;
    });
  }

  async reconcileAnchors(reconciler) {
    return this.withMutation(async () => {
      const data = await this.read();
      const update = await reconciler(data.threads);
      const changed = applyAnchorUpdates(
        data,
        Array.isArray(update?.patches) ? update.patches : [],
        Array.isArray(update?.deletedThreadIds) ? update.deletedThreadIds : []
      );
      if (changed) await this.write(data);
      return data.threads;
    });
  }

  async delete(threadId) {
    return this.withMutation(async () => {
      const data = await this.read();
      const originalLength = data.threads.length;
      data.threads = data.threads.filter((item) => item.id !== threadId);
      if (data.threads.length === originalLength) {
        throw new Error(`thread not found: ${threadId}`);
      }
      await this.write(data);
    });
  }

  async withMutation(operation) {
    const previous = mutationLocks.get(this.filePath) || Promise.resolve();
    const run = previous.then(operation, operation);
    const barrier = run.catch(() => {});
    mutationLocks.set(this.filePath, barrier);
    try {
      return await run;
    } finally {
      if (mutationLocks.get(this.filePath) === barrier) {
        mutationLocks.delete(this.filePath);
      }
    }
  }

  async waitForMutations() {
    await (mutationLocks.get(this.filePath) || Promise.resolve());
  }

  async read() {
    if (!existsSync(this.filePath)) {
      return { version: 3, threads: [] };
    }
    const raw = await readFile(this.filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      version: data.version || 1,
      threads: Array.isArray(data.threads) ? data.threads.map(normalizeStoredThread) : []
    };
  }

  async write(data) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await atomicWriteText(this.filePath, `${JSON.stringify({ ...data, version: 3 }, null, 2)}\n`);
  }
}

function applyAnchorUpdates(data, patches, deletedThreadIds, allowReanchor = false) {
  const patchById = new Map(patches.map((patch) => [patch.id, patch]));
  const deletedIds = new Set(deletedThreadIds);
  let changed = false;
  const now = new Date().toISOString();

  for (const thread of data.threads) {
    const patch = patchById.get(thread.id);
    if (!patch && !deletedIds.has(thread.id)) continue;
    if (deletedIds.has(thread.id) || patch?.orphaned === true || (thread.orphaned && !allowReanchor)) {
      Object.assign(thread, orphanThread(thread));
    } else {
      thread.anchor = patch.anchor;
      if (typeof patch.orphaned === "boolean") thread.orphaned = patch.orphaned;
      if (typeof patch.selectedText === "string") thread.selectedText = patch.selectedText;
    }
    thread.updatedAt = now;
    changed = true;
  }
  return changed;
}

function normalizeStoredThread(thread) {
  const { agentSession, ...stored } = thread;
  const messages = normalizeStoredMessages(thread.messages);
  const legacySession = normalizeAgentSession(agentSession);
  const firstNodeRoot = messages.find((message) => message.role === "user" && message.id === (message.nodeId || message.id));
  if (legacySession && firstNodeRoot && !firstNodeRoot.agentSession) {
    firstNodeRoot.agentSession = legacySession;
  }
  return {
    ...(stored.orphaned ? orphanThread(stored) : stored),
    messages
  };
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) return [];
  let previousQuestionId = null;
  let previousNodeId = null;
  return messages.map((message) => {
    const hasParentId = Object.prototype.hasOwnProperty.call(message, "parentId");
    const parentId = hasParentId ? (typeof message.parentId === "string" && message.parentId ? message.parentId : null) : previousQuestionId;
    const normalized = {
      ...message,
      nodeId: typeof message.nodeId === "string" && message.nodeId ? message.nodeId : message.role === "user" ? message.id : parentId || previousNodeId,
      parentId,
      agentSession: normalizeAgentSession(message.agentSession),
      agentSessionClaim: normalizeAgentSession(message.agentSessionClaim)
    };
    if (message.role === "user") {
      previousQuestionId = message.id;
      previousNodeId = normalized.nodeId;
    }
    return normalized;
  });
}

function findExistingThread(threads, { selectedText, anchor }) {
  const hasAnchorRange = Number.isInteger(anchor?.start) && Number.isInteger(anchor?.end);
  const normalizedText = normalizeText(selectedText);
  return (
    threads.find((thread) => {
      if (thread.independent || thread.orphaned) return false;
      const threadAnchor = thread.anchor || {};
      if (hasAnchorRange) {
        return threadAnchor.start === anchor.start && threadAnchor.end === anchor.end;
      }
      return normalizedText && normalizeText(thread.selectedText) === normalizedText;
    }) || null
  );
}

function requireThread(data, threadId) {
  const thread = data.threads.find((item) => item.id === threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  return thread;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}
