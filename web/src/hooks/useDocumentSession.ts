import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { api } from "../api.ts";
import { executeScopedSave } from "../document-save-operation.ts";
import { DocumentSessionScope } from "../document-session-scope.ts";
import type { DocumentSessionOperation } from "../document-session-scope.ts";
import type { MarkdownThreadEditor } from "../ThreadEditor";
import type { DocumentPayload, Thread } from "../types";

type DocumentSessionOptions = {
  editorRef: { current: MarkdownThreadEditor | null };
  threadsRef: { current: Thread[] };
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  setStatus: Dispatch<SetStateAction<string>>;
  autosaveDelayMs?: number;
};

export function useDocumentSession({
  editorRef,
  threadsRef,
  setThreads,
  setStatus,
  autosaveDelayMs = 1000
}: DocumentSessionOptions) {
  const [documentData, setDocumentData] = useState<DocumentPayload | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const deletedThreadIdsRef = useRef<Set<string>>(new Set());
  const hasPendingSaveRef = useRef(false);
  const documentPathRef = useRef<string | null>(null);
  const revisionRef = useRef<string | null>(null);
  const serverContentRef = useRef("");
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const documentScopeRef = useRef(new DocumentSessionScope());

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    documentScopeRef.current.dispose();
  }, []);

  function loadDocument(document: DocumentPayload, updateEditor = false, resetSession = false) {
    if (resetSession) {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      documentScopeRef.current.advance();
      saveQueueRef.current = Promise.resolve(true);
    }
    documentPathRef.current = document.path;
    revisionRef.current = document.revision;
    serverContentRef.current = document.content;
    hasPendingSaveRef.current = false;
    deletedThreadIdsRef.current.clear();
    setDocumentData(document);
    if (updateEditor) editorRef.current?.setContent(document.content);
  }

  function recordEditorChange(content: string, deletedThreadIds: string[]) {
    for (const threadId of deletedThreadIds) deletedThreadIdsRef.current.add(threadId);
    setDocumentData((current) => current ? { ...current, content } : current);
    setStatus("正在编辑");
    hasPendingSaveRef.current = true;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void saveDocument(content), autosaveDelayMs);
  }

  async function saveDocument(
    content = editorRef.current?.getContent() || documentData?.content || ""
  ): Promise<boolean> {
    saveTimerRef.current = null;
    const threadSnapshot = threadsRef.current;
    const deletedThreadIds = [...deletedThreadIdsRef.current];
    deletedThreadIdsRef.current.clear();
    hasPendingSaveRef.current = false;
    const operation = documentScopeRef.current.capture();
    const documentPath = documentPathRef.current;
    const run = persistDocument(
      content,
      threadSnapshot,
      deletedThreadIds,
      documentPath,
      operation,
      saveQueueRef.current
    );
    saveQueueRef.current = run;
    return run;
  }

  async function flushDocumentSave(): Promise<boolean> {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    return hasPendingSaveRef.current ? saveDocument() : saveQueueRef.current;
  }

  async function persistDocument(
    content: string,
    threadSnapshot: Thread[],
    deletedThreadIds: string[],
    documentPath: string | null,
    operation: DocumentSessionOperation,
    previousSave: Promise<boolean>
  ): Promise<boolean> {
    const outcome = await executeScopedSave({
      previous: previousSave,
      operation,
      isCurrent: (candidate) => documentScopeRef.current.isCurrent(candidate),
      persist: async () => {
        const expectedRevision = revisionRef.current;
        if (!documentPath || !expectedRevision) {
          throw new Error("文档身份或版本缺失，请重新加载文档");
        }
        return api.saveDocument(
          documentPath,
          content,
          expectedRevision,
          threadSnapshot.map((thread) => ({
            id: thread.id,
            selectedText: thread.selectedText,
            orphaned: thread.orphaned,
            anchor: thread.anchor
          })),
          deletedThreadIds,
          operation.signal
        );
      }
    });
    if (outcome.status === "stale") return true;

    if (outcome.status === "saved") {
      const payload = outcome.value;
      revisionRef.current = payload.document.revision;
      serverContentRef.current = payload.document.content;
      if (editorRef.current?.getContent() === content) {
        threadsRef.current = payload.threads;
        setThreads(payload.threads);
        setDocumentData(payload.document);
        setStatus("已保存");
      }
      return true;
    }

    if (!documentScopeRef.current.isCurrent(operation)) return true;
    for (const threadId of deletedThreadIds) deletedThreadIdsRef.current.add(threadId);
    hasPendingSaveRef.current = true;
    setStatus(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
    return false;
  }

  function applyServerDocument(document: DocumentPayload): boolean {
    const localContent = editorRef.current?.getContent() ?? serverContentRef.current;
    if (hasIncomingDocumentConflict(serverContentRef.current, localContent, document.content)) {
      setStatus("Codex 已更新文档，但本地仍有未保存编辑；本地内容已保留，请复制后重新加载");
      return false;
    }
    if (localContent !== serverContentRef.current && document.content === serverContentRef.current) {
      return true;
    }
    loadDocument(document, true);
    return true;
  }

  function captureDocumentSession() {
    return documentScopeRef.current.capture();
  }

  function isDocumentSessionCurrent(operation: ReturnType<DocumentSessionScope["capture"]>) {
    return documentScopeRef.current.isCurrent(operation);
  }

  function currentRevision() {
    return revisionRef.current;
  }

  function currentPath() {
    return documentPathRef.current;
  }

  return {
    documentData,
    loadDocument,
    applyServerDocument,
    captureDocumentSession,
    isDocumentSessionCurrent,
    currentRevision,
    currentPath,
    recordEditorChange,
    saveDocument,
    flushDocumentSave
  };
}

export function hasIncomingDocumentConflict(
  serverContent: string,
  localContent: string,
  incomingContent: string
): boolean {
  return (
    localContent !== serverContent &&
    incomingContent !== serverContent &&
    incomingContent !== localContent
  );
}
