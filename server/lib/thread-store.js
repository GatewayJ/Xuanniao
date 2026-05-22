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

  async deleteMessage(threadId, messageId) {
    const data = await this.read();
    const thread = data.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error(`thread not found: ${threadId}`);
    }

    const index = thread.messages.findIndex((item) => item.id === messageId);
    if (index < 0) {
      throw new Error(`message not found: ${messageId}`);
    }

    const message = thread.messages[index];
    const assistantIndex = message.role === "user" ? findAssistantReplyIndex(thread.messages, index) : -1;
    const removed = thread.messages.splice(index, 1);
    if (assistantIndex >= 0) {
      const adjustedAssistantIndex = assistantIndex > index ? assistantIndex - 1 : assistantIndex;
      removed.push(...thread.messages.splice(adjustedAssistantIndex, 1));
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

  async updateAnchors(patches) {
    const data = await this.read();
    const patchById = new Map(patches.map((patch) => [patch.id, patch]));
    let changed = false;
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
      threads: Array.isArray(data.threads) ? data.threads : []
    };
  }

  async write(data) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function makeSavedMessage(message, now) {
  return {
    id: randomUUID(),
    role: message.role,
    content: message.content,
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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
