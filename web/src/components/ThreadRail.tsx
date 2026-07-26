import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent
} from "react";
import { createPortal } from "react-dom";
import { renderMessageMarkdown } from "../markdown";
import {
  THREAD_CANVAS_NODE_HEIGHT,
  THREAD_CANVAS_NODE_WIDTH,
  layoutConversationTree
} from "../thread-canvas";
import { threadNodeDraftKey } from "../thread-drafts";
import { buildConversationTree, conversationBreadcrumb, conversationNavigation, flattenConversationTree } from "../thread-tree";
import type { BranchSelection, Message, PermissionOption, PermissionRequest, Thread, ThreadSpatialLayout } from "../types";

const THREAD_FOCUS_NODE_WIDTH = 760;
const THREAD_FOCUS_NODE_HEIGHT = 560;

type ThreadRailProps = {
  threads: Thread[];
  activeThreadId: string | null;
  spatialLayout: ThreadSpatialLayout | null;
  permissionRequests: PermissionRequest[];
  resolvingPermissionIds: Set<string>;
  editingMessage: string | null;
  editText: string;
  messageDrafts: Record<string, string>;
  onActivate: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
  onAskSelection: () => void;
  onEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (threadId: string, messageId: string) => void;
  onRetryAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
  onSpatialScroll: (scrollTop: number) => void;
  setEditText: (value: string) => void;
  setMessageDraft: (draftKey: string, value: string) => void;
  onSend: (threadId: string, content: string, draftKey: string, askAgent: boolean, nodeId: string | null, parentMessageId: string | null, branchSelection?: BranchSelection | null, adoptExistingChildren?: boolean, insertBeforeNodeId?: string | null) => void;
};

export function ThreadRail(props: ThreadRailProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const applyingScrollRef = useRef(false);
  const applyingScrollFrameRef = useRef<number | null>(null);
  const scrollPositionRef = useRef(0);
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [railViewportHeight, setRailViewportHeight] = useState(0);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (openThreadId && !props.threads.some((thread) => thread.id === openThreadId)) {
      setOpenThreadId(null);
    }
  }, [openThreadId, props.threads]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !props.spatialLayout) return;
    scrollPositionRef.current = props.spatialLayout.scrollTop;
    if (Math.abs(list.scrollTop - props.spatialLayout.scrollTop) < 1) return;

    applyRailScrollTop(props.spatialLayout.scrollTop);
  }, [props.spatialLayout?.scrollTop]);

  useEffect(() => () => {
    if (applyingScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(applyingScrollFrameRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const updateViewportHeight = () => setRailViewportHeight(list.clientHeight);
    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const nextHeights: Record<string, number> = {};
    for (const [threadId, element] of cardRefs.current) {
      nextHeights[threadId] = Math.ceil(element.getBoundingClientRect().height);
    }
    setCardHeights((current) => shallowEqualNumberRecord(current, nextHeights) ? current : nextHeights);
  }, [props.threads, props.permissionRequests]);

  const threadItems = useMemo(() => {
    return props.threads
      .map((thread, index) => ({
        thread,
        targetTop: threadTargetTop(thread, index, props.spatialLayout),
        sortLine: thread.anchor.lineStart ?? Number.MAX_SAFE_INTEGER
      }))
      .sort((left, right) => left.targetTop - right.targetTop || left.sortLine - right.sortLine);
  }, [props.threads, props.spatialLayout]);

  const placedThreads = useMemo(() => {
    return placeThreadCards(threadItems, cardHeights);
  }, [threadItems, cardHeights]);

  const threadNavigation = useMemo(() => {
    const navigation: Record<string, { previous: Thread | null; next: Thread | null }> = {};
    props.threads.forEach((thread, index) => {
      navigation[thread.id] = {
        previous: props.threads[index - 1] || null,
        next: props.threads[index + 1] || null
      };
    });
    return navigation;
  }, [props.threads]);

  const spatialHeight = Math.max(
    alignedSpatialHeight(props.spatialLayout, railViewportHeight),
    ...placedThreads.map((item) => item.top + (cardHeights[item.thread.id] || estimatedThreadHeight()) + 16),
    1
  );

  function activateThread(thread: Thread) {
    props.onActivate(thread);
  }

  function openThread(thread: Thread) {
    props.onActivate(thread);
    setOpenThreadId(thread.id);
  }

  function handleListScroll() {
    if (applyingScrollRef.current) return;
    const list = listRef.current;
    if (!list || !props.spatialLayout) return;
    scrollPositionRef.current = list.scrollTop;
    props.onSpatialScroll(list.scrollTop);
  }

  function handleListWheel(event: WheelEvent<HTMLDivElement>) {
    const list = listRef.current;
    if (!list || !props.spatialLayout) return;

    const deltaY = normalizeWheelDeltaY(event, list.clientHeight);
    if (deltaY === 0 || canNestedTargetScroll(event, list, deltaY)) return;

    const maxScrollTop = maxSpatialScrollTop(props.spatialLayout);
    const nextScrollTop = clampScrollTop(scrollPositionRef.current + deltaY, maxScrollTop);

    event.preventDefault();
    if (Math.abs(nextScrollTop - scrollPositionRef.current) < 0.5) return;

    scrollPositionRef.current = nextScrollTop;
    applyRailScrollTop(nextScrollTop);
    props.onSpatialScroll(nextScrollTop);
  }

  function applyRailScrollTop(scrollTop: number) {
    const list = listRef.current;
    if (!list) return;
    applyingScrollRef.current = true;
    list.scrollTop = scrollTop;
    if (applyingScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(applyingScrollFrameRef.current);
    }
    applyingScrollFrameRef.current = window.requestAnimationFrame(() => {
      applyingScrollRef.current = false;
      applyingScrollFrameRef.current = null;
    });
  }

  function setCardRef(threadId: string, element: HTMLElement | null) {
    if (element) cardRefs.current.set(threadId, element);
    else cardRefs.current.delete(threadId);
  }

  const openThreadDetail = openThreadId
    ? props.threads.find((thread) => thread.id === openThreadId) || null
    : null;

  return (
    <>
      <aside className="threadPane">
        <div className="threadPaneHeader">
          <div>
            <h2>Comments</h2>
            <p>{props.threads.length} anchored thread{props.threads.length === 1 ? "" : "s"}</p>
          </div>
          <button type="button" className="primaryButton" onClick={props.onAskSelection}>Ask Selection</button>
        </div>
        <div className="threadList threadListSpatial" ref={listRef} onScroll={handleListScroll} onWheel={handleListWheel}>
          {props.threads.length === 0 && <div className="emptyState">No comments yet.</div>}
          {props.threads.length > 0 && (
            <div className="threadSpatialCanvas" style={{ height: spatialHeight }}>
        {placedThreads.map(({ thread, top }) => {
          const isActive = thread.id === props.activeThreadId;
          const previousThread = threadNavigation[thread.id]?.previous || null;
          const nextThread = threadNavigation[thread.id]?.next || null;
          const threadPermissionRequests = props.permissionRequests.filter((request) => (
            request.threadId === thread.id || (!request.threadId && thread.id === props.activeThreadId)
          ));
          return (
            <article
              key={thread.id}
              ref={(element) => setCardRef(thread.id, element)}
              data-thread-id={thread.id}
              className={`threadCard collapsed ${isActive ? "active" : ""}`}
              style={{ top }}
            >
              <div className="threadAccent" aria-hidden="true" />
              <div className="threadCardBody">
                <div className="threadCardHeader">
                  <div
                    className="threadCardButton"
                    role="button"
                    tabIndex={0}
                    aria-haspopup="dialog"
                    title="Open thread details"
                    onClick={() => openThread(thread)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openThread(thread);
                      }
                    }}
                  >
                    <div className="threadAnchorHeader">
                      <span className="threadCount">{(thread.messages || []).length} msg</span>
                      {threadPermissionRequests.length > 0 && <span className="permissionBadge">Permission</span>}
                    </div>
                    <div className="threadAnchorText">{thread.selectedText || thread.title || "Untitled thread"}</div>
                  </div>
                  <div className="threadCardActions">
                    <span className="threadNavControls" aria-label="Thread navigation">
                      <button
                        type="button"
                        className="threadNavButton"
                        aria-label="Previous thread"
                        title="Previous thread"
                        disabled={!previousThread}
                        onClick={() => {
                          if (previousThread) activateThread(previousThread);
                        }}
                        onKeyDown={(event) => {
                          if (previousThread && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            activateThread(previousThread);
                          }
                        }}
                      >
                        <span className="threadNavIcon up" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="threadNavButton"
                        aria-label="Next thread"
                        title="Next thread"
                        disabled={!nextThread}
                        onClick={() => {
                          if (nextThread) activateThread(nextThread);
                        }}
                        onKeyDown={(event) => {
                          if (nextThread && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            activateThread(nextThread);
                          }
                        }}
                      >
                        <span className="threadNavIcon down" aria-hidden="true" />
                      </button>
                    </span>
                    <button
                      type="button"
                      className="threadDeleteButton"
                      aria-label="Delete thread"
                      title="Delete thread"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onDelete(thread);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
            </div>
          )}
        </div>
      </aside>
      {openThreadDetail && createPortal(
        <ThreadDetailModal
          thread={openThreadDetail}
          permissionRequests={props.permissionRequests.filter((request) => (
            request.threadId === openThreadDetail.id || (!request.threadId && openThreadDetail.id === props.activeThreadId)
          ))}
          resolvingPermissionIds={props.resolvingPermissionIds}
          editingMessage={props.editingMessage}
          editText={props.editText}
          messageDrafts={props.messageDrafts}
          onClose={() => setOpenThreadId(null)}
          onEdit={props.onEdit}
          onCancelEdit={props.onCancelEdit}
          onSaveEdit={props.onSaveEdit}
          onRetryAssistant={props.onRetryAssistant}
          onDeleteMessage={props.onDeleteMessage}
          onResolvePermission={props.onResolvePermission}
          setEditText={props.setEditText}
          setMessageDraft={props.setMessageDraft}
          onSend={(content, draftKey, nodeId, parentMessageId, branchSelection, adoptExistingChildren, insertBeforeNodeId) => props.onSend(openThreadDetail.id, content, draftKey, true, nodeId, parentMessageId, branchSelection, adoptExistingChildren, insertBeforeNodeId)}
        />,
        document.body
      )}
    </>
  );
}

function ThreadDetailModal(props: {
  thread: Thread;
  permissionRequests: PermissionRequest[];
  resolvingPermissionIds: Set<string>;
  editingMessage: string | null;
  editText: string;
  messageDrafts: Record<string, string>;
  onClose: () => void;
  onEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (threadId: string, messageId: string) => void;
  onRetryAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
  setEditText: (value: string) => void;
  setMessageDraft: (draftKey: string, value: string) => void;
  onSend: (content: string, draftKey: string, nodeId: string | null, parentMessageId: string | null, branchSelection?: BranchSelection | null, adoptExistingChildren?: boolean, insertBeforeNodeId?: string | null) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionComposerRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const messageSelectionSurfaceRef = useRef<HTMLDivElement | null>(null);
  const selectingMessageRef = useRef<HTMLElement | null>(null);
  const lastValidSelectionRangeRef = useRef<Range | null>(null);
  const selectionActiveRef = useRef(false);
  const inspectorOpenRef = useRef(false);
  const selectionPopoverOpenRef = useRef(false);
  const nodeNavigationRef = useRef<ReturnType<typeof conversationNavigation>>({ left: null, right: null, up: null, down: null });
  const panStartRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const tree = useMemo(() => buildConversationTree(props.thread.messages), [props.thread.messages]);
  const nodes = useMemo(() => flattenConversationTree(tree), [tree]);
  const canvasLayout = useMemo(() => layoutConversationTree(tree), [tree]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [insertBeforeNodeId, setInsertBeforeNodeId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectionPopover, setSelectionPopover] = useState<(BranchSelection & {
    left: number;
    top: number;
    highlightRects: Array<{ left: number; top: number; width: number; height: number }>;
    prompt: string;
    insertBeforeNodeId: string | null;
  }) | null>(null);
  const [minimapCollapsed, setMinimapCollapsed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [canvasTransform, setCanvasTransform] = useState({ x: 0, y: 0, scale: 1 });
  const canvasTransformRef = useRef(canvasTransform);
  inspectorOpenRef.current = inspectorOpen;
  selectionPopoverOpenRef.current = Boolean(selectionPopover);
  canvasTransformRef.current = canvasTransform;
  const knownNodeIdsRef = useRef(new Set(nodes.map((node) => node.id)));
  const centeredThreadRef = useRef<string | null>(null);
  const overviewTransformRef = useRef<{ x: number; y: number; scale: number } | null>(null);

  useEffect(() => {
    const knownIds = knownNodeIdsRef.current;
    const addedNodes = nodes.filter((node) => !knownIds.has(node.id));
    knownNodeIdsRef.current = new Set(nodes.map((node) => node.id));
    if (addedNodes.length > 0) {
      setSelectedNodeId(addedNodes.at(-1)?.id || null);
      setInsertBeforeNodeId(null);
      setSelectionPopover(null);
      setInspectorOpen(true);
      return;
    }
    setSelectedNodeId((current) => current && nodes.some((node) => node.id === current) ? current : null);
  }, [nodes]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateSize = () => setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canvasSize.width || !canvasSize.height) return;
    const isNewThread = centeredThreadRef.current !== props.thread.id;
    centeredThreadRef.current = props.thread.id;
    setCanvasTransform((current) => ({
      x: canvasSize.width / 2,
      y: canvasSize.height / 2,
      scale: isNewThread ? 1 : current.scale
    }));
  }, [canvasSize, props.thread.id]);

  useEffect(() => {
    if (props.permissionRequests.length === 0 || inspectorOpen) return;
    setSelectedNodeId((current) => current || nodes.at(-1)?.id || null);
    setInspectorOpen(true);
  }, [inspectorOpen, nodes, props.permissionRequests.length]);

  useEffect(() => {
    if (!inspectorOpen || !canvasSize.width || !canvasSize.height) return;
    const selectedLayout = selectedNodeId
      ? canvasLayout.nodes.find((item) => item.node.id === selectedNodeId)
      : null;
    const focusX = selectedLayout?.x || 0;
    const focusY = selectedLayout?.y || 0;
    const scale = clamp(Math.min(
      (canvasSize.width - 56) / THREAD_FOCUS_NODE_WIDTH,
      (canvasSize.height - 48) / THREAD_FOCUS_NODE_HEIGHT,
      1
    ), 0.62, 1);
    setCanvasTransform({
      x: canvasSize.width / 2 - focusX * scale,
      y: canvasSize.height / 2 - focusY * scale,
      scale
    });
  }, [canvasLayout.nodes, canvasSize, inspectorOpen, selectedNodeId]);

  useEffect(() => {
    function keepSelectionInsideMessage(event: MouseEvent) {
      if (!selectionActiveRef.current || !(event.buttons & 1)) return;
      const selection = window.getSelection();
      const messageContent = selectingMessageRef.current;
      if (!selection || selection.rangeCount === 0 || !messageContent) return;

      if (!selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        const startContent = selectionElement(range.startContainer)?.closest(".messageContent");
        const endContent = selectionElement(range.endContainer)?.closest(".messageContent");
        if (startContent === messageContent && endContent === messageContent) {
          lastValidSelectionRangeRef.current = range.cloneRange();
        }
      }

      const rect = messageContent.getBoundingClientRect();
      const insideMessage = event.clientX >= rect.left
        && event.clientX <= rect.right
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom;
      if (insideMessage) return;

      event.preventDefault();
      const lastValidRange = lastValidSelectionRangeRef.current;
      if (lastValidRange) {
        selection.removeAllRanges();
        selection.addRange(lastValidRange);
      }
    }

    function finishMessageSelection() {
      if (!selectionActiveRef.current) return;
      selectionActiveRef.current = false;
      captureMessageSelection();
      selectingMessageRef.current = null;
      lastValidSelectionRangeRef.current = null;
    }

    window.addEventListener("mousemove", keepSelectionInsideMessage, { passive: false });
    window.addEventListener("mouseup", finishMessageSelection);
    window.addEventListener("blur", finishMessageSelection);
    return () => {
      window.removeEventListener("mousemove", keepSelectionInsideMessage);
      window.removeEventListener("mouseup", finishMessageSelection);
      window.removeEventListener("blur", finishMessageSelection);
    };
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (selectionPopoverOpenRef.current) {
          setSelectionPopover(null);
          window.getSelection()?.removeAllRanges();
          return;
        }
        if (inspectorOpenRef.current) {
          closeFocusedNode();
          return;
        }
        props.onClose();
        return;
      }
      if (
        !inspectorOpenRef.current
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
        || keyboardTargetAcceptsArrows(event.target)
      ) return;

      const direction = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down"
      }[event.key] as keyof ReturnType<typeof conversationNavigation> | undefined;
      const targetNode = direction ? nodeNavigationRef.current[direction] : null;
      if (!targetNode) return;
      event.preventDefault();
      navigateToNode(targetNode.id);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [props.thread.id]);

  const messageCount = props.thread.messages.length;
  const nodeCount = nodes.length;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) || null;
  const selectedNodeNavigation = useMemo(
    () => selectedNodeId ? conversationNavigation(tree, selectedNodeId) : { left: null, right: null, up: null, down: null },
    [selectedNodeId, tree]
  );
  const selectedNodeBreadcrumb = useMemo(
    () => selectedNodeId ? conversationBreadcrumb(tree, selectedNodeId) : [],
    [selectedNodeId, tree]
  );
  nodeNavigationRef.current = selectedNodeNavigation;
  const draftKey = threadNodeDraftKey(props.thread.id, selectedNodeId);
  const messageDraft = props.messageDrafts[draftKey] || "";
  const selectedNodeOrigin = selectedNode ? messageBranchSelection(selectedNode.question) : null;
  const selectedInsertTarget = selectedNode?.children.find((node) => node.id === insertBeforeNodeId) || null;
  const lineStart = props.thread.anchor.lineStart;
  const lineEnd = props.thread.anchor.lineEnd;
  const lineLabel = lineStart
    ? `第 ${lineStart}${lineEnd && lineEnd !== lineStart ? `–${lineEnd}` : ""} 行`
    : "未锚定";

  function openNode(nodeId: string, startComposer = false) {
    if (!inspectorOpenRef.current) overviewTransformRef.current = canvasTransform;
    setSelectedNodeId(nodeId);
    setInsertBeforeNodeId(null);
    setSelectionPopover(null);
    setInspectorOpen(true);
    window.getSelection()?.removeAllRanges();
    if (startComposer) window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openInsertBetween(parentNodeId: string, childNodeId: string) {
    if (!inspectorOpenRef.current) overviewTransformRef.current = canvasTransform;
    setSelectedNodeId(parentNodeId);
    setInsertBeforeNodeId(childNodeId);
    setSelectionPopover(null);
    setInspectorOpen(true);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function navigateToNode(nodeId: string | null | undefined) {
    if (!nodeId) return;
    setSelectedNodeId(nodeId);
    setInsertBeforeNodeId(null);
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => {
      if (messageSelectionSurfaceRef.current) messageSelectionSurfaceRef.current.scrollTop = 0;
    });
  }

  function navigateInDirection(direction: keyof typeof selectedNodeNavigation) {
    navigateToNode(selectedNodeNavigation[direction]?.id);
  }

  function closeFocusedNode() {
    setInspectorOpen(false);
    setSelectedNodeId(null);
    setInsertBeforeNodeId(null);
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
    if (overviewTransformRef.current) {
      setCanvasTransform(overviewTransformRef.current);
      overviewTransformRef.current = null;
    }
  }

  function openRootComposer() {
    if (!inspectorOpenRef.current) overviewTransformRef.current = canvasTransform;
    setSelectedNodeId(null);
    setInsertBeforeNodeId(null);
    setSelectionPopover(null);
    setInspectorOpen(true);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function resetView() {
    setCanvasTransform({ x: canvasSize.width / 2, y: canvasSize.height / 2, scale: 1 });
  }

  function fitTree() {
    if (canvasLayout.nodes.length === 0) {
      resetView();
      return;
    }
    const width = Math.max(1, canvasLayout.bounds.right - canvasLayout.bounds.left);
    const height = Math.max(1, canvasLayout.bounds.bottom - canvasLayout.bounds.top);
    const scale = clamp(Math.min((canvasSize.width - 120) / width, (canvasSize.height - 140) / height, 1.15), 0.35, 1.15);
    const centerX = (canvasLayout.bounds.left + canvasLayout.bounds.right) / 2;
    const centerY = (canvasLayout.bounds.top + canvasLayout.bounds.bottom) / 2;
    setCanvasTransform({
      x: canvasSize.width / 2 - centerX * scale,
      y: canvasSize.height / 2 - centerY * scale,
      scale
    });
  }

  function zoomCanvasAt(multiplier: number, centerX = canvasSize.width / 2, centerY = canvasSize.height / 2) {
    setCanvasTransform((current) => {
      const nextScale = clamp(current.scale * multiplier, 0.35, 1.8);
      const worldX = (centerX - current.x) / current.scale;
      const worldY = (centerY - current.y) / current.scale;
      return {
        x: centerX - worldX * nextScale,
        y: centerY - worldY * nextScale,
        scale: nextScale
      };
    });
  }

  function handleCanvasWheel(event: WheelEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".threadCanvasFocusNode")) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      zoomCanvasAt(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
      return;
    }

    const deltaX = event.shiftKey ? event.deltaX + event.deltaY : event.deltaX;
    const deltaY = event.shiftKey ? 0 : event.deltaY;
    setCanvasTransform((current) => ({
      ...current,
      x: current.x - deltaX,
      y: current.y - deltaY
    }));
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, textarea, input, select, .threadCanvasNode, .threadCanvasFocusNode, .threadCanvasControls, .threadNodeMinimap")) return;
    panStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      originX: canvasTransform.x,
      originY: canvasTransform.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setCanvasTransform((current) => ({
      ...current,
      x: start.originX + event.clientX - start.clientX,
      y: start.originY + event.clientY - start.clientY
    }));
  }

  function finishCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (panStartRef.current?.pointerId !== event.pointerId) return;
    panStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsPanning(false);
  }

  function captureMessageSelection() {
    window.requestAnimationFrame(() => {
      const selection = window.getSelection();
      const inspector = inspectorRef.current;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !inspector) {
        setSelectionPopover(null);
        return;
      }

      const startElement = selectionElement(selection.anchorNode);
      const endElement = selectionElement(selection.focusNode);
      const startContent = startElement?.closest(".messageContent");
      const endContent = endElement?.closest(".messageContent");
      const messageElement = startContent?.closest<HTMLElement>("[data-thread-message-id]");
      if (!startContent || startContent !== endContent || !messageElement || !inspector.contains(messageElement)) {
        setSelectionPopover(null);
        return;
      }

      const text = selection.toString().replace(/\s+/g, " ").trim().slice(0, 2000);
      if (!text) {
        setSelectionPopover(null);
        return;
      }

      const range = selection.getRangeAt(0);
      const selectionRect = range.getBoundingClientRect();
      const inspectorRect = inspector.getBoundingClientRect();
      const focusScale = canvasTransformRef.current.scale;
      const inspectorWidth = inspectorRect.width / focusScale;
      const inspectorHeight = inspectorRect.height / focusScale;
      const preferredTop = (selectionRect.bottom - inspectorRect.top) / focusScale + 8;
      const highlightRects = Array.from(range.getClientRects()).flatMap((rect) => {
        const left = clamp((rect.left - inspectorRect.left) / focusScale, 0, inspectorWidth);
        const right = clamp((rect.right - inspectorRect.left) / focusScale, 0, inspectorWidth);
        const top = clamp((rect.top - inspectorRect.top) / focusScale, 0, inspectorHeight);
        const bottom = clamp((rect.bottom - inspectorRect.top) / focusScale, 0, inspectorHeight);
        return right > left && bottom > top
          ? [{ left, top, width: right - left, height: bottom - top }]
          : [];
      });
      setSelectionPopover({
        sourceMessageId: messageElement.dataset.threadMessageId || "",
        text,
        left: clamp((selectionRect.left - inspectorRect.left + selectionRect.width / 2) / focusScale, 190, inspectorWidth - 190),
        top: clamp(preferredTop, 58, inspectorHeight - 112),
        highlightRects,
        prompt: "",
        insertBeforeNodeId: null
      });
    });
  }

  function submitSelectionQuestion() {
    if (!selectionPopover || !selectedNode || !selectionPopover.prompt.trim()) return;
    props.onSend(
      selectionPopover.prompt,
      "",
      null,
      selectedNode.id,
      { sourceMessageId: selectionPopover.sourceMessageId, text: selectionPopover.text },
      false,
      selectionPopover.insertBeforeNodeId
    );
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
  }

  function beginMessageSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const messageContent = (event.target as HTMLElement).closest<HTMLElement>(".messageContent");
    if (!messageContent) return;
    selectionActiveRef.current = true;
    selectingMessageRef.current = messageContent;
    lastValidSelectionRangeRef.current = null;
    setSelectionPopover(null);
  }

  const selectedCanvasItem = selectedNodeId
    ? canvasLayout.nodes.find((item) => item.node.id === selectedNodeId) || null
    : null;
  const ghostNode = (() => {
    if (!inspectorOpen || !messageDraft.trim()) return null;
    if (!selectedCanvasItem) return { x: 0, y: 0 };
    return {
      x: selectedCanvasItem.x + THREAD_FOCUS_NODE_WIDTH / 2 + 132,
      y: selectedCanvasItem.y
    };
  })();

  return (
    <div className="modalBackdrop threadModalBackdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className="threadModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="threadModalHeader">
          <div className="threadModalHeading">
            <div className="threadModalEyebrow">
              <span>讨论树</span>
              <span>{nodeCount} 个节点</span>
              <span>{messageCount} 条消息</span>
              <span>{lineLabel}</span>
            </div>
            <h2 id="thread-modal-title">{props.thread.selectedText || props.thread.title || "Untitled thread"}</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="threadModalClose" aria-label="Close thread details" onClick={props.onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div
          ref={canvasRef}
          className={`threadModalWorkspace threadCanvasViewport ${isPanning ? "panning" : ""} ${inspectorOpen ? "focusMode" : ""}`}
          aria-label="Conversation tree canvas"
          onWheel={handleCanvasWheel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={finishCanvasPan}
          onPointerCancel={finishCanvasPan}
        >
          <div className="threadCanvasHint">拖动画布 · 滚轮移动 · ⌘/Ctrl + 滚轮缩放</div>
          <div className="threadCanvasControls" aria-label="Canvas controls">
            <button type="button" aria-label="缩小" title="缩小" onClick={() => zoomCanvasAt(0.85)}>−</button>
            <span>{Math.round(canvasTransform.scale * 100)}%</span>
            <button type="button" aria-label="放大" title="放大" onClick={() => zoomCanvasAt(1.18)}>+</button>
            <button type="button" className="threadCanvasControlText" onClick={resetView}>根节点</button>
            <button type="button" className="threadCanvasControlText" onClick={fitTree}>适合</button>
          </div>

          <div
            className="threadCanvasWorld"
            style={{ transform: `translate(${canvasTransform.x}px, ${canvasTransform.y}px) scale(${canvasTransform.scale})` }}
          >
            <svg className="threadCanvasConnectors" aria-hidden="true">
              {canvasLayout.connectors.map((connector) => {
                const middleY = (connector.fromY + connector.toY) / 2;
                return (
                  <path
                    key={connector.id}
                    className={insertBeforeNodeId === connector.toNodeId ? "insertTarget" : ""}
                    d={`M ${connector.fromX} ${connector.fromY} C ${connector.fromX} ${middleY}, ${connector.toX} ${middleY}, ${connector.toX} ${connector.toY}`}
                  />
                );
              })}
              {ghostNode && selectedCanvasItem && (
                <path
                  className="ghostConnector"
                  d={`M ${selectedCanvasItem.x + THREAD_FOCUS_NODE_WIDTH / 2} ${selectedCanvasItem.y} C ${selectedCanvasItem.x + THREAD_FOCUS_NODE_WIDTH / 2 + 48} ${selectedCanvasItem.y}, ${ghostNode.x - 150} ${ghostNode.y}, ${ghostNode.x - 105} ${ghostNode.y}`}
                />
              )}
            </svg>

            {canvasLayout.connectors.map((connector) => (
              <button
                key={`insert:${connector.id}`}
                type="button"
                className={`threadCanvasEdgeInsert ${insertBeforeNodeId === connector.toNodeId ? "active" : ""}`}
                style={{
                  left: (connector.fromX + connector.toX) / 2,
                  top: (connector.fromY + connector.toY) / 2
                }}
                aria-label={`在 ${questionSummary(nodes.find((node) => node.id === connector.fromNodeId)?.question.content || "")} 与 ${questionSummary(nodes.find((node) => node.id === connector.toNodeId)?.question.content || "")} 之间插入追问`}
                title="在这条路径中插入追问"
                onClick={() => openInsertBetween(connector.fromNodeId, connector.toNodeId)}
              >
                +
              </button>
            ))}

            {canvasLayout.nodes.map((item) => (
              inspectorOpen && selectedNodeId === item.node.id ? (
                <article
                  key={item.node.id}
                  ref={inspectorRef}
                  className="threadCanvasFocusNode"
                  aria-label="当前节点详情"
                  style={{
                    left: item.x - THREAD_FOCUS_NODE_WIDTH / 2,
                    top: item.y - THREAD_FOCUS_NODE_HEIGHT / 2,
                    width: THREAD_FOCUS_NODE_WIDTH,
                    height: THREAD_FOCUS_NODE_HEIGHT
                  }}
                >
                  <header className="threadCanvasFocusHeader">
                    <div className="threadCanvasInspectorTitle">
                      <span>当前节点</span>
                      <nav className="threadCanvasInspectorBreadcrumb" aria-label="当前节点路径">
                        {selectedNodeBreadcrumb.map((node, index) => {
                          const current = index === selectedNodeBreadcrumb.length - 1;
                          return (
                            <span key={node.id} className={`threadCanvasInspectorBreadcrumbItem ${current ? "current" : ""}`}>
                              {index > 0 && <i aria-hidden="true">/</i>}
                              {current ? (
                                <strong title={node.question.content}>{questionSummary(node.question.content)}</strong>
                              ) : (
                                <button type="button" title={node.question.content} onClick={() => navigateToNode(node.id)}>
                                  {questionSummary(node.question.content)}
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </nav>
                    </div>
                    <button type="button" className="threadCanvasInspectorClose" aria-label="返回树总览" title="返回树总览 (Esc)" onClick={closeFocusedNode}>×</button>
                  </header>

                  {selectionPopover && (
                    <>
                      <div className="threadSelectionHighlightLayer" aria-hidden="true">
                        {selectionPopover.highlightRects.map((rect, index) => (
                          <span
                            key={`${rect.left}:${rect.top}:${index}`}
                            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                          />
                        ))}
                      </div>
                      <form
                        className="threadSelectionComposer"
                        style={{ left: selectionPopover.left, top: selectionPopover.top }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitSelectionQuestion();
                        }}
                      >
                        <div>
                          <input
                            ref={selectionComposerRef}
                            value={selectionPopover.prompt}
                            onChange={(event) => setSelectionPopover((current) => current ? { ...current, prompt: event.target.value } : null)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.stopPropagation();
                                setSelectionPopover(null);
                                window.getSelection()?.removeAllRanges();
                              }
                            }}
                            placeholder="基于选中内容继续追问…"
                            aria-label="基于选中内容继续追问"
                          />
                          <button type="submit" className="primaryButton" disabled={!selectionPopover.prompt.trim()}>发送</button>
                        </div>
                        {selectedNode && selectedNode.children.length > 0 ? (
                          <select
                            aria-label="新节点位置"
                            value={selectionPopover.insertBeforeNodeId || ""}
                            onChange={(event) => setSelectionPopover((current) => current ? {
                              ...current,
                              insertBeforeNodeId: event.target.value || null
                            } : null)}
                          >
                            <option value="">从当前节点新建分支</option>
                            {selectedNode.children.map((child) => (
                              <option key={child.id} value={child.id}>插入路径 → {questionSummary(child.question.content)}</option>
                            ))}
                          </select>
                        ) : (
                          <small>继续当前路径</small>
                        )}
                      </form>
                    </>
                  )}

                  <div
                    ref={messageSelectionSurfaceRef}
                    className="threadModalContent threadCanvasInspectorContent"
                    onPointerDown={beginMessageSelection}
                    onMouseUp={captureMessageSelection}
                    onPointerUp={captureMessageSelection}
                    onKeyUp={captureMessageSelection}
                    onScroll={() => setSelectionPopover(null)}
                  >
                    {selectedNodeOrigin && (
                      <div className="threadNodeOriginQuote">
                        <span>引用内容</span>
                        <blockquote>{selectedNodeOrigin.text}</blockquote>
                      </div>
                    )}
                    {selectedNode?.messages.map((message) => (
                      <ThreadMessageDetail
                        key={message.id}
                        threadId={props.thread.id}
                        message={message}
                        editingMessage={props.editingMessage}
                        editText={props.editText}
                        onEdit={props.onEdit}
                        onCancelEdit={props.onCancelEdit}
                        onSaveEdit={props.onSaveEdit}
                        onRetryAssistant={props.onRetryAssistant}
                        onDeleteMessage={props.onDeleteMessage}
                        setEditText={props.setEditText}
                      />
                    ))}
                    {selectedNode && !selectedNode.messages.some((message) => message.role === "assistant") && (
                      <div className="threadNodeAnswerEmpty">当前节点还没有 Codex 回答。</div>
                    )}
                    {props.permissionRequests.map((request) => (
                      <PermissionRequestPanel
                        key={request.id}
                        request={request}
                        resolving={props.resolvingPermissionIds.has(request.id)}
                        onResolve={props.onResolvePermission}
                      />
                    ))}
                  </div>

                  <form
                    className="threadModalComposer threadFocusComposer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!selectedNode) props.onSend(messageDraft, draftKey, null, null);
                      else props.onSend(messageDraft, draftKey, null, selectedNode.id, null, false, insertBeforeNodeId);
                      setSelectionPopover(null);
                    }}
                  >
                    <div className="threadFocusComposerTopline">
                      <label htmlFor="thread-canvas-question">
                        {selectedInsertTarget
                          ? <>插入路径 <strong>→ {questionSummary(selectedInsertTarget.question.content)}</strong></>
                          : selectedNode?.children.length
                            ? "从当前节点新建分支"
                            : "继续追问"}
                      </label>
                      {selectedNode && selectedNode.children.length > 0 && (
                        <select
                          aria-label="追问位置"
                          value={insertBeforeNodeId || ""}
                          onChange={(event) => setInsertBeforeNodeId(event.target.value || null)}
                        >
                          <option value="">新建分支</option>
                          {selectedNode.children.map((child) => (
                            <option key={child.id} value={child.id}>插入到 → {questionSummary(child.question.content)}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    {messageDraft.trim() && selectedNode && (
                      <div className="threadFocusRoutePreview" aria-label="新节点位置预览">
                        <span>{questionSummary(selectedNode.question.content)}</span>
                        <i aria-hidden="true">→</i>
                        <strong>{questionSummary(messageDraft)}</strong>
                        {selectedInsertTarget && (
                          <>
                            <i aria-hidden="true">→</i>
                            <span>{questionSummary(selectedInsertTarget.question.content)}</span>
                          </>
                        )}
                      </div>
                    )}
                    <textarea
                      id="thread-canvas-question"
                      ref={composerRef}
                      value={messageDraft}
                      onChange={(event) => props.setMessageDraft(draftKey, event.target.value)}
                      placeholder="输入下一步想追问的内容…"
                      aria-label="继续追问"
                    />
                    <div className="threadModalComposerActions">
                      <span>支持 Markdown · 自动继承祖先上下文</span>
                      <button
                        type="submit"
                        className="primaryButton"
                        disabled={!messageDraft.trim() || Boolean(selectedNode?.messages.some((message) => message.id.startsWith("pending-")))}
                      >
                        {selectedInsertTarget ? "插入追问" : selectedNode?.children.length ? "创建分支" : "继续追问"}
                      </button>
                    </div>
                  </form>
                </article>
              ) : (
                <ConversationCanvasNode
                  key={item.node.id}
                  node={item.node}
                  root={item.depth === 0}
                  active={false}
                  x={item.x}
                  y={item.y}
                  onOpen={() => openNode(item.node.id)}
                  onAskChild={() => openNode(item.node.id, true)}
                />
              )
            ))}

            {canvasLayout.nodes.length === 0 && (
              inspectorOpen ? (
                <article
                  ref={inspectorRef}
                  className="threadCanvasFocusNode rootComposer"
                  aria-label="创建根问题"
                  style={{
                    left: -THREAD_FOCUS_NODE_WIDTH / 2,
                    top: -THREAD_FOCUS_NODE_HEIGHT / 2,
                    width: THREAD_FOCUS_NODE_WIDTH,
                    height: THREAD_FOCUS_NODE_HEIGHT
                  }}
                >
                  <header className="threadCanvasFocusHeader">
                    <div className="threadCanvasInspectorTitle">
                      <span>根节点</span>
                      <strong>开始新的讨论树</strong>
                    </div>
                    <button type="button" className="threadCanvasInspectorClose" aria-label="返回树总览" onClick={closeFocusedNode}>×</button>
                  </header>
                  <form
                    className="threadModalComposer threadRootComposer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      props.onSend(messageDraft, draftKey, null, null);
                    }}
                  >
                    <textarea
                      id="thread-canvas-question"
                      ref={composerRef}
                      value={messageDraft}
                      onChange={(event) => props.setMessageDraft(draftKey, event.target.value)}
                      placeholder="输入第一个问题…"
                      aria-label="根节点问题"
                    />
                    <div className="threadModalComposerActions">
                      <span>这将成为讨论树的起点</span>
                      <button type="submit" className="primaryButton" disabled={!messageDraft.trim()}>询问 Codex</button>
                    </div>
                  </form>
                </article>
              ) : (
                <button type="button" className="threadCanvasRootPlaceholder" onClick={openRootComposer}>
                  <span>+</span>
                  创建根问题
                </button>
              )
            )}

            {ghostNode && (
              <div
                className="threadCanvasGhostNode"
                style={{ left: ghostNode.x - 105, top: ghostNode.y - 38 }}
                aria-hidden="true"
              >
                <small>{selectedInsertTarget ? "插入路径" : "新节点预览"}</small>
                <strong>{questionSummary(messageDraft)}</strong>
              </div>
            )}
          </div>

          {inspectorOpen && selectedNode && (
            <div className="threadCanvasMinimapDock">
              <ConversationTreeMinimap
                layout={canvasLayout}
                path={selectedNodeBreadcrumb}
                selectedNodeId={selectedNode.id}
                collapsed={minimapCollapsed}
                onToggle={() => setMinimapCollapsed((current) => !current)}
                onNavigate={navigateToNode}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ConversationTreeMinimap(props: {
  layout: ReturnType<typeof layoutConversationTree>;
  path: ReturnType<typeof conversationBreadcrumb>;
  selectedNodeId: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (nodeId: string) => void;
}) {
  const padding = 54;
  const bounds = props.layout.bounds;
  const viewBox = {
    x: bounds.left - padding,
    y: bounds.top - padding,
    width: Math.max(1, bounds.right - bounds.left + padding * 2),
    height: Math.max(1, bounds.bottom - bounds.top + padding * 2)
  };
  const unitsPerPixel = Math.max(viewBox.width / 204, viewBox.height / 72);
  const markerRadius = clamp(unitsPerPixel * 3.2, 11, 52);
  const selectedRadius = markerRadius * 1.42;
  const pathIds = new Set(props.path.map((node) => node.id));
  const pathConnectors = new Set(props.path.slice(1).map((node, index) => `${props.path[index].id}:${node.id}`));
  const selectedLayout = props.layout.nodes.find((item) => item.node.id === props.selectedNodeId);

  return (
    <aside
      className={`threadNodeMinimap ${props.collapsed ? "collapsed" : ""}`}
      aria-label="讨论树位置"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="threadNodeMinimapToggle"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
      >
        <span>树形位置</span>
        <small>{selectedLayout ? `第 ${selectedLayout.depth + 1} 层` : ""}</small>
        <i aria-hidden="true">{props.collapsed ? "⌄" : "⌃"}</i>
      </button>
      {!props.collapsed && (
        <svg
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          role="img"
          aria-label="讨论树总览，蓝色节点为当前位置"
        >
          {props.layout.connectors.map((connector) => (
            <path
              key={connector.id}
              className={pathConnectors.has(connector.id) ? "activePath" : ""}
              d={`M ${connector.fromX} ${connector.fromY} C ${connector.fromX} ${(connector.fromY + connector.toY) / 2}, ${connector.toX} ${(connector.fromY + connector.toY) / 2}, ${connector.toX} ${connector.toY}`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {props.layout.nodes.map((item) => {
            const selected = item.node.id === props.selectedNodeId;
            const onPath = pathIds.has(item.node.id);
            return (
              <g
                key={item.node.id}
                className={`${selected ? "current" : ""} ${onPath ? "onPath" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${selected ? "当前节点：" : "打开节点："}${questionSummary(item.node.question.content)}`}
                onClick={() => props.onNavigate(item.node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onNavigate(item.node.id);
                  }
                }}
              >
                <title>{questionSummary(item.node.question.content)}</title>
                <circle className="hitArea" r={Math.max(markerRadius * 2.5, selectedRadius * 1.8)} cx={item.x} cy={item.y} />
                {selected && <circle className="currentRing" r={selectedRadius * 1.65} cx={item.x} cy={item.y} vectorEffect="non-scaling-stroke" />}
                <circle className="nodeMarker" r={selected ? selectedRadius : markerRadius} cx={item.x} cy={item.y} vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
      )}
    </aside>
  );
}

function ConversationCanvasNode(props: {
  node: ReturnType<typeof flattenConversationTree>[number];
  root: boolean;
  active: boolean;
  x: number;
  y: number;
  onOpen: () => void;
  onAskChild: () => void;
}) {
  const userTurns = props.node.messages.filter((message) => message.role === "user").length;
  const pending = props.node.messages.some((message) => message.id.startsWith("pending-"));
  const answered = props.node.messages.at(-1)?.role === "assistant";
  const hasSelectedOrigin = Boolean(messageBranchSelection(props.node.question));
  return (
    <article
      className={`threadCanvasNode ${props.root ? "root" : ""} ${props.active ? "active" : ""}`}
      style={{
        left: props.x - THREAD_CANVAS_NODE_WIDTH / 2,
        top: props.y - THREAD_CANVAS_NODE_HEIGHT / 2,
        width: THREAD_CANVAS_NODE_WIDTH,
        height: THREAD_CANVAS_NODE_HEIGHT
      }}
    >
      <button type="button" className="threadCanvasNodeMain" onClick={props.onOpen}>
        <span className="threadCanvasNodeTopline">
          <span>{props.root ? "根节点" : "节点"}</span>
          <small>{pending ? "思考中…" : answered ? "已回答" : "等待回答"}</small>
        </span>
        <strong>{questionSummary(props.node.question.content)}</strong>
        <span className="threadCanvasNodeMeta">
          {userTurns} 轮
          {props.node.children.length > 0 ? ` · ${props.node.children.length} 个子节点` : ""}
          {hasSelectedOrigin ? " · 包含引用" : ""}
        </span>
      </button>
      <button
        type="button"
        className="threadCanvasNodeAdd"
        aria-label={`从 ${questionSummary(props.node.question.content)} 新建分支`}
        title="从这里新建分支"
        onClick={props.onAskChild}
      >
        <span aria-hidden="true">+</span>
        <small>分支</small>
      </button>
    </article>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function keyboardTargetAcceptsArrows(target: EventTarget | null): boolean {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return true;
  const element = target instanceof Element ? target : document.activeElement;
  return Boolean(element?.closest("textarea, input, select, [contenteditable='true']"));
}

function selectionElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function messageBranchSelection(message: Message): BranchSelection | null {
  const value = message.meta?.branchSelection;
  if (!value || typeof value !== "object") return null;
  const sourceMessageId = "sourceMessageId" in value && typeof value.sourceMessageId === "string" ? value.sourceMessageId : "";
  const text = "text" in value && typeof value.text === "string" ? value.text : "";
  return sourceMessageId && text ? { sourceMessageId, text } : null;
}

function ThreadMessageDetail(props: {
  threadId: string;
  message: Message;
  editingMessage: string | null;
  editText: string;
  onEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (threadId: string, messageId: string) => void;
  onRetryAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  setEditText: (value: string) => void;
}) {
  const message = props.message;
  return (
    <section
      className={`message ${message.role} ${message.error ? "error" : ""}`}
      data-thread-message-id={message.id}
    >
      <span className="messageAvatar" aria-hidden="true">{message.role === "assistant" ? "C" : "Y"}</span>
      <div className="messageBody">
        <div className="messageRole">
          <span className="messageMeta">
            {message.role === "assistant" ? "Codex" : "你"} <time>{formatMessageTime(message.createdAt)}</time>
            {message.role === "assistant" && !message.id.startsWith("pending-") && (
              <button type="button" onClick={() => props.onRetryAssistant(props.threadId, message.id)}>重试</button>
            )}
          </span>
          {!message.id.startsWith("pending-") && (
            <span className="messageActions">
              {message.role === "user" && <button type="button" onClick={() => props.onEdit(message)}>编辑</button>}
              <button type="button" onClick={() => props.onDeleteMessage(props.threadId, message.id)}>删除</button>
            </span>
          )}
        </div>
        {props.editingMessage === message.id ? (
          <div>
            <textarea className="editMessageBox" value={props.editText} onChange={(event) => props.setEditText(event.target.value)} />
            <div className="editMessageActions">
              <button type="button" onClick={props.onCancelEdit}>取消</button>
              <button type="button" className="primaryButton" onClick={() => props.onSaveEdit(props.threadId, message.id)}>保存</button>
            </div>
          </div>
        ) : (
          <div className="messageContent" dangerouslySetInnerHTML={{ __html: renderMessageMarkdown(message.content) }} />
        )}
      </div>
    </section>
  );
}

function questionSummary(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "Untitled question";
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
}

function PermissionRequestPanel(props: {
  request: PermissionRequest;
  resolving: boolean;
  onResolve: (requestId: string, optionId: string | null) => void;
}) {
  const allowOnce = optionByKind(props.request.options, "allow_once");
  const allowAlways = optionByKind(props.request.options, "allow_always");
  const rejectOnce = optionByKind(props.request.options, "reject_once");
  const rejectAlways = optionByKind(props.request.options, "reject_always");
  const fallbackOptions = props.request.options.filter((option) => (
    option !== allowOnce && option !== allowAlways && option !== rejectOnce && option !== rejectAlways
  ));

  return (
    <section className="permissionRequest">
      <div className="permissionRequestHeader">
        <span>Permission request</span>
        <time>{formatMessageTime(props.request.createdAt)}</time>
      </div>
      <div className="permissionRequestTitle">{props.request.title}</div>
      {props.request.rawInput && <div className="permissionRequestDetail">{props.request.rawInput}</div>}
      <div className="permissionRequestActions">
        {allowOnce && (
          <button type="button" className="primaryButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, allowOnce.optionId)}>
            Allow
          </button>
        )}
        {allowAlways && (
          <button type="button" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, allowAlways.optionId)}>
            Allow & remember
          </button>
        )}
        {rejectOnce && (
          <button type="button" className="dangerButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, rejectOnce.optionId)}>
            Deny
          </button>
        )}
        {rejectAlways && (
          <button type="button" className="dangerButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, rejectAlways.optionId)}>
            Always deny
          </button>
        )}
        {fallbackOptions.map((option) => (
          <button key={option.optionId} type="button" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, option.optionId)}>
            {labelForPermissionOption(option)}
          </button>
        ))}
        <button type="button" className="ghostButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, null)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

type ThreadPlacementInput = {
  thread: Thread;
  targetTop: number;
  sortLine: number;
};

type ThreadPlacement = ThreadPlacementInput & {
  top: number;
};

function threadTargetTop(thread: Thread, index: number, layout: ThreadSpatialLayout | null): number {
  const position = layout?.positions[thread.id];
  if (position) return position.top;
  const line = thread.anchor.lineStart;
  if (layout && Number.isInteger(line) && line !== null) {
    return Math.max(0, Math.min(layout.contentHeight, line * 22));
  }
  return index * 92;
}

function placeThreadCards(
  items: ThreadPlacementInput[],
  heights: Record<string, number>
): ThreadPlacement[] {
  let cursor = 8;
  return items.map((item) => {
    const top = Math.max(item.targetTop, cursor);
    const height = heights[item.thread.id] || estimatedThreadHeight();
    cursor = top + height + 10;
    return { ...item, top };
  });
}

function estimatedThreadHeight(): number {
  return 72;
}

function alignedSpatialHeight(layout: ThreadSpatialLayout | null, railViewportHeight: number): number {
  if (!layout) return 0;
  const viewportDelta = Math.max(0, railViewportHeight - layout.viewportHeight);
  return layout.contentHeight + viewportDelta;
}

function normalizeWheelDeltaY(event: WheelEvent<HTMLElement>, viewportHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * Math.max(viewportHeight, 1);
  return event.deltaY;
}

function maxSpatialScrollTop(layout: ThreadSpatialLayout): number {
  return Math.max(0, layout.contentHeight - layout.viewportHeight);
}

function clampScrollTop(scrollTop: number, maxScrollTop: number): number {
  return Math.max(0, Math.min(scrollTop, maxScrollTop));
}

function canNestedTargetScroll(event: WheelEvent<HTMLElement>, root: HTMLElement, deltaY: number): boolean {
  let node = event.target instanceof Element ? event.target : null;
  while (node && node !== root) {
    if (node instanceof HTMLElement && canElementScrollVertically(node, deltaY)) return true;
    node = node.parentElement;
  }
  return false;
}

function canElementScrollVertically(element: HTMLElement, deltaY: number): boolean {
  const style = window.getComputedStyle(element);
  if (!/(auto|scroll)/.test(style.overflowY)) return false;
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  if (deltaY > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  if (deltaY < 0) return element.scrollTop > 1;
  return false;
}

function shallowEqualNumberRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function optionByKind(options: PermissionOption[], kind: string): PermissionOption | null {
  return options.find((option) => option.kind === kind) || null;
}

function labelForPermissionOption(option: PermissionOption): string {
  const label = option.name.trim();
  if (label) return label;
  return option.kind.replace(/_/g, " ");
}

function formatMessageTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
