import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ViewUpdate } from "@codemirror/view";
import { api } from "./api";
import { DiagramViewer } from "./components/DiagramViewer";
import { DocumentPane, type Mode } from "./components/DocumentPane";
import { FilePickerModal } from "./components/FilePickerModal";
import { SelectionAskPopover } from "./components/SelectionAskPopover";
import { ThreadRail } from "./components/ThreadRail";
import { TopBar } from "./components/TopBar";
import { useRenderedPreview } from "./hooks/useRenderedPreview";
import { useConversationCommands } from "./hooks/useConversationCommands";
import { useDocumentSession } from "./hooks/useDocumentSession";
import { usePermissionInbox } from "./hooks/usePermissionInbox";
import { useThreadPaneWidth } from "./hooks/useThreadPaneWidth";
import { MarkdownThreadEditor, nearestThreadForLine } from "./ThreadEditor";
import { anchorContextForRange, locateTextInMarkdown, resolveThreadAnchor } from "./thread-anchors";
import { remapThreadsForChange } from "./thread-anchor-remap";
import { buildPreviewThreadLayout } from "./thread-spatial";
import {
  findThreadForSelection,
  insertThreadOnce,
  orderThreads,
  titleForSelection
} from "./thread-utils";
import type { FileBrowserPayload, SelectionContext, Thread, ThreadSpatialLayout } from "./types";

const EXPLICIT_THREAD_ACTIVATION_HOLD_MS = 2500;

export function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const [status, setStatus] = useState("正在加载");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [fileBrowser, setFileBrowser] = useState<FileBrowserPayload>({ directory: "", parent: null, selectedPath: null, entries: [] });
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false);
  const [fileBrowserError, setFileBrowserError] = useState("");
  const [diagramViewer, setDiagramViewer] = useState<{ title: string; svg: string } | null>(null);
  const [threadSpatialLayout, setThreadSpatialLayout] = useState<ThreadSpatialLayout | null>(null);
  const [selectionAsk, setSelectionAsk] = useState<{
    selection: SelectionContext;
    anchorRect: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  } | null>(null);
  const [selectionQuestion, setSelectionQuestion] = useState("");
  const [creatingSelectionThread, setCreatingSelectionThread] = useState(false);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MarkdownThreadEditor | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const explicitThreadActivationTimerRef = useRef<number | null>(null);
  const explicitlyActivatedThreadIdRef = useRef<string | null>(null);
  const threadsRef = useRef<Thread[]>([]);
  const activeThreadIdRef = useRef<string | null>(null);
  const modeRef = useRef<Mode>("edit");
  const { threadWidth, startResize } = useThreadPaneWidth();
  const documentSession = useDocumentSession({
    editorRef,
    threadsRef,
    setThreads,
    setStatus
  });
  const { documentData } = documentSession;
  const {
    permissionRequests,
    resolvingPermissionIds,
    resolvePermissionRequest
  } = usePermissionInbox({ setStatus });
  const conversation = useConversationCommands({
    threadsRef,
    setThreads,
    setActiveThreadId,
    setStatus,
    flushDocumentSave: documentSession.flushDocumentSave,
    applyDocument: documentSession.applyServerDocument
  });

  const activeThread = threads.find((thread) => thread.id === activeThreadId) || null;
  const orderedThreads = useMemo(() => orderThreads(threads, documentData?.content), [threads, documentData?.content]);
  const shellStyle = { "--thread-width": `${threadWidth}px` } as CSSProperties;

  useEffect(() => {
    threadsRef.current = threads;
    activeThreadIdRef.current = activeThreadId;
  }, [threads, activeThreadId]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => () => {
    if (scrollSyncFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollSyncFrameRef.current);
    }
    if (explicitThreadActivationTimerRef.current !== null) {
      window.clearTimeout(explicitThreadActivationTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!documentData || !editorHostRef.current || editorRef.current) return;
    editorRef.current = new MarkdownThreadEditor(editorHostRef.current, documentData.content, handleEditorChange, handleEditorScroll, activateThread);
    editorRef.current.setThreads(threads, activeThreadId);
    scheduleThreadSpatialSync();
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [documentData?.path]);

  useEffect(() => {
    editorRef.current?.setThreads(threads, activeThreadId);
    scheduleThreadSpatialSync();
  }, [threads, activeThreadId]);

  useEffect(() => {
    scheduleThreadSpatialSync();
  }, [mode, documentData?.content]);

  useRenderedPreview({
    previewRef,
    content: documentData?.content ?? null,
    threads,
    activeThreadId,
    onActivateThread: activateThreadById,
    onOpenDiagram: setDiagramViewer,
    onRendered: scheduleThreadSpatialSync
  });

  async function loadAll() {
    try {
      const [doc, threadPayload, filePayload] = await Promise.all([api.document(), api.threads(), api.files()]);
      documentSession.loadDocument(doc);
      setThreads(threadPayload.threads);
      setActiveThreadId(threadPayload.threads[0]?.id || null);
      setWorkspaceRoot(filePayload.root);
      setStatus("就绪");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function handleEditorChange(update: ViewUpdate) {
    const content = update.state.doc.toString();
    const remapped = remapThreadsForEditorChange(threadsRef.current, update);
    if (remapped.threads !== threadsRef.current) {
      threadsRef.current = remapped.threads;
      setThreads(remapped.threads);
      if (remapped.deletedThreadIds.includes(activeThreadIdRef.current || "")) {
        const fallbackId = remapped.threads[0]?.id || null;
        activeThreadIdRef.current = fallbackId;
        setActiveThreadId(fallbackId);
        conversation.cancelEdit();
      }
    }
    documentSession.recordEditorChange(content, remapped.deletedThreadIds);
    scheduleThreadSpatialSync();
  }

  function handleEditorScroll() {
    scheduleThreadSpatialSync();
  }

  function scheduleThreadSpatialSync() {
    if (scrollSyncFrameRef.current !== null) return;
    scrollSyncFrameRef.current = window.requestAnimationFrame(() => {
      scrollSyncFrameRef.current = null;
      syncThreadSpatialLayout();
    });
  }

  function syncThreadSpatialLayout() {
    const layout = readThreadSpatialLayout();
    setThreadSpatialLayout(layout);

    const explicitlyActivatedThreadId = explicitlyActivatedThreadIdRef.current;
    if (explicitlyActivatedThreadId && threadsRef.current.some((thread) => thread.id === explicitlyActivatedThreadId)) return;

    const next = nearestThreadForCurrentViewport();
    if (next && next.id !== activeThreadIdRef.current) {
      activeThreadIdRef.current = next.id;
      setActiveThreadId(next.id);
    }
  }

  function readThreadSpatialLayout(): ThreadSpatialLayout | null {
    if (modeRef.current === "edit") {
      return editorRef.current?.threadSpatialLayout(threadsRef.current) || null;
    }
    if (modeRef.current === "preview") {
      return buildPreviewThreadLayout(previewRef.current, threadsRef.current, documentData?.content || "");
    }
    return null;
  }

  function nearestThreadForCurrentViewport(): Thread | null {
    if (modeRef.current === "edit") {
      return editorRef.current?.nearestThreadForViewport(threadsRef.current) || null;
    }
    if (modeRef.current === "preview") {
      const line = previewLineAtViewport();
      return line ? nearestThreadForLine(threadsRef.current, line, documentData?.content || "") : null;
    }
    return null;
  }

  function previewLineAtViewport(): number | null {
    const root = previewRef.current;
    if (!root) return null;
    const target = root.scrollTop + root.clientHeight * 0.28;
    let line: number | null = null;
    for (const block of [...root.querySelectorAll<HTMLElement>("[data-source-line]")]) {
      if (block.offsetTop <= target) line = Number(block.dataset.sourceLine || 1);
      else break;
    }
    return line;
  }

  function syncDocumentScrollFromThreadRail(scrollTop: number) {
    if (modeRef.current === "edit") {
      editorRef.current?.setScrollTop(scrollTop);
      scheduleThreadSpatialSync();
      return;
    }
    if (modeRef.current === "preview" && previewRef.current) {
      previewRef.current.scrollTop = Math.max(0, scrollTop);
      scheduleThreadSpatialSync();
    }
  }

  async function openFileManager() {
    setFilePickerOpen(true);
    await browseFiles(documentData?.path || workspaceRoot);
  }

  async function browseFiles(targetPath: string) {
    if (!targetPath.trim()) return;
    setFileBrowserLoading(true);
    setFileBrowserError("");
    try {
      setFileBrowser(await api.browseFiles(targetPath));
    } catch (error) {
      setFileBrowserError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileBrowserLoading(false);
    }
  }

  async function openDocument(path: string) {
    setStatus("正在打开文档");
    try {
      if (documentData) {
        if (!await documentSession.flushDocumentSave()) return;
      }
      const payload = await api.openDocument(path);
      documentSession.loadDocument(payload.document, true);
      setThreads(payload.threads);
      setActiveThreadId(payload.threads[0]?.id || null);
      conversation.resetConversationEditor();
      setFilePickerOpen(false);
      setFileBrowserError("");
      setStatus("文档已打开");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileBrowserError(message);
      setStatus(message);
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

  function currentSelectionRect() {
    if (mode === "edit") {
      return editorRef.current?.getSelectionRect() || null;
    }
    if (mode !== "preview") return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
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
        blockId: null,
        ...(located ? anchorContextForRange(content, located.start, located.end) : {})
      }
    };
  }

  async function openOrCreateThread(selection = currentSelection()) {
    if (!selection) {
      setStatus("请先选择一段文字");
      return null;
    }

    const existing = findThreadForSelection(threads, selection, documentData?.content);
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

  function askSelection() {
    const selection = currentSelection();
    if (!selection) {
      setStatus("请先选择一段文字");
      return;
    }

    setSelectionAsk({ selection, anchorRect: currentSelectionRect() });
    setSelectionQuestion("");
  }

  async function submitSelectionQuestion() {
    if (!selectionAsk || !selectionQuestion.trim() || creatingSelectionThread) return;
    setCreatingSelectionThread(true);
    try {
      const thread = await openOrCreateThread(selectionAsk.selection);
      if (!thread) return;
      const question = selectionQuestion;
      setSelectionAsk(null);
      setSelectionQuestion("");
      void conversation.send({
        threadId: thread.id,
        content: question,
        draftKey: null,
        askAgent: true
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingSelectionThread(false);
    }
  }

  async function deleteThread(thread: Thread) {
    const messageCount = thread.messages?.length || 0;
    const confirmed = window.confirm(`确定删除这个讨论${messageCount ? `及其中的 ${messageCount} 条消息` : ""}吗？`);
    if (!confirmed) return;

    setStatus("正在删除讨论");
    try {
      const payload = await api.deleteThread(thread.id);
      const fallbackId = payload.threads[0]?.id || null;
      const nextActiveId = activeThreadId === thread.id ? fallbackId : activeThreadId;
      setThreads(payload.threads);
      setActiveThreadId(nextActiveId && payload.threads.some((item) => item.id === nextActiveId) ? nextActiveId : fallbackId);
      conversation.cancelEdit();
      setStatus("讨论已删除");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      try {
        setThreads((await api.threads()).threads);
      } catch {
        // Preserve the original delete error when recovery also fails.
      }
    }
  }

  function activateThread(thread: Thread) {
    holdExplicitThreadActivation(thread.id);
    activeThreadIdRef.current = thread.id;
    setActiveThreadId(thread.id);
    if (mode === "preview") {
      scrollPreviewToThread(thread.id);
      scheduleThreadSpatialSync();
      return;
    }
    editorRef.current?.focusThread(thread);
    scheduleThreadSpatialSync();
  }

  function activateThreadById(threadId: string | null) {
    if (!threadId) {
      activeThreadIdRef.current = null;
      setActiveThreadId(null);
      return;
    }
    const thread = threadsRef.current.find((item) => item.id === threadId);
    if (thread) activateThread(thread);
    else {
      activeThreadIdRef.current = threadId;
      setActiveThreadId(threadId);
    }
  }

  function holdExplicitThreadActivation(threadId: string) {
    explicitlyActivatedThreadIdRef.current = threadId;
    if (explicitThreadActivationTimerRef.current !== null) {
      window.clearTimeout(explicitThreadActivationTimerRef.current);
    }
    explicitThreadActivationTimerRef.current = window.setTimeout(() => {
      explicitThreadActivationTimerRef.current = null;
      explicitlyActivatedThreadIdRef.current = null;
      scheduleThreadSpatialSync();
    }, EXPLICIT_THREAD_ACTIVATION_HOLD_MS);
  }

  function scrollPreviewToThread(threadId: string) {
    const marker = previewRef.current?.querySelector<HTMLElement>(`[data-preview-thread-id~="${CSS.escape(threadId)}"]`);
    marker?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function navigateToLine(line: number) {
    setMode("edit");
    window.requestAnimationFrame(() => editorRef.current?.focusLine(line));
  }

  function syncPreviewScroll() {
    scheduleThreadSpatialSync();
  }

  return (
    <div className="appShell" style={shellStyle}>
      <TopBar
        documentPath={documentData?.path || "正在加载…"}
        status={status}
        onOpenFileManager={() => void openFileManager()}
        onSave={() => void documentSession.saveDocument()}
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
          documentData={documentData}
          threads={orderedThreads}
          activeThreadId={activeThreadId}
          spatialLayout={threadSpatialLayout}
          permissionRequests={permissionRequests}
          resolvingPermissionIds={resolvingPermissionIds}
          editingMessage={conversation.editingMessage}
          editText={conversation.editText}
          messageDrafts={conversation.messageDrafts}
          onActivate={activateThread}
          onDelete={(thread) => void deleteThread(thread)}
          onAskSelection={askSelection}
          onEdit={conversation.beginEdit}
          onCancelEdit={conversation.cancelEdit}
          onSaveEdit={conversation.saveEditedMessage}
          onUpdateMessageMeta={conversation.updateMessageMeta}
          onRetryAssistant={conversation.retryAssistantReply}
          onDeleteMessage={conversation.deleteMessage}
          onResolvePermission={resolvePermissionRequest}
          onSpatialScroll={syncDocumentScrollFromThreadRail}
          setEditText={conversation.setEditText}
          setMessageDraft={conversation.setMessageDraft}
          onSend={conversation.send}
        />
      </main>
      <FilePickerModal
        open={filePickerOpen}
        currentPath={documentData?.path || ""}
        browser={fileBrowser}
        loading={fileBrowserLoading}
        error={fileBrowserError}
        onClose={() => setFilePickerOpen(false)}
        onBrowse={(path) => void browseFiles(path)}
        onOpenFile={(path) => void openDocument(path)}
      />
      {selectionAsk && (
        <SelectionAskPopover
          selectedText={selectionAsk.selection.selectedText}
          anchorRect={selectionAsk.anchorRect}
          question={selectionQuestion}
          creating={creatingSelectionThread}
          onQuestionChange={setSelectionQuestion}
          onCancel={() => {
            if (creatingSelectionThread) return;
            setSelectionAsk(null);
            setSelectionQuestion("");
          }}
          onSubmit={() => void submitSelectionQuestion()}
        />
      )}
      <DiagramViewer diagram={diagramViewer} onClose={() => setDiagramViewer(null)} />
    </div>
  );
}

function remapThreadsForEditorChange(threads: Thread[], update: ViewUpdate) {
  const selection = update.startState.selection.main;
  const preservedThreadId = threads.find((thread) => (
    thread.anchor.start === selection.from && thread.anchor.end === selection.to
  ))?.id || null;
  return remapThreadsForChange(
    threads,
    update.startState.doc.toString(),
    update.state.doc.toString(),
    update.changes,
    preservedThreadId
  );
}

type SourceLines = {
  lineStart: number | null;
  lineEnd: number | null;
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
