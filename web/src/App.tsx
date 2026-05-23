import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ViewUpdate } from "@codemirror/view";
import { api } from "./api";
import { DiagramViewer } from "./components/DiagramViewer";
import { DocumentPane, type Mode } from "./components/DocumentPane";
import { FilePickerModal } from "./components/FilePickerModal";
import { ThreadRail } from "./components/ThreadRail";
import { TopBar } from "./components/TopBar";
import { useRenderedPreview } from "./hooks/useRenderedPreview";
import { useThreadPaneWidth } from "./hooks/useThreadPaneWidth";
import { MarkdownThreadEditor, nearestThreadForLine } from "./ThreadEditor";
import {
  appendPendingMessage,
  findThreadForSelection,
  hasAssistantReplyAfter,
  insertThreadOnce,
  orderThreads,
  titleForSelection,
  updateMessageWithPendingReply
} from "./thread-utils";
import type { DocumentPayload, MarkdownFile, Message, PermissionRequest, SelectionContext, Thread } from "./types";

export function App() {
  const [documentData, setDocumentData] = useState<DocumentPayload | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const [status, setStatus] = useState("Loading");
  const [message, setMessage] = useState("");
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [markdownFiles, setMarkdownFiles] = useState<MarkdownFile[]>([]);
  const [diagramViewer, setDiagramViewer] = useState<{ title: string; svg: string } | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(() => new Set());
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MarkdownThreadEditor | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const anchorSaveTimerRef = useRef<number | null>(null);
  const threadsRef = useRef<Thread[]>([]);
  const activeThreadIdRef = useRef<string | null>(null);
  const { threadWidth, startResize } = useThreadPaneWidth();

  const activeThread = threads.find((thread) => thread.id === activeThreadId) || null;
  const orderedThreads = useMemo(() => orderThreads(threads), [threads]);
  const shellStyle = { "--thread-width": `${threadWidth}px` } as CSSProperties;

  useEffect(() => {
    threadsRef.current = threads;
    activeThreadIdRef.current = activeThreadId;
  }, [threads, activeThreadId]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    async function pollPermissions() {
      try {
        const payload = await api.permissions();
        if (!stopped) setPermissionRequests(payload.requests);
      } catch {
        if (!stopped) setPermissionRequests([]);
      } finally {
        if (!stopped) timer = window.setTimeout(pollPermissions, 900);
      }
    }

    void pollPermissions();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!documentData || !editorHostRef.current || editorRef.current) return;
    editorRef.current = new MarkdownThreadEditor(editorHostRef.current, documentData.content, handleEditorChange, handleEditorScroll, activateThread);
    editorRef.current.setThreads(threads, activeThreadId);
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [documentData?.path]);

  useEffect(() => {
    editorRef.current?.setThreads(threads, activeThreadId);
  }, [threads, activeThreadId]);

  useRenderedPreview({
    previewRef,
    content: documentData?.content ?? null,
    threads,
    activeThreadId,
    onActivateThread: activateThreadById,
    onOpenDiagram: setDiagramViewer
  });

  async function loadAll() {
    const [doc, threadPayload, filePayload] = await Promise.all([api.document(), api.threads(), api.files()]);
    setDocumentData(doc);
    setThreads(threadPayload.threads);
    setActiveThreadId(threadPayload.threads[0]?.id || null);
    setWorkspaceRoot(filePayload.root);
    setMarkdownFiles(filePayload.files);
    setStatus("Ready");
  }

  function handleEditorChange(update: ViewUpdate) {
    const content = update.state.doc.toString();
    const remappedThreads = remapThreadsForEditorChange(threadsRef.current, update);
    if (remappedThreads !== threadsRef.current) {
      threadsRef.current = remappedThreads;
      setThreads(remappedThreads);
      scheduleThreadAnchorSave(remappedThreads);
    }
    setDocumentData((current) => current ? { ...current, content } : current);
    setStatus("Editing");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void saveDocument(content), 1000);
  }

  function handleEditorScroll() {
    const next = editorRef.current?.nearestThreadForViewport(threadsRef.current);
    if (next && next.id !== activeThreadIdRef.current) setActiveThreadId(next.id);
  }

  async function saveDocument(content = editorRef.current?.getContent() || documentData?.content || "") {
    const next = await api.saveDocument(content);
    setDocumentData(next);
    setStatus("Saved");
  }

  function scheduleThreadAnchorSave(nextThreads: Thread[]) {
    if (anchorSaveTimerRef.current) window.clearTimeout(anchorSaveTimerRef.current);
    anchorSaveTimerRef.current = window.setTimeout(() => void saveThreadAnchors(nextThreads), 1000);
  }

  async function saveThreadAnchors(nextThreads = threadsRef.current) {
    anchorSaveTimerRef.current = null;
    try {
      await api.saveThreadAnchors(nextThreads.map((thread) => ({
        id: thread.id,
        selectedText: thread.selectedText,
        anchor: thread.anchor
      })));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshFiles() {
    const filePayload = await api.files();
    setWorkspaceRoot(filePayload.root);
    setMarkdownFiles(filePayload.files);
  }

  async function openFileManager() {
    setFilePickerOpen(true);
    await refreshFiles();
  }

  async function browseMarkdownFile() {
    setStatus("Opening file picker");
    try {
      const result = await api.pickMarkdownFile(documentData?.path || workspaceRoot);
      if (!result.path) {
        setStatus("File picker canceled");
        return;
      }
      await openDocument(result.path);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openDocument(path: string) {
    setStatus("Opening document");
    try {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (anchorSaveTimerRef.current) {
        window.clearTimeout(anchorSaveTimerRef.current);
        anchorSaveTimerRef.current = null;
      }
      if (documentData) {
        await saveDocument();
      }
      const payload = await api.openDocument(path);
      setDocumentData(payload.document);
      editorRef.current?.setContent(payload.document.content);
      setThreads(payload.threads);
      setActiveThreadId(payload.threads[0]?.id || null);
      setMarkdownFiles(payload.files);
      setMessage("");
      setEditingMessage(null);
      setEditText("");
      setFilePickerOpen(false);
      setStatus("Document opened");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function currentSelection(): SelectionContext | null {
    if (mode === "preview") {
      return currentPreviewSelection();
    }
    if (mode !== "edit") {
      return null;
    }
    const selection = editorRef.current?.getSelection() || null;
    return selection?.selectedText.trim() ? selection : null;
  }

  function currentPreviewSelection(): SelectionContext | null {
    const root = previewRef.current;
    const content = documentData?.content;
    const selection = window.getSelection();
    if (!root || !content || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return null;
    }

    const selectedText = selection.toString().replace(/\s+/g, " ").trim();
    if (!selectedText) {
      return null;
    }

    const previewLines = sourceLinesForPreviewRange(root, range);
    const located = locateTextInMarkdown(content, selectedText, previewLines.lineStart);

    return {
      selectedText,
      anchor: {
        start: located?.start ?? null,
        end: located?.end ?? null,
        lineStart: located?.lineStart ?? previewLines.lineStart,
        lineEnd: located?.lineEnd ?? previewLines.lineEnd,
        blockId: null
      }
    };
  }

  async function openOrCreateThread(selection = currentSelection()) {
    if (!selection) {
      setStatus("Select text first");
      return null;
    }

    const existing = findThreadForSelection(threads, selection);
    if (existing) {
      activateThread(existing);
      return existing;
    }

    const created = await api.createThread({
      title: titleForSelection(selection.selectedText),
      selectedText: selection.selectedText,
      anchor: selection.anchor
    });
    setThreads((current) => insertThreadOnce(current, created.thread));
    setActiveThreadId(created.thread.id);
    return created.thread;
  }

  async function send(askAgent: boolean) {
    const thread = activeThread || await openOrCreateThread();
    if (!thread) return;
    await sendThreadMessage(thread, message, askAgent, true);
  }

  async function sendThreadMessage(thread: Thread, content: string, askAgent: boolean, clearComposer = false) {
    const trimmed = content.trim();
    if (!trimmed) {
      setStatus("Type a message first");
      return;
    }
    if (clearComposer) setMessage("");
    setStatus(askAgent ? "Asking Codex" : "Adding comment");
    setThreads((current) => appendPendingMessage(current, thread.id, trimmed, askAgent));

    try {
      const payload = await api.sendMessage(thread.id, { content: trimmed, askAgent });
      setThreads(payload.threads);
      if (payload.document) {
        setDocumentData(payload.document);
        editorRef.current?.setContent(payload.document.content);
      }
      setActiveThreadId(thread.id);
      setStatus(askAgent ? "Codex replied" : "Comment saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  async function askSelection() {
    const selection = currentSelection();
    if (!selection) {
      setStatus("Select text first");
      return;
    }

    const question = window.prompt("Ask Codex about the selected text:", "What should be clarified here?");
    if (!question?.trim()) return;

    const thread = await openOrCreateThread(selection);
    if (!thread) return;
    await sendThreadMessage(thread, question, true);
  }

  async function saveEditedMessage(threadId: string, messageId: string) {
    const content = editText.trim();
    if (!content) return;
    const rerunAgent = hasAssistantReplyAfter(threadsRef.current, threadId, messageId);
    setThreads((current) => updateMessageWithPendingReply(current, threadId, messageId, content, rerunAgent));
    setEditingMessage(null);
    setEditText("");
    setStatus(rerunAgent ? "Updating Codex" : "Comment updated");
    try {
      const payload = await api.updateMessage(threadId, messageId, { content, rerunAgent });
      setThreads(payload.threads);
      if (payload.document) {
        setDocumentData(payload.document);
        editorRef.current?.setContent(payload.document.content);
      }
      setStatus(payload.assistantMessage ? "Codex replied" : "Comment updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  async function retryAssistantReply(threadId: string, assistantMessageId: string) {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const assistantIndex = thread?.messages.findIndex((msg) => msg.id === assistantMessageId) ?? -1;
    const userMessage = thread ? findUserMessageBefore(thread.messages, assistantIndex) : null;
    if (!userMessage) {
      setStatus("No user message found for this Codex reply");
      return;
    }

    setStatus("Retrying Codex");
    setThreads((current) => updateMessageWithPendingReply(current, threadId, userMessage.id, userMessage.content, true));
    try {
      const payload = await api.updateMessage(threadId, userMessage.id, { content: userMessage.content, rerunAgent: true });
      setThreads(payload.threads);
      if (payload.document) {
        setDocumentData(payload.document);
        editorRef.current?.setContent(payload.document.content);
      }
      setActiveThreadId(threadId);
      setStatus(payload.assistantMessage ? "Codex replied" : "Retry completed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  async function resolvePermissionRequest(requestId: string, optionId: string | null) {
    setResolvingPermissionIds((current) => new Set(current).add(requestId));
    setStatus(optionId ? "Sending permission decision" : "Cancelling permission request");
    try {
      const payload = await api.resolvePermission(requestId, optionId ? { optionId } : { cancelled: true });
      setPermissionRequests(payload.requests);
      setStatus("Permission decision sent");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      try {
        const payload = await api.permissions();
        setPermissionRequests(payload.requests);
      } catch {
        setPermissionRequests([]);
      }
    } finally {
      setResolvingPermissionIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  async function deleteMessage(threadId: string, messageId: string) {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const target = thread?.messages.find((msg) => msg.id === messageId);
    const deletesReply = target?.role === "user" && hasAssistantReplyAfter(threadsRef.current, threadId, messageId);
    const confirmed = window.confirm(
      deletesReply ? "Delete this comment and its Codex reply?" : target?.role === "user" ? "Delete this comment?" : "Delete this Codex reply?"
    );
    if (!confirmed) return;

    setStatus("Deleting message");
    try {
      const payload = await api.deleteMessage(threadId, messageId);
      setThreads(payload.threads);
      if (editingMessage === messageId) {
        setEditingMessage(null);
        setEditText("");
      }
      setStatus("Message deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  async function deleteThread(thread: Thread) {
    const messageCount = thread.messages?.length || 0;
    const confirmed = window.confirm(`Delete this thread${messageCount ? ` and ${messageCount} message${messageCount === 1 ? "" : "s"}` : ""}?`);
    if (!confirmed) return;

    setStatus("Deleting thread");
    try {
      const payload = await api.deleteThread(thread.id);
      const fallbackId = payload.threads[0]?.id || null;
      const nextActiveId = activeThreadId === thread.id ? fallbackId : activeThreadId;
      setThreads(payload.threads);
      setActiveThreadId(nextActiveId && payload.threads.some((item) => item.id === nextActiveId) ? nextActiveId : fallbackId);
      setEditingMessage(null);
      setEditText("");
      setStatus("Thread deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  function activateThread(thread: Thread) {
    setActiveThreadId(thread.id);
    if (mode === "preview") {
      scrollPreviewToThread(thread.id);
      return;
    }
    editorRef.current?.focusThread(thread);
  }

  function activateThreadById(threadId: string | null) {
    if (!threadId) {
      setActiveThreadId(null);
      return;
    }
    const thread = threadsRef.current.find((item) => item.id === threadId);
    if (thread) activateThread(thread);
    else setActiveThreadId(threadId);
  }

  function scrollPreviewToThread(threadId: string) {
    const marker = previewRef.current?.querySelector<HTMLElement>(`[data-preview-thread-id="${CSS.escape(threadId)}"]`);
    marker?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function navigateToLine(line: number) {
    setMode("edit");
    window.requestAnimationFrame(() => editorRef.current?.focusLine(line));
  }

  function syncPreviewScroll() {
    const root = previewRef.current;
    if (!root) return;
    const target = root.scrollTop + root.clientHeight * 0.28;
    let line = 1;
    for (const block of [...root.querySelectorAll<HTMLElement>("[data-source-line]")]) {
      if (block.offsetTop <= target) line = Number(block.dataset.sourceLine || 1);
      else break;
    }
    const next = nearestThreadForLine(threads, line);
    if (next && next.id !== activeThreadId) setActiveThreadId(next.id);
  }

  return (
    <div className="appShell" style={shellStyle}>
      <TopBar
        documentPath={documentData?.path || "Loading..."}
        status={status}
        onOpenFileManager={() => void openFileManager()}
        onSave={() => void saveDocument()}
        onAskSelection={() => void askSelection()}
      />
      <main className="workspace">
        <DocumentPane
          mode={mode}
          documentData={documentData}
          activeThread={activeThread}
          editorHostRef={editorHostRef}
          previewRef={previewRef}
          onModeChange={setMode}
          onNavigateToLine={navigateToLine}
          onPreviewScroll={syncPreviewScroll}
        />
        <div className="splitter" role="separator" onPointerDown={startResize} />
        <ThreadRail
          threads={orderedThreads}
          activeThreadId={activeThreadId}
          permissionRequests={permissionRequests}
          resolvingPermissionIds={resolvingPermissionIds}
          editingMessage={editingMessage}
          editText={editText}
          message={message}
          onActivate={activateThread}
          onDelete={(thread) => void deleteThread(thread)}
          onNewThread={() => void openOrCreateThread()}
          onEdit={(msg: Message) => {
            setEditingMessage(msg.id);
            setEditText(msg.content);
          }}
          onCancelEdit={() => setEditingMessage(null)}
          onSaveEdit={saveEditedMessage}
          onRetryAssistant={retryAssistantReply}
          onDeleteMessage={deleteMessage}
          onResolvePermission={resolvePermissionRequest}
          setEditText={setEditText}
          setMessage={setMessage}
          onSend={send}
        />
      </main>
      <FilePickerModal
        open={filePickerOpen}
        root={workspaceRoot}
        currentPath={documentData?.path || ""}
        files={markdownFiles}
        onClose={() => setFilePickerOpen(false)}
        onRefresh={() => void refreshFiles()}
        onBrowse={() => void browseMarkdownFile()}
        onOpenFile={(path) => void openDocument(path)}
      />
      <DiagramViewer diagram={diagramViewer} onClose={() => setDiagramViewer(null)} />
    </div>
  );
}

function findUserMessageBefore(messages: Message[], assistantIndex: number): Message | null {
  if (assistantIndex <= 0 || messages[assistantIndex]?.role !== "assistant") return null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index];
  }
  return null;
}

function remapThreadsForEditorChange(threads: Thread[], update: ViewUpdate): Thread[] {
  let changed = false;
  const nextThreads = threads.map((thread) => {
    const start = thread.anchor.start;
    const end = thread.anchor.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start === null || end === null) {
      return thread;
    }

    const mappedStart = clampPosition(update.changes.mapPos(start, 1), update.state.doc.length);
    const mappedEnd = clampPosition(update.changes.mapPos(end, -1), update.state.doc.length);
    const nextStart = Math.min(mappedStart, mappedEnd);
    const nextEnd = Math.max(mappedStart, mappedEnd);
    const lineStart = update.state.doc.lineAt(nextStart).number;
    const lineEnd = update.state.doc.lineAt(nextEnd).number;
    const selectedText = nextEnd > nextStart ? update.state.doc.sliceString(nextStart, nextEnd) : thread.selectedText;

    if (
      nextStart === start &&
      nextEnd === end &&
      lineStart === thread.anchor.lineStart &&
      lineEnd === thread.anchor.lineEnd &&
      selectedText === thread.selectedText
    ) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      selectedText,
      anchor: {
        ...thread.anchor,
        start: nextStart,
        end: nextEnd,
        lineStart,
        lineEnd
      }
    };
  });

  return changed ? nextThreads : threads;
}

function clampPosition(position: number, documentLength: number): number {
  return Math.max(0, Math.min(position, documentLength));
}

type SourceLines = {
  lineStart: number | null;
  lineEnd: number | null;
};

type MarkdownTextLocation = {
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
};

function sourceLinesForPreviewRange(root: HTMLElement, range: Range): SourceLines {
  const lines = [...root.querySelectorAll<HTMLElement>("[data-source-line]")]
    .filter((block) => range.intersectsNode(block))
    .map((block) => Number(block.dataset.sourceLine))
    .filter((line) => Number.isInteger(line));

  if (lines.length === 0) {
    const start = sourceLineForNode(range.startContainer);
    const end = sourceLineForNode(range.endContainer);
    return {
      lineStart: start,
      lineEnd: end ?? start
    };
  }

  return {
    lineStart: Math.min(...lines),
    lineEnd: Math.max(...lines)
  };
}

function sourceLineForNode(node: Node): number | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const sourceBlock = element?.closest<HTMLElement>("[data-source-line]");
  const line = Number(sourceBlock?.dataset.sourceLine);
  return Number.isInteger(line) ? line : null;
}

function locateTextInMarkdown(content: string, selectedText: string, lineHint: number | null): MarkdownTextLocation | null {
  const needle = normalizeSearchText(selectedText);
  if (!needle) return null;

  const haystack = normalizeWithOffsets(content);
  const matches: Array<{ start: number; end: number }> = [];
  let index = haystack.text.indexOf(needle);
  while (index >= 0) {
    const start = haystack.offsets[index];
    const end = haystack.offsets[index + needle.length - 1] + 1;
    matches.push({ start, end });
    index = haystack.text.indexOf(needle, index + 1);
  }

  if (matches.length === 0) {
    return null;
  }

  const best = lineHint === null
    ? matches[0]
    : matches.sort((left, right) => (
      Math.abs(lineNumberAt(content, left.start) - lineHint) - Math.abs(lineNumberAt(content, right.start) - lineHint)
    ))[0];

  return {
    ...best,
    lineStart: lineNumberAt(content, best.start),
    lineEnd: lineNumberAt(content, best.end)
  };
}

function normalizeWithOffsets(value: string): { text: string; offsets: number[] } {
  const text: string[] = [];
  const offsets: number[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      if (!previousWasSpace && text.length > 0) {
        text.push(" ");
        offsets.push(index);
        previousWasSpace = true;
      }
      continue;
    }
    text.push(character);
    offsets.push(index);
    previousWasSpace = false;
  }

  if (text[text.length - 1] === " ") {
    text.pop();
    offsets.pop();
  }

  return { text: text.join(""), offsets };
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}
