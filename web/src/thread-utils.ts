import type { Message, SelectionContext, Thread } from "./types";

export function orderThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => (a.anchor.lineStart || 999999) - (b.anchor.lineStart || 999999));
}

export function titleForSelection(selectedText: string): string {
  return selectedText.trim().split(/\s+/).slice(0, 10).join(" ");
}

export function findThreadForSelection(threads: Thread[], selection: SelectionContext): Thread | null {
  if (Number.isInteger(selection.anchor.start) && Number.isInteger(selection.anchor.end)) {
    return threads.find((thread) => thread.anchor.start === selection.anchor.start && thread.anchor.end === selection.anchor.end) || null;
  }

  const selectedText = normalizeText(selection.selectedText);
  return threads.find((thread) => {
    if (normalizeText(thread.selectedText) !== selectedText) return false;
    if (Number.isInteger(selection.anchor.lineStart) && Number.isInteger(thread.anchor.lineStart)) {
      return selection.anchor.lineStart === thread.anchor.lineStart;
    }
    return true;
  }) || null;
}

export function insertThreadOnce(threads: Thread[], thread: Thread): Thread[] {
  return threads.some((item) => item.id === thread.id) ? threads : [thread, ...threads];
}

export function appendPendingMessage(threads: Thread[], threadId: string, content: string, askAgent: boolean): Thread[] {
  const now = new Date().toISOString();
  const pendingMessages: Message[] = [
    { id: `pending-${Date.now()}`, role: "user", content, createdAt: now }
  ];

  if (askAgent) {
    pendingMessages.push({
      id: `pending-agent-${Date.now()}`,
      role: "assistant",
      content: "Working with local Codex...",
      createdAt: now
    });
  }

  return threads.map((thread) => thread.id === threadId ? {
    ...thread,
    messages: [...thread.messages, ...pendingMessages]
  } : thread);
}

export function hasAssistantReplyAfter(threads: Thread[], threadId: string, messageId: string): boolean {
  const thread = threads.find((item) => item.id === threadId);
  const index = thread?.messages.findIndex((message) => message.id === messageId) ?? -1;
  return Boolean(thread && findAssistantReplyIndex(thread.messages, index) >= 0);
}

export function updateMessageWithPendingReply(threads: Thread[], threadId: string, messageId: string, content: string, rerunAgent: boolean): Thread[] {
  return threads.map((thread) => {
    if (thread.id !== threadId) return thread;

    const index = thread.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return thread;

    const messages = thread.messages.map((message) => (
      message.id === messageId ? { ...message, content, updatedAt: new Date().toISOString() } : message
    ));

    if (rerunAgent) {
      const pendingAssistant: Message = {
        id: `pending-agent-${Date.now()}`,
        role: "assistant",
        content: "Updating Codex reply...",
        createdAt: new Date().toISOString()
      };
      const assistantIndex = findAssistantReplyIndex(messages, index);
      if (assistantIndex >= 0) {
        messages[assistantIndex] = pendingAssistant;
      } else {
        messages.splice(index + 1, 0, pendingAssistant);
      }
    }

    return { ...thread, messages };
  });
}

function findAssistantReplyIndex(messages: Message[], userMessageIndex: number): number {
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    if (messages[index].role === "assistant") return index;
    if (messages[index].role === "user") return -1;
  }
  return -1;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
