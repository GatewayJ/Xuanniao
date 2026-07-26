import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class ThreadStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async list() {
    const data = await this.read();
    return data.threads;
  }

  async get(id) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === id);
    if (!thread) {
      throw new Error(`thread not found: ${id}`);
    }
    return thread;
  }

  async create({ title, selectedText, anchor }) {
    const data = await this.read();
    const existing = findExistingThread(data.threads, { selectedText, anchor });
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const thread = {
      id: randomUUID(),
      title,
      selectedText,
      anchor,
      acpSessionId: null,
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    data.threads.unshift(thread);
    await this.write(data);
    return thread;
  }

  async addMessage(threadId, message) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }

    const now = new Date().toISOString();
    const saved = makeSavedMessage(message, now);
    thread.messages.push(saved);
    thread.updatedAt = now;
    await this.write(data);
    return saved;
  }

  async insertNodeAfter(threadId, parentNodeId, message) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }
    const parent = thread.messages.find((item) => (
      item.role === "user" && item.id === parentNodeId && (item.nodeId || item.id) === parentNodeId
    ));
    if (!parent) {
      throw new Error(`parent question not found: ${parentNodeId}`);
    }

    const now = new Date().toISOString();
    const saved = makeSavedMessage({ ...message, nodeId: null, parentId: parentNodeId }, now);
    for (const existing of thread.messages) {
      if (
        existing.role === "user"
        && existing.id === (existing.nodeId || existing.id)
        && existing.parentId === parentNodeId
      ) {
        existing.parentId = saved.nodeId;
      }
    }
    thread.messages.push(saved);
    thread.updatedAt = now;
    await this.write(data);
    return saved;
  }

  async addMessageAfter(threadId, afterMessageId, message) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }
    const index = thread.messages.findIndex((item) => item.id === afterMessageId);
    if (index < 0) {
      throw new Error(`message not found: ${afterMessageId}`);
    }

    const now = new Date().toISOString();
    const saved = makeSavedMessage(message, now);
    thread.messages.splice(index + 1, 0, saved);
    thread.updatedAt = now;
    await this.write(data);
    return saved;
  }

  async updateMessage(threadId, messageId, patch) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }

    const message = thread.messages.find((item) => item.id === messageId);
    if (!message) {
      throw new Error(`message not found: ${messageId}`);
    }
    if (message.role !== "user") {
      throw new Error("only local user comments can be edited");
    }

    message.content = patch.content;
    message.updatedAt = new Date().toISOString();
    thread.updatedAt = message.updatedAt;
    await this.write(data);
    return message;
  }

  async updateMessageSession(threadId, messageId, acpSessionId) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }

    const message = thread.messages.find((item) => item.id === messageId);
    if (!message || message.role !== "user") {
      throw new Error(`question message not found: ${messageId}`);
    }

    message.acpSessionId = acpSessionId || null;
    await this.write(data);
    return message;
  }

  async deleteMessage(threadId, messageId) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }

    const message = thread.messages.find((item) => item.id === messageId);
    if (!message) {
      throw new Error(`message not found: ${messageId}`);
    }

    let removed;
    if (message.role === "user" && message.nodeId === message.id) {
      const nodeIds = descendantNodeIds(thread.messages, message.nodeId);
      removed = thread.messages.filter((item) => (
        item.nodeId && nodeIds.has(item.nodeId)
      ));
      thread.messages = thread.messages.filter((item) => !removed.includes(item));
    } else if (message.role === "user") {
      const messageIndex = thread.messages.findIndex((item) => item.id === message.id);
      const assistantIndex = findAssistantReplyIndex(thread.messages, messageIndex);
      const removedIds = new Set([message.id]);
      if (assistantIndex >= 0) removedIds.add(thread.messages[assistantIndex].id);
      removed = thread.messages.filter((item) => removedIds.has(item.id));
      thread.messages = thread.messages.filter((item) => !removedIds.has(item.id));
    } else {
      removed = [message];
      thread.messages = thread.messages.filter((item) => item.id !== message.id);
    }

    thread.updatedAt = new Date().toISOString();
    await this.write(data);
    return removed;
  }

  async removeAssistantAfter(threadId, userMessageId) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }
    const index = thread.messages.findIndex((item) => item.id === userMessageId);
    if (index < 0) {
      throw new Error(`message not found: ${userMessageId}`);
    }
    const assistantIndex = findAssistantReplyIndex(thread.messages, index);
    if (assistantIndex < 0) {
      return null;
    }

    const [removed] = thread.messages.splice(assistantIndex, 1);
    thread.updatedAt = new Date().toISOString();
    await this.write(data);
    return removed;
  }

  async hasAssistantAfter(threadId, userMessageId) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }
    const index = thread.messages.findIndex((item) => item.id === userMessageId);
    if (index < 0) {
      throw new Error(`message not found: ${userMessageId}`);
    }
    return findAssistantReplyIndex(thread.messages, index) >= 0;
  }

  async updateThread(threadId, patch) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }

    Object.assign(thread, patch, {
      updatedAt: new Date().toISOString()
    });
    await this.write(data);
    return thread;
  }

  async updateAnchors(patches, deletedThreadIds = []) {
    const data = await this.read();
    const patchById = new Map(patches.map((patch) => [patch.id, patch]));
    const deletedIds = new Set(deletedThreadIds);
    const originalLength = data.threads.length;
    data.threads = data.threads.filter((thread) => !deletedIds.has(thread.id));
    let changed = data.threads.length !== originalLength;
    const now = new Date().toISOString();

    for (const thread of data.threads) {
      const patch = patchById.get(thread.id);
      if (!patch) continue;
      thread.anchor = patch.anchor;
      if (typeof patch.selectedText === "string") {
        thread.selectedText = patch.selectedText;
      }
      thread.updatedAt = now;
      changed = true;
    }

    if (changed) {
      await this.write(data);
    }
    return data.threads;
  }

  async delete(threadId) {
    const data = await this.read();
    const originalLength = data.threads.length;
    data.threads = data.threads.filter((item) => item.id !== threadId);
    if (data.threads.length === originalLength) {
      throw new Error(`thread not found: ${threadId}`);
    }
    await this.write(data);
  }

  async read() {
    if (!existsSync(this.filePath)) {
      return { version: 1, threads: [] };
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
    await writeFile(this.filePath, `${JSON.stringify({ ...data, version: 2 }, null, 2)}\n`, "utf8");
  }
}

function normalizeStoredThread(thread) {
  return {
    ...thread,
    acpSessionId: typeof thread.acpSessionId === "string" && thread.acpSessionId ? thread.acpSessionId : null,
    messages: normalizeStoredMessages(thread.messages)
  };
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) return [];
  let previousQuestionId = null;
  let previousNodeId = null;
  return messages.map((message) => {
    const hasParentId = Object.prototype.hasOwnProperty.call(message, "parentId");
    const parentId = hasParentId
      ? (typeof message.parentId === "string" && message.parentId ? message.parentId : null)
      : previousQuestionId;
    const normalized = {
      ...message,
      nodeId: typeof message.nodeId === "string" && message.nodeId
        ? message.nodeId
        : message.role === "user" ? message.id : parentId || previousNodeId,
      parentId,
      acpSessionId: typeof message.acpSessionId === "string" && message.acpSessionId ? message.acpSessionId : null
    };
    if (message.role === "user") {
      previousQuestionId = message.id;
      previousNodeId = normalized.nodeId;
    }
    return normalized;
  });
}

function makeSavedMessage(message, now) {
  const id = randomUUID();
  return {
    id,
    role: message.role,
    content: message.content,
    nodeId: typeof message.nodeId === "string" && message.nodeId ? message.nodeId : message.role === "user" ? id : null,
    parentId: typeof message.parentId === "string" && message.parentId ? message.parentId : null,
    acpSessionId: typeof message.acpSessionId === "string" && message.acpSessionId ? message.acpSessionId : null,
    error: Boolean(message.error),
    meta: message.meta || {},
    createdAt: now
  };
}

function findExistingThread(threads, { selectedText, anchor }) {
  const hasAnchorRange = Number.isInteger(anchor?.start) && Number.isInteger(anchor?.end);
  const normalizedText = normalizeText(selectedText);
  return threads.find((thread) => {
    const threadAnchor = thread.anchor || {};
    if (hasAnchorRange) {
      return threadAnchor.start === anchor.start && threadAnchor.end === anchor.end;
    }
    return normalizedText && normalizeText(thread.selectedText) === normalizedText;
  }) || null;
}

function findAssistantReplyIndex(messages, userMessageIndex) {
  const userMessageId = messages[userMessageIndex]?.id;
  const linkedIndex = messages.findIndex((message) => message.role === "assistant" && message.parentId === userMessageId);
  if (linkedIndex >= 0) return linkedIndex;
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return index;
    }
    if (message.role === "user") {
      return -1;
    }
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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
