import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { api } from "../api.ts";
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
  const revisionRef = useRef<string | null>(null);
  const serverContentRef = useRef("");
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
  }, []);

  function loadDocument(document: DocumentPayload, updateEditor = false) {
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
    const run = saveQueueRef.current.then(
      () => persistDocument(content, threadSnapshot, deletedThreadIds),
      () => persistDocument(content, threadSnapshot, deletedThreadIds)
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
    deletedThreadIds: string[]
  ): Promise<boolean> {
    try {
      const expectedRevision = revisionRef.current;
      if (!expectedRevision) throw new Error("文档版本缺失，请重新加载文档");
      const payload = await api.saveDocument(
        content,
        expectedRevision,
        threadSnapshot.map((thread) => ({
          id: thread.id,
          selectedText: thread.selectedText,
          anchor: thread.anchor
        })),
        deletedThreadIds
      );
      revisionRef.current = payload.document.revision;
      serverContentRef.current = payload.document.content;
      if (editorRef.current?.getContent() === content) {
        threadsRef.current = payload.threads;
        setThreads(payload.threads);
        setDocumentData(payload.document);
        setStatus("已保存");
      }
      return true;
    } catch (error) {
      for (const threadId of deletedThreadIds) deletedThreadIdsRef.current.add(threadId);
      hasPendingSaveRef.current = true;
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    }
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

  return {
    documentData,
    loadDocument,
    applyServerDocument,
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
