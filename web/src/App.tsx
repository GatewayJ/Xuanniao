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
import { useThreadPaneWidth } from "./hooks/useThreadPaneWidth";
import { MarkdownThreadEditor, nearestThreadForLine } from "./ThreadEditor";
import { anchorContextForRange, locateTextInMarkdown, resolveThreadAnchor } from "./thread-anchors";
import { remapThreadsForChange } from "./thread-anchor-remap";
import { buildPreviewThreadLayout } from "./thread-spatial";
import {
  appendPendingMessage,
  findThreadForSelection,
  hasAssistantReplyAfter,
  insertThreadOnce,
  orderThreads,
  titleForSelection,
  updateMessageWithPendingReply
} from "./thread-utils";
import type { BranchSelection, ConversationNodeKind, DocumentPayload, FileBrowserPayload, Message, PermissionRequest, SelectionContext, Thread, ThreadSpatialLayout } from "./types";

const EXPLICIT_THREAD_ACTIVATION_HOLD_MS = 2500;

export function App() {
  const [documentData, setDocumentData] = useState<DocumentPayload | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const [status, setStatus] = useState("正在加载");
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [fileBrowser, setFileBrowser] = useState<FileBrowserPayload>({ directory: "", parent: null, selectedPath: null, entries: [] });
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false);
  const [fileBrowserError, setFileBrowserError] = useState("");
  const [diagramViewer, setDiagramViewer] = useState<{ title: string; svg: string } | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(() => new Set());
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
  const saveTimerRef = useRef<number | null>(null);
  const deletedThreadIdsRef = useRef<Set<string>>(new Set());
  const hasPendingDocumentSaveRef = useRef(false);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const explicitThreadActivationTimerRef = useRef<number | null>(null);
  const explicitlyActivatedThreadIdRef = useRef<string | null>(null);
  const threadsRef = useRef<Thread[]>([]);
  const activeThreadIdRef = useRef<string | null>(null);
  const modeRef = useRef<Mode>("edit");
  const { threadWidth, startResize } = useThreadPaneWidth();

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
    const [doc, threadPayload, filePayload] = await Promise.all([api.document(), api.threads(), api.files()]);
    setDocumentData(doc);
    setThreads(threadPayload.threads);
    setActiveThreadId(threadPayload.threads[0]?.id || null);
    setWorkspaceRoot(filePayload.root);
    setStatus("就绪");
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
        setEditingMessage(null);
        setEditText("");
      }
      for (const threadId of remapped.deletedThreadIds) deletedThreadIdsRef.current.add(threadId);
    }
    setDocumentData((current) => current ? { ...current, content } : current);
    setStatus("正在编辑");
    scheduleThreadSpatialSync();
    hasPendingDocumentSaveRef.current = true;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void saveDocument(content), 1000);
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

  async function saveDocument(content = editorRef.current?.getContent() || documentData?.content || ""): Promise<boolean> {
    saveTimerRef.current = null;
    const threadSnapshot = threadsRef.current;
    const deletedThreadIds = [...deletedThreadIdsRef.current];
    deletedThreadIdsRef.current.clear();
    hasPendingDocumentSaveRef.current = false;
    try {
      const payload = await api.saveDocument(content, threadSnapshot.map((thread) => ({
        id: thread.id,
        selectedText: thread.selectedText,
        anchor: thread.anchor
      })), deletedThreadIds);
      if (editorRef.current?.getContent() === content) {
        threadsRef.current = payload.threads;
        setThreads(payload.threads);
        setDocumentData(payload.document);
        setStatus("已保存");
      }
      return true;
    } catch (error) {
      for (const threadId of deletedThreadIds) deletedThreadIdsRef.current.add(threadId);
      hasPendingDocumentSaveRef.current = true;
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function flushDocumentSave(): Promise<boolean> {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    return hasPendingDocumentSaveRef.current ? saveDocument() : true;
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
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (documentData) {
        if (!await flushDocumentSave()) return;
      }
      const payload = await api.openDocument(path);
      setDocumentData(payload.document);
      editorRef.current?.setContent(payload.document.content);
      setThreads(payload.threads);
      setActiveThreadId(payload.threads[0]?.id || null);
      setMessageDrafts({});
      setEditingMessage(null);
      setEditText("");
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

  async function send(
    threadId: string,
    content: string,
    draftKey: string,
    askAgent: boolean,
    nodeId: string | null = null,
    parentMessageId: string | null = null,
    branchSelection: BranchSelection | null = null,
    adoptExistingChildren = false,
    insertBeforeNodeId: string | null = null
  ) {
    const thread = threadsRef.current.find((item) => item.id === threadId) || null;
    if (!thread) return;
    await sendThreadMessage(thread, content, askAgent, draftKey, nodeId, parentMessageId, branchSelection, adoptExistingChildren, insertBeforeNodeId);
  }

  async function sendThreadMessage(
    thread: Thread,
    content: string,
    askAgent: boolean,
    clearDraftKey: string | null = null,
    nodeId: string | null = null,
    parentMessageId: string | null = null,
    branchSelection: BranchSelection | null = null,
    adoptExistingChildren = false,
    insertBeforeNodeId: string | null = null
  ) {
    const trimmed = content.trim();
    if (!trimmed) {
      setStatus("请先输入内容");
      return;
    }
    if (!await flushDocumentSave()) return;
    if (clearDraftKey) {
      setMessageDrafts((current) => {
        const next = { ...current };
        delete next[clearDraftKey];
        return next;
      });
    }
    setStatus(askAgent ? "正在询问 Codex" : "正在添加评论");
    setThreads((current) => appendPendingMessage(current, thread.id, trimmed, askAgent, nodeId, parentMessageId, branchSelection, adoptExistingChildren, insertBeforeNodeId));

    try {
      const payload = await api.sendMessage(thread.id, { content: trimmed, askAgent, nodeId, parentMessageId, branchSelection, adoptExistingChildren, insertBeforeNodeId });
      setThreads(payload.threads);
      if (payload.document) {
        setDocumentData(payload.document);
        editorRef.current?.setContent(payload.document.content);
      }
      setActiveThreadId(thread.id);
      setStatus(askAgent ? "Codex 已回答" : "评论已保存");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
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
      void sendThreadMessage(thread, question, true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingSelectionThread(false);
    }
  }

  async function saveEditedMessage(threadId: string, messageId: string) {
    const content = editText.trim();
    if (!content) return;
    const rerunAgent = hasAssistantReplyAfter(threadsRef.current, threadId, messageId);
    setThreads((current) => updateMessageWithPendingReply(current, threadId, messageId, content, rerunAgent));
    setEditingMessage(null);
    setEditText("");
    setStatus(rerunAgent ? "正在更新 Codex 回答" : "评论已更新");
    try {
      const payload = await api.updateMessage(threadId, messageId, { content, rerunAgent });
      setThreads(payload.threads);
      if (payload.document) {
        setDocumentData(payload.document);
        editorRef.current?.setContent(payload.document.content);
      }
      setStatus(payload.assistantMessage ? "Codex 已回答" : "评论已更新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  async function updateMessageMeta(threadId: string, messageId: string, nodeKind: ConversationNodeKind) {
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
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  async function retryAssistantReply(threadId: string, assistantMessageId: string) {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const assistantIndex = thread?.messages.findIndex((msg) => msg.id === assistantMessageId) ?? -1;
    const userMessage = thread ? findUserMessageForAssistant(thread.messages, assistantIndex) : null;
    if (!userMessage) {
      setStatus("没有找到这条 Codex 回答对应的问题");
      return;
    }

    setStatus("正在重试 Codex");
    setThreads((current) => updateMessageWithPendingReply(current, threadId, userMessage.id, userMessage.content, true));
    try {
      const payload = await api.updateMessage(threadId, userMessage.id, { content: userMessage.content, rerunAgent: true });
      setThreads(payload.threads);
      if (payload.document) {
        setDocumentData(payload.document);
        editorRef.current?.setContent(payload.document.content);
      }
      setActiveThreadId(threadId);
      setStatus(payload.assistantMessage ? "Codex 已回答" : "重试完成");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
    }
  }

  async function resolvePermissionRequest(requestId: string, optionId: string | null) {
    setResolvingPermissionIds((current) => new Set(current).add(requestId));
    setStatus(optionId ? "正在发送权限决定" : "正在取消权限请求");
    try {
      const payload = await api.resolvePermission(requestId, optionId ? { optionId } : { cancelled: true });
      setPermissionRequests(payload.requests);
      setStatus("权限决定已发送");
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
    const descendantCount = target?.role === "user" && target.nodeId === target.id && thread
      ? countDescendantNodes(thread.messages, target.nodeId)
      : 0;
    const confirmed = window.confirm(
      descendantCount > 0
        ? `确定删除这个问题、对应回答以及 ${descendantCount} 个子问题吗？`
        : deletesReply
          ? "确定删除这个问题及其 Codex 回答吗？"
          : target?.role === "user" ? "确定删除这个问题吗？" : "确定删除这条 Codex 回答吗？"
    );
    if (!confirmed) return;

    setStatus("正在删除消息");
    try {
      const payload = await api.deleteMessage(threadId, messageId);
      setThreads(payload.threads);
      if (editingMessage === messageId) {
        setEditingMessage(null);
        setEditText("");
      }
      setStatus("消息已删除");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
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
      setEditingMessage(null);
      setEditText("");
      setStatus("讨论已删除");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      const fresh = await api.threads();
      setThreads(fresh.threads);
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
        onSave={() => void saveDocument()}
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
          editingMessage={editingMessage}
          editText={editText}
          messageDrafts={messageDrafts}
          onActivate={activateThread}
          onDelete={(thread) => void deleteThread(thread)}
          onAskSelection={askSelection}
          onEdit={(msg: Message) => {
            setEditingMessage(msg.id);
            setEditText(msg.content);
          }}
          onCancelEdit={() => setEditingMessage(null)}
          onSaveEdit={saveEditedMessage}
          onUpdateMessageMeta={(threadId, messageId, nodeKind) => void updateMessageMeta(threadId, messageId, nodeKind)}
          onRetryAssistant={retryAssistantReply}
          onDeleteMessage={deleteMessage}
          onResolvePermission={resolvePermissionRequest}
          onSpatialScroll={syncDocumentScrollFromThreadRail}
          setEditText={setEditText}
          setMessageDraft={(draftKey, value) => setMessageDrafts((current) => ({ ...current, [draftKey]: value }))}
          onSend={send}
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
