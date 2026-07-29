import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { api } from "../api.ts";
import {
  appendPendingMessage,
  hasAssistantReplyAfter,
  updateMessageWithPendingReply
} from "../thread-utils.ts";
import type {
  AgentOutcome,
  ConversationMessageCommand,
  ConversationNodeKind,
  DocumentPayload,
  Message,
  Thread
} from "../types";

type ConversationCommandOptions = {
  threadsRef: { current: Thread[] };
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  flushDocumentSave: () => Promise<boolean>;
  applyDocument: (document: DocumentPayload) => boolean;
};

export function useConversationCommands({
  threadsRef,
  setThreads,
  setActiveThreadId,
  setStatus,
  flushDocumentSave,
  applyDocument
}: ConversationCommandOptions) {
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  async function send(command: ConversationMessageCommand) {
    const thread = threadsRef.current.find((item) => item.id === command.threadId);
    const content = command.content.trim();
    if (!thread) return;
    if (!content) {
      setStatus("请先输入内容");
      return;
    }
    if (!await flushDocumentSave()) return;

    if (command.draftKey) {
      setMessageDrafts((current) => {
        const next = { ...current };
        delete next[command.draftKey as string];
        return next;
      });
    }
    const normalized = { ...command, content };
    setStatus(command.askAgent ? "正在询问 Codex" : "正在添加评论");
    setThreads((current) => appendPendingMessage(current, normalized));

    try {
      const payload = await api.sendMessage(command.threadId, {
        content,
        askAgent: command.askAgent,
        nodeId: command.nodeId,
        parentMessageId: command.parentMessageId,
        branchSelection: command.branchSelection,
        adoptExistingChildren: command.adoptExistingChildren,
        insertBeforeNodeId: command.insertBeforeNodeId
      });
      setThreads(payload.threads);
      const documentApplied = payload.document ? applyDocument(payload.document) : true;
      setActiveThreadId(command.threadId);
      if (documentApplied) {
        setStatus(statusForOutcome(payload.agentOutcome, command.askAgent ? "Codex 已回答" : "评论已保存"));
      }
    } catch (error) {
      await recoverThreads(error);
    }
  }

  async function saveEditedMessage(threadId: string, messageId: string) {
    const content = editText.trim();
    if (!content) return;
    const rerunAgent = hasAssistantReplyAfter(threadsRef.current, threadId, messageId);
    setThreads((current) =>
      updateMessageWithPendingReply(current, threadId, messageId, content, rerunAgent)
    );
    setEditingMessage(null);
    setEditText("");
    setStatus(rerunAgent ? "正在更新 Codex 回答" : "评论已更新");
    try {
      const payload = await api.updateMessage(threadId, messageId, { content, rerunAgent });
      setThreads(payload.threads);
      const documentApplied = payload.document ? applyDocument(payload.document) : true;
      if (documentApplied) {
        setStatus(statusForOutcome(payload.agentOutcome, payload.assistantMessage ? "Codex 已回答" : "评论已更新"));
      }
    } catch (error) {
      await recoverThreads(error);
    }
  }

  async function updateMessageMeta(
    threadId: string,
    messageId: string,
    nodeKind: ConversationNodeKind
  ) {
    setThreads((current) => current.map((thread) => (
      thread.id !== threadId ? thread : {
        ...thread,
        messages: thread.messages.map((message) => (
          message.id === messageId
            ? { ...message, meta: { ...(message.meta || {}), nodeKind } }
            : message
        ))
      }
    )));
    setStatus("节点类型已更新");
    try {
      const payload = await api.updateMessageMeta(threadId, messageId, { nodeKind });
      setThreads(payload.threads);
      setStatus("节点类型已保存");
    } catch (error) {
      await recoverThreads(error);
    }
  }

  async function retryAssistantReply(threadId: string, assistantMessageId: string) {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const assistantIndex = thread?.messages.findIndex((message) => message.id === assistantMessageId) ?? -1;
    const userMessage = thread ? findUserMessageForAssistant(thread.messages, assistantIndex) : null;
    if (!userMessage) {
      setStatus("没有找到这条 Codex 回答对应的问题");
      return;
    }

    setStatus("正在重试 Codex");
    setThreads((current) =>
      updateMessageWithPendingReply(current, threadId, userMessage.id, userMessage.content, true)
    );
    try {
      const payload = await api.updateMessage(
        threadId,
        userMessage.id,
        { content: userMessage.content, rerunAgent: true }
      );
      setThreads(payload.threads);
      const documentApplied = payload.document ? applyDocument(payload.document) : true;
      setActiveThreadId(threadId);
      if (documentApplied) {
        setStatus(statusForOutcome(payload.agentOutcome, "Codex 已回答"));
      }
    } catch (error) {
      await recoverThreads(error);
    }
  }

  async function deleteMessage(threadId: string, messageId: string) {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const target = thread?.messages.find((message) => message.id === messageId);
    const deletesReply =
      target?.role === "user" &&
      hasAssistantReplyAfter(threadsRef.current, threadId, messageId);
    const descendantCount =
      target?.role === "user" &&
      target.nodeId === target.id &&
      thread
        ? countDescendantNodes(thread.messages, target.nodeId)
        : 0;
    const confirmed = window.confirm(
      descendantCount > 0
        ? `确定删除这个问题、对应回答以及 ${descendantCount} 个子问题吗？`
        : deletesReply
          ? "确定删除这个问题及其 Codex 回答吗？"
          : target?.role === "user"
            ? "确定删除这个问题吗？"
            : "确定删除这条 Codex 回答吗？"
    );
    if (!confirmed) return;

    setStatus("正在删除消息");
    try {
      const payload = await api.deleteMessage(threadId, messageId);
      setThreads(payload.threads);
      if (editingMessage === messageId) cancelEdit();
      setStatus("消息已删除");
    } catch (error) {
      await recoverThreads(error);
    }
  }

  function beginEdit(message: Message) {
    setEditingMessage(message.id);
    setEditText(message.content);
  }

  function cancelEdit() {
    setEditingMessage(null);
    setEditText("");
  }

  function setMessageDraft(draftKey: string, value: string) {
    setMessageDrafts((current) => ({ ...current, [draftKey]: value }));
  }

  function resetConversationEditor() {
    setMessageDrafts({});
    cancelEdit();
  }

  async function recoverThreads(error: unknown) {
    setStatus(error instanceof Error ? error.message : String(error));
    try {
      setThreads((await api.threads()).threads);
    } catch {
      // Preserve the original actionable error when recovery also fails.
    }
  }

  return {
    messageDrafts,
    editingMessage,
    editText,
    setEditText,
    setMessageDraft,
    beginEdit,
    cancelEdit,
    resetConversationEditor,
    send,
    saveEditedMessage,
    updateMessageMeta,
    retryAssistantReply,
    deleteMessage
  };
}

export function statusForOutcome(outcome: AgentOutcome, successStatus: string): string {
  return outcome === "failed" ? "Codex 请求失败，请查看错误回答" : successStatus;
}

function findUserMessageForAssistant(messages: Message[], assistantIndex: number): Message | null {
  if (assistantIndex <= 0 || messages[assistantIndex]?.role !== "assistant") return null;
  const parentId = messages[assistantIndex].parentId;
  if (parentId) {
    const parent = messages.find((message) => message.id === parentId && message.role === "user");
    if (parent) return parent;
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index];
  }
  return null;
}

function countDescendantNodes(messages: Message[], rootNodeId: string): number {
  const ids = new Set([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (
        message.role !== "user" ||
        message.id !== message.nodeId ||
        !message.nodeId ||
        ids.has(message.nodeId) ||
        !message.parentId ||
        !ids.has(message.parentId)
      ) continue;
      ids.add(message.nodeId);
      changed = true;
    }
  }
  return ids.size - 1;
}
