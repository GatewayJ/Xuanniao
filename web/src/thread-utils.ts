import { compareThreadsByAnchor, normalizeSearchText, resolveThreadAnchor } from "./thread-anchors.ts";
import type { ConversationMessageCommand, Message, SelectionContext, Thread } from "./types";

let pendingMessageSequence = 0;

export function orderThreads(threads: Thread[], content?: string | null): Thread[] {
  return [...threads].sort((left, right) => compareThreadsByAnchor(left, right, content));
}

export function titleForSelection(selectedText: string): string {
  return selectedText.trim().split(/\s+/).slice(0, 10).join(" ");
}

export function findThreadForSelection(threads: Thread[], selection: SelectionContext, content?: string | null): Thread | null {
  if (Number.isInteger(selection.anchor.start) && Number.isInteger(selection.anchor.end)) {
    return threads.find((thread) => {
      const location = content ? resolveThreadAnchor(content, thread) : null;
      return (location?.start ?? thread.anchor.start) === selection.anchor.start && (location?.end ?? thread.anchor.end) === selection.anchor.end;
    }) || null;
  }

  const selectedText = normalizeText(selection.selectedText);
  return threads.find((thread) => {
    if (normalizeText(thread.selectedText) !== selectedText) return false;
    const location = content ? resolveThreadAnchor(content, thread) : null;
    const threadLineStart = location?.lineStart ?? thread.anchor.lineStart;
    if (Number.isInteger(selection.anchor.lineStart) && Number.isInteger(threadLineStart)) {
      return selection.anchor.lineStart === threadLineStart;
    }
    return true;
  }) || null;
}

export function insertThreadOnce(threads: Thread[], thread: Thread): Thread[] {
  return threads.some((item) => item.id === thread.id) ? threads : [thread, ...threads];
}

export function appendPendingMessage(
  threads: Thread[],
  command: ConversationMessageCommand
): Thread[] {
  const now = new Date().toISOString();
  const pendingQuestionId = nextPendingMessageId("pending");
  const pendingNodeId = command.nodeId || pendingQuestionId;
  const pendingMessages: Message[] = [
    {
      id: pendingQuestionId,
      role: "user",
      content: command.content,
      nodeId: pendingNodeId,
      parentId: command.parentMessageId || null,
      meta: command.branchSelection ? { branchSelection: command.branchSelection } : {},
      createdAt: now
    }
  ];

  if (command.askAgent) {
    pendingMessages.push({
      id: nextPendingMessageId("pending-agent"),
      role: "assistant",
      content: "Working with local Codex...",
      nodeId: pendingNodeId,
      parentId: pendingQuestionId,
      createdAt: now
    });
  }

  return threads.map((thread) => {
    if (thread.id !== command.threadId) return thread;
    return { ...thread, messages: [...thread.messages, ...pendingMessages] };
  });
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
        id: nextPendingMessageId("pending-agent"),
        role: "assistant",
        content: "Updating Codex reply...",
        nodeId: messages[index].nodeId || messageId,
        parentId: messageId,
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
  const userMessageId = messages[userMessageIndex]?.id;
  const linkedIndex = messages.findIndex((message) => message.role === "assistant" && message.parentId === userMessageId);
  if (linkedIndex >= 0) return linkedIndex;
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    if (messages[index].role === "assistant") return index;
    if (messages[index].role === "user") return -1;
  }
  return -1;
}

function normalizeText(value: string): string {
  return normalizeSearchText(value);
}

function nextPendingMessageId(prefix: string): string {
  pendingMessageSequence += 1;
  return `${prefix}-${Date.now()}-${pendingMessageSequence}`;
}
