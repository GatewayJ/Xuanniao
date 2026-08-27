import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ViewUpdate } from "@codemirror/view";
import { api } from "./api";
import { coalesceAgentRunUpdates, createAgentRunId } from "./agent-run";
import { DiagramViewer } from "./components/DiagramViewer";
import { DocumentPane, type Mode } from "./components/DocumentPane";
import { FilePickerModal } from "./components/FilePickerModal";
import { NewDocumentModal, type NewDocumentCommand } from "./components/NewDocumentModal";
import { SelectionAskPopover } from "./components/SelectionAskPopover";
import { SettingsModal } from "./components/SettingsModal";
import { ThreadRail } from "./components/ThreadRail";
import { TopBar } from "./components/TopBar";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { useRenderedPreview } from "./hooks/useRenderedPreview";
import { useAgentSettings } from "./hooks/useAgentSettings";
import { useConversationCommands } from "./hooks/useConversationCommands";
import { useDocumentSession } from "./hooks/useDocumentSession";
import { usePermissionInbox } from "./hooks/usePermissionInbox";
import { useThreadPaneWidth } from "./hooks/useThreadPaneWidth";
import { selectionContextForPreview } from "./preview-selection";
import { MarkdownThreadEditor, nearestThreadForLine } from "./ThreadEditor";
import { canonicalizeSelection, resolveThreadAnchor } from "./thread-anchors";
import { remapThreadsForChange } from "./thread-anchor-remap";
import { buildPreviewThreadLayout } from "./thread-spatial";
import {
  findThreadForSelection,
  insertThreadOnce,
  orderThreads,
  titleForSelection
} from "./thread-utils";
import type { AgentRunSnapshot, FileBrowserPayload, SelectionContext, Thread, ThreadSpatialLayout } from "./types";

const EXPLICIT_THREAD_ACTIVATION_HOLD_MS = 2500;
type SelectionViewportRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
type SelectionAskState = {
  selection: SelectionContext;
  anchorRect: SelectionViewportRect | null;
};
type CapturedPreviewSelection = SelectionAskState & {
  content: string;
};

const emptyFileBrowser: FileBrowserPayload = {
  directory: "",
  parent: null,
  selectedPath: null,
  entries: []
};

export function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const [status, setStatus] = useState("正在加载");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentCreating, setNewDocumentCreating] = useState(false);
  const [newDocumentError, setNewDocumentError] = useState("");
  const [newDocumentRun, setNewDocumentRun] = useState<AgentRunSnapshot | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [fileTreeRoot, setFileTreeRoot] = useState("");
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  const [openingDocumentPath, setOpeningDocumentPath] = useState<string | null>(null);
  const [fileBrowser, setFileBrowser] = useState<FileBrowserPayload>(emptyFileBrowser);
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false);
  const [fileBrowserError, setFileBrowserError] = useState("");
  const [directoryBrowser, setDirectoryBrowser] = useState<FileBrowserPayload>(emptyFileBrowser);
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false);
  const [directoryBrowserError, setDirectoryBrowserError] = useState("");
  const [diagramViewer, setDiagramViewer] = useState<{ title: string; svg: string } | null>(null);
  const [threadSpatialLayout, setThreadSpatialLayout] = useState<ThreadSpatialLayout | null>(null);
  const [selectionAsk, setSelectionAsk] = useState<SelectionAskState | null>(null);
  const [selectionQuestion, setSelectionQuestion] = useState("");
  const [selectionAskError, setSelectionAskError] = useState("");
  const [creatingSelectionThread, setCreatingSelectionThread] = useState(false);
  const selectionAskRef = useRef(selectionAsk);
  const selectionQuestionRef = useRef(selectionQuestion);
  const selectionSubmissionRef = useRef<symbol | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MarkdownThreadEditor | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const previewSelectionRef = useRef<CapturedPreviewSelection | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const explicitThreadActivationTimerRef = useRef<number | null>(null);
  const explicitlyActivatedThreadIdRef = useRef<string | null>(null);
  const openDocumentRequestRef = useRef<AbortController | null>(null);
  const newDocumentRequestRef = useRef<AbortController | null>(null);
  const newDocumentRunCloseRef = useRef<(() => void) | null>(null);
  const directoryBrowseRequestRef = useRef(0);
  const threadsRef = useRef<Thread[]>([]);
  const activeThreadIdRef = useRef<string | null>(null);
  const modeRef = useRef<Mode>("edit");
  selectionAskRef.current = selectionAsk;
  selectionQuestionRef.current = selectionQuestion;
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
  } = usePermissionInbox({ setStatus, sessionKey: documentData?.path ?? null });
  const conversation = useConversationCommands({
    threadsRef,
    setThreads,
    setActiveThreadId,
    setStatus,
    flushDocumentSave: documentSession.flushDocumentSave,
    applyDocument: documentSession.applyServerDocument,
    captureDocumentSession: documentSession.captureDocumentSession,
    isDocumentSessionCurrent: documentSession.isDocumentSessionCurrent
  });
  const agentSettings = useAgentSettings({ setStatus });

  const activeThread = threads.find((thread) => thread.id === activeThreadId) || null;
  const orderedThreads = useMemo(() => orderThreads(threads, documentData?.content), [threads, documentData?.content]);
  const shellStyle = {
    "--file-tree-width": fileTreeCollapsed ? "50px" : "clamp(180px, 18vw, 224px)",
    "--thread-width": `${threadWidth}px`
  } as CSSProperties;

  useEffect(() => {
    threadsRef.current = threads;
    activeThreadIdRef.current = activeThreadId;
  }, [threads, activeThreadId]);

  useEffect(() => {
    modeRef.current = mode;
    previewSelectionRef.current = null;
  }, [mode]);

  useEffect(() => {
    previewSelectionRef.current = null;
  }, [documentData?.path, documentData?.content]);

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
    openDocumentRequestRef.current?.abort();
    newDocumentRequestRef.current?.abort();
    newDocumentRunCloseRef.current?.();
    directoryBrowseRequestRef.current += 1;
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
      documentSession.loadDocument(doc, false, true);
      setWorkspaceRoot(filePayload.root);
      setFileTreeRoot(filePayload.root);
      setStatus("就绪");
      const loadedThreads = await conversation.resumeAgentRuns(threadPayload.threads);
      setActiveThreadId(loadedThreads[0]?.id || null);
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

  function openNewDocumentCreator() {
    setFilePickerOpen(false);
    setNewDocumentError("");
    setNewDocumentRun(null);
    directoryBrowseRequestRef.current += 1;
    setDirectoryBrowser(emptyFileBrowser);
    setDirectoryBrowserError("");
    setNewDocumentOpen(true);
  }

  async function createDocument(command: NewDocumentCommand) {
    if (newDocumentCreating) return;
    const controller = new AbortController();
    const agentRunId = createAgentRunId();
    newDocumentRequestRef.current?.abort();
    newDocumentRunCloseRef.current?.();
    newDocumentRequestRef.current = controller;
    setNewDocumentCreating(true);
    setNewDocumentError("");
    setNewDocumentRun(null);
    setStatus("正在创建文档");

    try {
      if (documentData && !await documentSession.flushDocumentSave()) return;
      const reserved = await api.reserveAgentRun(agentRunId, controller.signal);
      setNewDocumentRun(reserved);
      newDocumentRunCloseRef.current = api.subscribeAgentRun(agentRunId, {
        onSnapshot: setNewDocumentRun,
        onUpdate: (update) => setNewDocumentRun((current) => current ? {
          ...current,
          status: current.status === "waiting" ? "running" : current.status,
          events: coalesceAgentRunUpdates([...current.events, update])
        } : current),
        onComplete: setNewDocumentRun
      }, controller.signal);

      const payload = await api.createDocument(command, agentRunId, controller.signal);
      if (newDocumentRequestRef.current !== controller) return;
      documentSession.loadDocument(payload.document, true, true);
      conversation.resetConversationEditor();
      setSelectionAsk(null);
      setSelectionQuestion("");
      setFilePickerOpen(false);
      setNewDocumentOpen(false);
      setMode("edit");
      const loadedThreads = await conversation.resumeAgentRuns(payload.threads);
      if (newDocumentRequestRef.current !== controller) return;
      setActiveThreadId(loadedThreads[0]?.id || null);
      setStatus("新文档已创建");
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setNewDocumentError(message);
      setStatus(message);
    } finally {
      if (newDocumentRequestRef.current === controller) {
        newDocumentRunCloseRef.current?.();
        newDocumentRunCloseRef.current = null;
        newDocumentRequestRef.current = null;
        setNewDocumentCreating(false);
      }
    }
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

  async function browseDocumentDirectories(targetPath: string) {
    if (!targetPath.trim()) return;
    const requestId = directoryBrowseRequestRef.current + 1;
    directoryBrowseRequestRef.current = requestId;
    setDirectoryBrowserLoading(true);
    setDirectoryBrowserError("");
    try {
      const payload = await api.browseFiles(targetPath);
      if (directoryBrowseRequestRef.current === requestId) setDirectoryBrowser(payload);
    } catch (error) {
      if (directoryBrowseRequestRef.current === requestId) {
        setDirectoryBrowserError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (directoryBrowseRequestRef.current === requestId) setDirectoryBrowserLoading(false);
    }
  }

  async function openDocument(path: string) {
    openDocumentRequestRef.current?.abort();
    const controller = new AbortController();
    openDocumentRequestRef.current = controller;
    setOpeningDocumentPath(path);
    setStatus("正在打开文档");
    try {
      if (documentData) {
        if (!await documentSession.flushDocumentSave()) return;
      }
      if (openDocumentRequestRef.current !== controller) return;
      const payload = await api.openDocument(path, controller.signal);
      if (openDocumentRequestRef.current !== controller) return;
      documentSession.loadDocument(payload.document, true, true);
      conversation.resetConversationEditor();
      setSelectionAsk(null);
      setSelectionQuestion("");
      setFilePickerOpen(false);
      setFileBrowserError("");
      setStatus("文档已打开");
      const loadedThreads = await conversation.resumeAgentRuns(payload.threads);
      if (openDocumentRequestRef.current !== controller) return;
      setActiveThreadId(loadedThreads[0]?.id || null);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setFileBrowserError(message);
      setStatus(message);
    } finally {
      if (openDocumentRequestRef.current === controller) {
        openDocumentRequestRef.current = null;
        setOpeningDocumentPath(null);
      }
    }
  }

  function openDirectory(path: string) {
    setFileTreeRoot(path);
    setFilePickerOpen(false);
    setFileBrowserError("");
    setStatus("目录已打开");
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

    return selectionContextForPreview(root, selection.getRangeAt(0), content);
  }

  function capturePreviewSelection() {
    const selection = currentPreviewSelection();
    const content = documentData?.content;
    previewSelectionRef.current = selection && content
      ? { selection, anchorRect: currentSelectionRect(), content }
      : null;
  }

  async function openOrCreateThread(selection = currentSelection()) {
    const operation = documentSession.captureDocumentSession();
    if (!selection) {
      setStatus("请先选择一段文字");
      return null;
    }

    if (!await documentSession.flushDocumentSave()) return null;
    if (!documentSession.isDocumentSessionCurrent(operation)) return null;
    const content = editorRef.current?.getContent() ?? documentData?.content;
    const canonicalSelection = content ? canonicalizeSelection(content, selection) : null;
    if (!canonicalSelection) {
      const message = "选中文字已变化或无法映射到 Markdown 源文档，请重新选择";
      setSelectionAskError(message);
      setStatus(message);
      return null;
    }

    const existing = findThreadForSelection(threads, canonicalSelection, content);
    if (existing) {
      activateThread(existing);
      return existing;
    }

    const expectedRevision = documentSession.currentRevision();
    const documentPath = documentSession.currentPath();
    if (!expectedRevision || !documentPath) {
      setStatus("文档身份或版本缺失，请重新加载文档");
      return null;
    }

    const created = await api.createThread({
      documentPath,
      title: titleForSelection(canonicalSelection.selectedText),
      selectedText: canonicalSelection.selectedText,
      anchor: canonicalSelection.anchor,
      expectedRevision
    }, operation.signal);
    if (!documentSession.isDocumentSessionCurrent(operation)) return null;
    setThreads((current) => insertThreadOnce(current, created.thread));
    setActiveThreadId(created.thread.id);
    return created.thread;
  }

  function askSelection() {
    const capturedPreviewSelection = mode === "preview" &&
      previewSelectionRef.current?.content === documentData?.content
      ? previewSelectionRef.current
      : null;
    const selection = currentSelection() || capturedPreviewSelection?.selection || null;
    if (!selection) {
      setStatus("请先选择一段文字");
      return;
    }

    setSelectionAsk({
      selection,
      anchorRect: currentSelectionRect() || capturedPreviewSelection?.anchorRect || null
    });
    setSelectionQuestion("");
    setSelectionAskError("");
  }

  async function submitSelectionQuestion() {
    if (!selectionAsk || !selectionQuestion.trim() || creatingSelectionThread) return;
    const submittedSelection = selectionAsk;
    const submission = Symbol("selection-question");
    selectionSubmissionRef.current = submission;
    setCreatingSelectionThread(true);

    const finishSubmission = () => {
      if (selectionSubmissionRef.current !== submission) return;
      selectionSubmissionRef.current = null;
      setCreatingSelectionThread(false);
    };

    try {
      const thread = await openOrCreateThread(selectionAsk.selection);
      if (!thread) return;
      const question = selectionQuestion;
      await conversation.send(
        {
          threadId: thread.id,
          content: question,
          draftKey: null,
          askAgent: true
        },
        {
          onQueued: () => {
            if (
              selectionAskRef.current === submittedSelection &&
              selectionQuestionRef.current === question
            ) {
              setSelectionAsk(null);
              setSelectionQuestion("");
            }
            finishSubmission();
          }
        }
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      setSelectionAskError(message);
      setStatus(message);
    } finally {
      finishSubmission();
    }
  }

  async function deleteThread(thread: Thread) {
    const messageCount = thread.messages?.length || 0;
    const confirmed = window.confirm(`确定删除这个讨论${messageCount ? `及其中的 ${messageCount} 条消息` : ""}吗？`);
    if (!confirmed) return;
    const operation = documentSession.captureDocumentSession();

    setStatus("正在删除讨论");
    try {
      const payload = await api.deleteThread(thread.id, operation.signal);
      if (!documentSession.isDocumentSessionCurrent(operation)) return;
      const fallbackId = payload.threads[0]?.id || null;
      const nextActiveId = activeThreadId === thread.id ? fallbackId : activeThreadId;
      setThreads(payload.threads);
      setActiveThreadId(nextActiveId && payload.threads.some((item) => item.id === nextActiveId) ? nextActiveId : fallbackId);
      conversation.cancelEdit();
      setStatus("讨论已删除");
    } catch (error) {
      if (!documentSession.isDocumentSessionCurrent(operation)) return;
      setStatus(error instanceof Error ? error.message : String(error));
      try {
        const payload = await api.threads(operation.signal);
        if (documentSession.isDocumentSessionCurrent(operation)) setThreads(payload.threads);
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
        onCreateDocument={openNewDocumentCreator}
        onOpenFileManager={() => void openFileManager()}
        onOpenSettings={() => void agentSettings.openSettings()}
        onSave={() => void documentSession.saveDocument()}
      />
      <main className="workspace">
        <WorkspaceTree
          rootPath={fileTreeRoot}
          currentPath={documentData?.path || ""}
          collapsed={fileTreeCollapsed}
          openingPath={openingDocumentPath}
          onBrowse={api.browseFiles}
          onChooseDirectory={() => void openFileManager()}
          onOpenFile={(path) => void openDocument(path)}
          onToggleCollapsed={() => setFileTreeCollapsed((current) => !current)}
        />
        <DocumentPane
          mode={mode}
          documentData={documentData}
          activeThread={activeThread}
          editorHostRef={editorHostRef}
          previewRef={previewRef}
          onModeChange={setMode}
          onNavigateToLine={navigateToLine}
          onPreviewScroll={syncPreviewScroll}
          onPreviewSelectionChange={capturePreviewSelection}
        />
        <div className="splitter" role="separator" onPointerDown={startResize} />
        <ThreadRail
          documentData={documentData}
          agentSettings={agentSettings.settingsData}
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
          onRequestAssistant={conversation.requestAssistantReply}
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
        onOpenDirectory={openDirectory}
        onOpenFile={(path) => void openDocument(path)}
      />
      <NewDocumentModal
        open={newDocumentOpen}
        workspaceRoot={workspaceRoot}
        creating={newDocumentCreating}
        error={newDocumentError}
        run={newDocumentRun}
        directoryBrowser={directoryBrowser}
        directoryLoading={directoryBrowserLoading}
        directoryError={directoryBrowserError}
        permissionRequests={permissionRequests}
        resolvingPermissionIds={resolvingPermissionIds}
        onClose={() => setNewDocumentOpen(false)}
        onBrowseDirectory={(path) => void browseDocumentDirectories(path)}
        onCreate={(command) => void createDocument(command)}
        onResolvePermission={resolvePermissionRequest}
      />
      <SettingsModal
        open={agentSettings.settingsOpen}
        data={agentSettings.settingsData}
        loading={agentSettings.settingsLoading}
        saving={agentSettings.settingsSaving}
        error={agentSettings.settingsError}
        onClose={agentSettings.closeSettings}
        onSave={(model, reasoningEffort, permissionMode) => (
          void agentSettings.saveSettings(model, reasoningEffort, permissionMode)
        )}
      />
      {selectionAsk && (
        <SelectionAskPopover
          selectedText={selectionAsk.selection.selectedText}
          anchorRect={selectionAsk.anchorRect}
          question={selectionQuestion}
          error={selectionAskError}
          creating={creatingSelectionThread}
          onQuestionChange={setSelectionQuestion}
          onCancel={() => {
            setSelectionAsk(null);
            setSelectionQuestion("");
            setSelectionAskError("");
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
