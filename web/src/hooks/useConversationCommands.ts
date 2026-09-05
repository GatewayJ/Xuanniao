import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { api } from "../api.ts";
import { conversationDraftsFor, updateConversationDrafts, type DocumentConversationDrafts } from "../conversation-drafts";
import {
  applyAgentRunSnapshot,
  applyAgentRunUpdate,
  createAgentRunId,
  restorePendingAgentRun,
  resumableAgentRuns
} from "../agent-run.ts";
import type { DocumentSessionOperation } from "../document-session-scope.ts";
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
  ReferenceSnapshot,
  Thread
} from "../types";

type ConversationCommandOptions = {
  documentPath: string | null;
  threadsRef: { current: Thread[] };
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  flushDocumentSave: () => Promise<boolean>;
  applyDocument: (document: DocumentPayload) => boolean;
  captureDocumentSession: () => DocumentSessionOperation;
  isDocumentSessionCurrent: (operation: DocumentSessionOperation) => boolean;
};

type ConversationSendOptions = {
  onQueued?: () => void;
  onError?: (message: string) => void;
};

export function useConversationCommands({
  documentPath,
  threadsRef,
  setThreads,
  setActiveThreadId,
  setStatus,
  flushDocumentSave,
  applyDocument,
  captureDocumentSession,
  isDocumentSessionCurrent
}: ConversationCommandOptions) {
  const [documentDrafts, setDocumentDrafts] = useState<DocumentConversationDrafts>({});
  const { messages: messageDrafts, references: referenceDrafts, errors: sendErrors } = conversationDraftsFor(documentDrafts, documentPath);
  const setMessageDrafts: Dispatch<SetStateAction<Record<string, string>>> = (update) => {
    setDocumentDrafts((current) => updateConversationDrafts(current, documentPath, "messages", update));
  };
  const setReferenceDrafts: Dispatch<SetStateAction<Record<string, ReferenceSnapshot[]>>> = (update) => {
    setDocumentDrafts((current) => updateConversationDrafts(current, documentPath, "references", update));
  };
  const setSendErrors: Dispatch<SetStateAction<Record<string, string>>> = (update) => {
    setDocumentDrafts((current) => updateConversationDrafts(current, documentPath, "errors", update));
  };
  const referenceDraftsRef = useRef(referenceDrafts);
  referenceDraftsRef.current = referenceDrafts;
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const sendRegistryRef = useRef(new ConversationSendRegistry());

  async function send(
    command: ConversationMessageCommand,
    options: ConversationSendOptions = {}
  ): Promise<boolean> {
    const operation = captureDocumentSession();
    const content = command.content.trim();
    if (!content) {
      setStatus("请先输入内容");
      return false;
    }
    const sendKey = conversationSendKey(command);
    if (command.draftKey) setSendErrors((current) => ({ ...current, [command.draftKey!]: "" }));
    const sendToken = sendRegistryRef.current.begin(sendKey);
    if (!sendToken) {
      setStatus("这个节点的问题正在发送");
      return false;
    }

    try {
      if (!await flushDocumentSave() || !isDocumentSessionCurrent(operation)) {
        options.onError?.("文档尚未保存或已切换，请检查后重新提交。");
        return false;
      }
      const agentRunId = command.askAgent ? createAgentRunId() : null;
      const normalized = { ...command, content, agentRunId };
      if (agentRunId) await api.reserveAgentRun(agentRunId, operation.signal);
      if (!isDocumentSessionCurrent(operation)) return false;
      setStatus(command.askAgent ? "正在询问 Codex" : "正在添加评论");
      setThreads((current) => appendPendingMessage(current, normalized));
      const closeAgentRun = agentRunId
        ? subscribeToAgentRun(command.threadId, agentRunId, operation)
        : () => {};
      let payload;
      try {
        options.onQueued?.();
        payload = await api.sendMessage(command.threadId, {
          content,
          askAgent: command.askAgent,
          nodeId: command.nodeId,
          parentMessageId: command.parentMessageId,
          branchSelection: command.branchSelection,
          references: command.references,
          agentRunId
        }, operation.signal);
      } finally {
        closeAgentRun();
      }
      if (!isDocumentSessionCurrent(operation)) return false;
      setThreads(payload.threads);
      const documentApplied = payload.document ? applyDocument(payload.document) : true;
      setActiveThreadId(command.threadId);
      const currentReferences = command.draftKey ? referenceDraftsRef.current[command.draftKey] : undefined;
      if (currentReferences === command.references || (!currentReferences?.length && !command.references?.length)) {
        clearSubmittedDraft(command.draftKey, content);
      }
      if (command.draftKey) {
        setReferenceDrafts((current) => {
          if (current[command.draftKey!] !== command.references) return current;
          const next = { ...current };
          delete next[command.draftKey!];
          return next;
        });
      }
      if (documentApplied) {
        setStatus(statusForOutcome(payload.agentOutcome, command.askAgent ? "Codex 已回答" : "评论已保存", payload.assistantMessage));
      }
      return true;
    } catch (error) {
      if (isDocumentSessionCurrent(operation)) {
        options.onError?.(error instanceof Error ? error.message : String(error));
        if (command.draftKey) setSendErrors((current) => ({ ...current, [command.draftKey!]: error instanceof Error ? error.message : String(error) }));
        await recoverThreads(error, operation);
      }
      return false;
    } finally {
      sendRegistryRef.current.finish(sendKey, sendToken);
    }
  }

  async function saveEditedMessage(threadId: string, messageId: string) {
    const operation = captureDocumentSession();
    const content = editText.trim();
    if (!content) return;
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const original = thread?.messages.find(
      (message) => message.id === messageId && message.role === "user"
    );
    if (!original) {
      setStatus("没有找到需要编辑的节点");
      return;
    }
    if (content === original.content.trim()) {
      cancelEdit();
      setStatus("节点内容没有变化");
      return;
    }

    const revisionKey = conversationRevisionKey(threadId, messageId);
    const revisionToken = sendRegistryRef.current.begin(revisionKey);
    if (!revisionToken) {
      setStatus("这个编辑分支正在创建");
      return;
    }

    const agentRunId = createAgentRunId();
    const revisionCommand = conversationRevisionCommand(threadId, original, content, agentRunId);
    setStatus("正在创建编辑分支");
    let closeAgentRun = () => {};
    try {
      await api.reserveAgentRun(agentRunId, operation.signal);
      if (!isDocumentSessionCurrent(operation)) return;
      setThreads((current) =>
        appendPendingMessage(current, revisionCommand)
      );
      closeAgentRun = subscribeToAgentRun(threadId, agentRunId, operation);
      const payload = await api.reviseMessage(
        threadId,
        messageId,
        { content, askAgent: true, agentRunId },
        operation.signal
      );
      if (!isDocumentSessionCurrent(operation)) return;
      setThreads(payload.threads);
      const documentApplied = payload.document ? applyDocument(payload.document) : true;
      setEditingMessage(null);
      setEditText("");
      if (documentApplied) {
        setStatus(statusForOutcome(payload.agentOutcome, "Codex 已回答", payload.assistantMessage));
      }
    } catch (error) {
      if (isDocumentSessionCurrent(operation)) await recoverThreads(error, operation);
    } finally {
      closeAgentRun();
      sendRegistryRef.current.finish(revisionKey, revisionToken);
    }
  }

  async function updateMessageMeta(
    threadId: string,
    messageId: string,
    nodeKind: ConversationNodeKind
  ) {
    const operation = captureDocumentSession();
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
      const payload = await api.updateMessageMeta(threadId, messageId, { nodeKind }, operation.signal);
      if (!isDocumentSessionCurrent(operation)) return;
      setThreads(payload.threads);
      setStatus("节点类型已保存");
    } catch (error) {
      if (isDocumentSessionCurrent(operation)) await recoverThreads(error, operation);
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

    await requestAssistantReply(threadId, userMessage.id, "正在重试 Codex");
  }

  async function requestAssistantReply(
    threadId: string,
    userMessageId: string,
    pendingStatus = "正在询问 Codex"
  ) {
    const operation = captureDocumentSession();
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const userMessage = thread?.messages.find(
      (message) => message.id === userMessageId && message.role === "user"
    );
    if (!userMessage) {
      setStatus("没有找到需要 Codex 回答的问题");
      return;
    }

    setStatus(pendingStatus);
    const agentRunId = createAgentRunId();
    let closeAgentRun = () => {};
    try {
      await api.reserveAgentRun(agentRunId, operation.signal);
      if (!isDocumentSessionCurrent(operation)) return;
      setThreads((current) =>
        updateMessageWithPendingReply(current, threadId, userMessage.id, userMessage.content, true, agentRunId)
      );
      closeAgentRun = subscribeToAgentRun(threadId, agentRunId, operation);
      const payload = await api.updateMessage(
        threadId,
        userMessage.id,
        { content: userMessage.content, rerunAgent: true, agentRunId },
        operation.signal
      );
      if (!isDocumentSessionCurrent(operation)) return;
      setThreads(payload.threads);
      const documentApplied = payload.document ? applyDocument(payload.document) : true;
      setActiveThreadId(threadId);
      if (documentApplied) {
        setStatus(statusForOutcome(payload.agentOutcome, "Codex 已回答", payload.assistantMessage));
      }
    } catch (error) {
      if (isDocumentSessionCurrent(operation)) await recoverThreads(error, operation);
    } finally {
      closeAgentRun();
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
      (descendantCount > 0
        ? `确定删除这个问题、对应回答以及 ${descendantCount} 个子问题吗？`
        : deletesReply
          ? "确定删除这个问题及其 Codex 回答吗？"
          : target?.role === "user"
            ? "确定删除这个问题吗？"
            : "确定删除这条 Codex 回答吗？") + " 已保存的提案、应用和执行快照将保留在成果记录中，正文不会撤回。"
    );
    if (!confirmed) return;
    const operation = captureDocumentSession();

    setStatus("正在删除消息");
    try {
      const payload = await api.deleteMessage(threadId, messageId, operation.signal);
      if (!isDocumentSessionCurrent(operation)) return;
      setThreads(payload.threads);
      if (editingMessage === messageId) cancelEdit();
      setStatus("消息已删除");
    } catch (error) {
      if (isDocumentSessionCurrent(operation)) await recoverThreads(error, operation);
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

  function clearSubmittedDraft(draftKey: string | null, submittedContent: string) {
    if (!draftKey) return;
    setMessageDrafts((current) => {
      if ((current[draftKey] || "").trim() !== submittedContent) return current;
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
  }

  async function recoverThreads(error: unknown, operation: DocumentSessionOperation) {
    setStatus(error instanceof Error ? error.message : String(error));
    try {
      const payload = await api.threads(operation.signal);
      if (isDocumentSessionCurrent(operation)) setThreads(payload.threads);
    } catch {
      // Preserve the original actionable error when recovery also fails.
    }
  }

  async function resumeAgentRuns(loadedThreads: Thread[]): Promise<Thread[]> {
    const operation = captureDocumentSession();
    const candidates = resumableAgentRuns(loadedThreads);
    if (candidates.length === 0) {
      setThreads(loadedThreads);
      return loadedThreads;
    }

    const available = await Promise.all(candidates.map(async (candidate) => {
      try {
        return { candidate, snapshot: await api.agentRun(candidate.runId, operation.signal) };
      } catch {
        return null;
      }
    }));
    if (!isDocumentSessionCurrent(operation)) return loadedThreads;

    let restored = loadedThreads;
    let terminalRun: { status: "completed" | "failed"; error: string | null } | null = null;
    for (const entry of available) {
      if (!entry) continue;
      if (entry.snapshot.status === "waiting" || entry.snapshot.status === "running") {
        restored = restorePendingAgentRun(restored, entry.candidate, entry.snapshot);
      } else {
        if (entry.snapshot.status !== "completed" || !terminalRun) {
          terminalRun = {
            status: entry.snapshot.status !== "completed" ? "failed" : "completed",
            error: entry.snapshot.error
          };
        }
      }
    }
    setThreads(restored);
    for (const entry of available) {
      if (!entry || (entry.snapshot.status !== "waiting" && entry.snapshot.status !== "running")) continue;
      subscribeToAgentRun(entry.candidate.threadId, entry.candidate.runId, operation);
    }
    if (available.some((entry) => (
      entry?.snapshot.status === "waiting" || entry?.snapshot.status === "running"
    ))) {
      setStatus("Codex 正在执行");
    }
    if (terminalRun) void refreshAfterAgentRun(operation, terminalRun.status, terminalRun.error);
    return restored;
  }

  async function refreshAfterAgentRun(
    operation: DocumentSessionOperation,
    status: "completed" | "failed",
    runError: string | null = null
  ) {
    try {
      const [threadPayload, document] = await Promise.all([
        api.threads(operation.signal),
        api.document(operation.signal)
      ]);
      if (!isDocumentSessionCurrent(operation)) return;
      setThreads(threadPayload.threads);
      const documentApplied = applyDocument(document);
      if (documentApplied) {
        setStatus(status === "failed" ? runError || "Codex 请求失败，请查看错误回答" : "Codex 已回答");
      }
    } catch (error) {
      if (isDocumentSessionCurrent(operation)) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    }
  }

  function subscribeToAgentRun(
    threadId: string,
    agentRunId: string,
    operation: DocumentSessionOperation
  ): () => void {
    try {
      return api.subscribeAgentRun(agentRunId, {
        onSnapshot: (snapshot) => {
          if (!isDocumentSessionCurrent(operation)) return;
          setThreads((current) => applyAgentRunSnapshot(current, threadId, agentRunId, snapshot));
        },
        onUpdate: (update) => {
          if (!isDocumentSessionCurrent(operation)) return;
          setThreads((current) => applyAgentRunUpdate(current, threadId, agentRunId, update));
        },
        onComplete: (snapshot) => {
          if (!isDocumentSessionCurrent(operation)) return;
          setThreads((current) => applyAgentRunSnapshot(current, threadId, agentRunId, snapshot));
          void refreshAfterAgentRun(
            operation,
            snapshot.status !== "completed" ? "failed" : "completed",
            snapshot.error
          );
        }
      }, operation.signal);
    } catch {
      // The final HTTP response still supplies the persisted answer and process metadata.
      return () => {};
    }
  }

  return {
    messageDrafts,
    referenceDrafts,
    sendErrors,
    setReferenceDraft: (key: string, references: ReferenceSnapshot[]) => {
      setReferenceDrafts((current) => ({ ...current, [key]: references }));
    },
    editingMessage,
    editText,
    setEditText,
    setMessageDraft,
    beginEdit,
    cancelEdit,
    send,
    saveEditedMessage,
    updateMessageMeta,
    retryAssistantReply,
    requestAssistantReply,
    deleteMessage,
    resumeAgentRuns
  };
}

export class ConversationSendRegistry {
  private active = new Map<string, symbol>();

  begin(key: string): symbol | null {
    if (this.active.has(key)) return null;
    const token = Symbol(key);
    this.active.set(key, token);
    return token;
  }

  finish(key: string, token: symbol): void {
    if (this.active.get(key) === token) this.active.delete(key);
  }
}

export function conversationSendKey(command: ConversationMessageCommand): string {
  const target = command.nodeId
    ? `node:${command.nodeId}`
    : `parent:${command.parentMessageId || "root"}`;
  return `${command.threadId}:${target}`;
}

export function conversationRevisionCommand(
  threadId: string,
  message: Message,
  content: string,
  agentRunId: string
): ConversationMessageCommand {
  return {
    threadId,
    content,
    draftKey: null,
    askAgent: true,
    nodeId: null,
    parentMessageId: message.parentId || null,
    agentRunId
  };
}

export function conversationRevisionKey(threadId: string, messageId: string): string {
  return `${threadId}:revision:${messageId}`;
}

export function statusForOutcome(outcome: AgentOutcome, successStatus: string, message?: Message | null): string {
  if (message?.meta?.outcomeUnknown) return "执行结果未知，请在成果记录中核对";
  if (message?.meta?.interrupted) return "执行已中断，已有变化与过程保留";
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
