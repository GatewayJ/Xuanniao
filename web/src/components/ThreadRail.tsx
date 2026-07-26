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
  onSend: (threadId: string, content: string, draftKey: string, askAgent: boolean, nodeId: string | null, parentMessageId: string | null, branchSelection?: BranchSelection | null, adoptExistingChildren?: boolean) => void;
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
          onSend={(content, draftKey, nodeId, parentMessageId, branchSelection, adoptExistingChildren) => props.onSend(openThreadDetail.id, content, draftKey, true, nodeId, parentMessageId, branchSelection, adoptExistingChildren)}
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
  onSend: (content: string, draftKey: string, nodeId: string | null, parentMessageId: string | null, branchSelection?: BranchSelection | null, adoptExistingChildren?: boolean) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const messageSelectionSurfaceRef = useRef<HTMLDivElement | null>(null);
  const selectingMessageRef = useRef<HTMLElement | null>(null);
  const lastValidSelectionRangeRef = useRef<Range | null>(null);
  const selectionActiveRef = useRef(false);
  const inspectorOpenRef = useRef(false);
  const nodeNavigationRef = useRef<ReturnType<typeof conversationNavigation>>({ left: null, right: null, up: null, down: null });
  const nodeSwipeStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const nodeWheelRef = useRef({ x: 0, y: 0, lastAt: 0, lockedUntil: 0 });
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
  const [composerMode, setComposerMode] = useState<"continue" | "child">("continue");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [branchSelection, setBranchSelection] = useState<BranchSelection | null>(null);
  const [selectionPopover, setSelectionPopover] = useState<(BranchSelection & {
    left: number;
    top: number;
    highlightRects: Array<{ left: number; top: number; width: number; height: number }>;
  }) | null>(null);
  const [minimapCollapsed, setMinimapCollapsed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [canvasTransform, setCanvasTransform] = useState({ x: 0, y: 0, scale: 1 });
  inspectorOpenRef.current = inspectorOpen;
  const knownNodeIdsRef = useRef(new Set(nodes.map((node) => node.id)));
  const centeredThreadRef = useRef<string | null>(null);

  useEffect(() => {
    const knownIds = knownNodeIdsRef.current;
    const addedNodes = nodes.filter((node) => !knownIds.has(node.id));
    knownNodeIdsRef.current = new Set(nodes.map((node) => node.id));
    if (addedNodes.length > 0) {
      setSelectedNodeId(addedNodes.at(-1)?.id || null);
      setComposerMode("continue");
      setBranchSelection(null);
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
  const lineStart = props.thread.anchor.lineStart;
  const lineEnd = props.thread.anchor.lineEnd;
  const lineLabel = lineStart
    ? `Line ${lineStart}${lineEnd && lineEnd !== lineStart ? `–${lineEnd}` : ""}`
    : "Unanchored";

  function openNode(nodeId: string, createChild = false) {
    setSelectedNodeId(nodeId);
    setComposerMode(createChild ? "child" : "continue");
    setBranchSelection(null);
    setSelectionPopover(null);
    setInspectorOpen(true);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function navigateToNode(nodeId: string | null | undefined) {
    if (!nodeId) return;
    setSelectedNodeId(nodeId);
    setComposerMode("continue");
    setBranchSelection(null);
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => {
      if (messageSelectionSurfaceRef.current) messageSelectionSurfaceRef.current.scrollTop = 0;
    });
  }

  function navigateInDirection(direction: keyof typeof selectedNodeNavigation) {
    navigateToNode(selectedNodeNavigation[direction]?.id);
  }

  function beginNodeSwipe(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    nodeSwipeStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishNodeSwipe(event: ReactPointerEvent<HTMLElement>) {
    const start = nodeSwipeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    nodeSwipeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 48) return;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      navigateInDirection(deltaX < 0 ? "left" : "right");
    } else {
      navigateInDirection(deltaY < 0 ? "up" : "down");
    }
  }

  function cancelNodeSwipe(event: ReactPointerEvent<HTMLElement>) {
    if (nodeSwipeStartRef.current?.pointerId !== event.pointerId) return;
    nodeSwipeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleNodeNavigationWheel(event: WheelEvent<HTMLElement>) {
    event.preventDefault();
    const now = Date.now();
    const gesture = nodeWheelRef.current;
    if (now < gesture.lockedUntil) return;
    if (now - gesture.lastAt > 180) {
      gesture.x = 0;
      gesture.y = 0;
    }
    gesture.x += event.deltaX;
    gesture.y += event.deltaY;
    gesture.lastAt = now;
    if (Math.max(Math.abs(gesture.x), Math.abs(gesture.y)) < 42) return;

    if (Math.abs(gesture.x) > Math.abs(gesture.y)) {
      navigateInDirection(gesture.x < 0 ? "left" : "right");
    } else {
      navigateInDirection(gesture.y < 0 ? "up" : "down");
    }
    gesture.x = 0;
    gesture.y = 0;
    gesture.lockedUntil = now + 420;
  }

  function openRootComposer() {
    setSelectedNodeId(null);
    setComposerMode("continue");
    setBranchSelection(null);
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

  function zoomAtCanvasCenter(multiplier: number) {
    const centerX = canvasSize.width / 2;
    const centerY = canvasSize.height / 2;
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
    if ((event.target as HTMLElement).closest(".threadCanvasInspector")) return;
    event.preventDefault();
    zoomAtCanvasCenter(Math.exp(-event.deltaY * 0.0015));
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, textarea, .threadCanvasNode, .threadCanvasInspector, .threadCanvasControls")) return;
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
      const preferredTop = selectionRect.top - inspectorRect.top - 42;
      const highlightRects = Array.from(range.getClientRects()).flatMap((rect) => {
        const left = clamp(rect.left - inspectorRect.left, 0, inspectorRect.width);
        const right = clamp(rect.right - inspectorRect.left, 0, inspectorRect.width);
        const top = clamp(rect.top - inspectorRect.top, 0, inspectorRect.height);
        const bottom = clamp(rect.bottom - inspectorRect.top, 0, inspectorRect.height);
        return right > left && bottom > top
          ? [{ left, top, width: right - left, height: bottom - top }]
          : [];
      });
      setSelectionPopover({
        sourceMessageId: messageElement.dataset.threadMessageId || "",
        text,
        left: clamp(selectionRect.left - inspectorRect.left + selectionRect.width / 2, 150, inspectorRect.width - 150),
        top: preferredTop > 44 ? preferredTop : selectionRect.bottom - inspectorRect.top + 8,
        highlightRects
      });
    });
  }

  function useSelectionFor(mode: "continue" | "child") {
    if (!selectionPopover) return;
    setBranchSelection({ sourceMessageId: selectionPopover.sourceMessageId, text: selectionPopover.text });
    setComposerMode(mode);
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerRef.current?.focus());
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
              <span>Thread</span>
              <span>{nodeCount} node{nodeCount === 1 ? "" : "s"}</span>
              <span>{messageCount} message{messageCount === 1 ? "" : "s"}</span>
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
          className={`threadModalWorkspace threadCanvasViewport ${isPanning ? "panning" : ""}`}
          aria-label="Conversation tree canvas"
          onWheel={handleCanvasWheel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={finishCanvasPan}
          onPointerCancel={finishCanvasPan}
        >
          <div className="threadCanvasHint">Drag background to pan · Scroll to zoom</div>
          <div className="threadCanvasControls" aria-label="Canvas controls">
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAtCanvasCenter(0.85)}>−</button>
            <span>{Math.round(canvasTransform.scale * 100)}%</span>
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAtCanvasCenter(1.18)}>+</button>
            <button type="button" className="threadCanvasControlText" onClick={resetView}>Root</button>
            <button type="button" className="threadCanvasControlText" onClick={fitTree}>Fit</button>
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
                    d={`M ${connector.fromX} ${connector.fromY} C ${connector.fromX} ${middleY}, ${connector.toX} ${middleY}, ${connector.toX} ${connector.toY}`}
                  />
                );
              })}
            </svg>

            {canvasLayout.nodes.map((item) => (
              <ConversationCanvasNode
                key={item.node.id}
                node={item.node}
                root={item.depth === 0}
                active={inspectorOpen && selectedNodeId === item.node.id}
                x={item.x}
                y={item.y}
                onOpen={() => openNode(item.node.id)}
                onAskChild={() => openNode(item.node.id, true)}
              />
            ))}

            {canvasLayout.nodes.length === 0 && (
              <button type="button" className="threadCanvasRootPlaceholder" onClick={openRootComposer}>
                <span>+</span>
                Ask the root question
              </button>
            )}
          </div>

          {inspectorOpen && (
            <section ref={inspectorRef} className="threadCanvasInspector" aria-label={selectedNode ? "Selected node details" : "Root question composer"}>
              <header
                className={`threadCanvasInspectorHeader ${selectedNode ? "withMinimap" : ""}`}
                onPointerDown={beginNodeSwipe}
                onPointerUp={finishNodeSwipe}
                onPointerCancel={cancelNodeSwipe}
                onWheel={handleNodeNavigationWheel}
              >
                <div className="threadCanvasInspectorTitle">
                  <span>{!selectedNode ? "New root node" : composerMode === "child" ? "New child of selected node" : "Current node"}</span>
                  {selectedNode ? (
                    <nav className="threadCanvasInspectorBreadcrumb" aria-label="Current node path">
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
                  ) : (
                    <strong>Start the conversation tree</strong>
                  )}
                </div>
                {selectedNode && (
                  <ConversationTreeMinimap
                    layout={canvasLayout}
                    path={selectedNodeBreadcrumb}
                    selectedNodeId={selectedNode.id}
                    collapsed={minimapCollapsed}
                    onToggle={() => setMinimapCollapsed((current) => !current)}
                    onNavigate={navigateToNode}
                  />
                )}
                {selectedNode && (
                  <nav className="threadCanvasInspectorNavigation" aria-label="Navigate conversation tree">
                    <span>Swipe / arrow keys</span>
                    <div>
                      <button type="button" aria-label="Previous sibling node" title="Previous sibling" disabled={!selectedNodeNavigation.left} onClick={() => navigateInDirection("left")}>←</button>
                      <button type="button" aria-label="Parent node" title="Parent node" disabled={!selectedNodeNavigation.up} onClick={() => navigateInDirection("up")}>↑</button>
                      <button type="button" aria-label="First child node" title="First child" disabled={!selectedNodeNavigation.down} onClick={() => navigateInDirection("down")}>↓</button>
                      <button type="button" aria-label="Next sibling node" title="Next sibling" disabled={!selectedNodeNavigation.right} onClick={() => navigateInDirection("right")}>→</button>
                    </div>
                  </nav>
                )}
                <button
                  type="button"
                  className="threadCanvasInspectorClose"
                  aria-label="Close node details"
                  onClick={() => {
                    setInspectorOpen(false);
                    setSelectedNodeId(null);
                    setBranchSelection(null);
                    setSelectionPopover(null);
                  }}
                >×</button>
              </header>

              {selectionPopover && (
                <>
                  <div className="threadSelectionHighlightLayer" aria-hidden="true">
                    {selectionPopover.highlightRects.map((rect, index) => (
                      <span
                        key={`${rect.left}:${rect.top}:${index}`}
                        style={{
                          left: rect.left,
                          top: rect.top,
                          width: rect.width,
                          height: rect.height
                        }}
                      />
                    ))}
                  </div>
                  <div
                    className="threadSelectionPopover"
                    style={{ left: selectionPopover.left, top: selectionPopover.top }}
                    onMouseDown={(event) => event.preventDefault()}
                    role="toolbar"
                    aria-label="Ask about selected text"
                  >
                    <button type="button" onClick={() => useSelectionFor("continue")}>
                      Continue branch
                    </button>
                    <span aria-hidden="true" />
                    <button type="button" onClick={() => useSelectionFor("child")}>
                      Create child node
                    </button>
                  </div>
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
                    <span>Branched from selected text</span>
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
                  <div className="threadNodeAnswerEmpty">This node does not have a Codex answer yet.</div>
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
                className="threadModalComposer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!selectedNode) props.onSend(messageDraft, draftKey, null, null);
                  else if (composerMode === "child") props.onSend(messageDraft, draftKey, null, selectedNode.id, branchSelection);
                  else props.onSend(messageDraft, draftKey, null, selectedNode.id, branchSelection, true);
                  setBranchSelection(null);
                  setSelectionPopover(null);
                }}
              >
                <label htmlFor="thread-canvas-question">
                  {!selectedNode
                    ? "Create the root question"
                    : composerMode === "child"
                      ? "Create a child node under"
                      : branchSelection ? "Continue branch from selected text after" : "Continue branch after"}
                  {selectedNode && <strong>{questionSummary(selectedNode.question.content)}</strong>}
                  {selectedNode && composerMode === "child" && (
                    <button
                      type="button"
                      className="threadComposerModeCancel"
                      onClick={() => {
                        setComposerMode("continue");
                        setBranchSelection(null);
                      }}
                    >
                      Continue branch instead
                    </button>
                  )}
                </label>
                {branchSelection && (
                  <div className="threadBranchSelectionQuote">
                    <div>
                      <span>Selected {selectedNode?.messages.find((message) => message.id === branchSelection.sourceMessageId)?.role === "assistant" ? "answer" : "question"}</span>
                      <button type="button" aria-label="Remove selected excerpt" onClick={() => setBranchSelection(null)}>×</button>
                    </div>
                    <blockquote>{branchSelection.text}</blockquote>
                  </div>
                )}
                <textarea
                  id="thread-canvas-question"
                  ref={composerRef}
                  value={messageDraft}
                  onChange={(event) => props.setMessageDraft(draftKey, event.target.value)}
                  placeholder={!selectedNode
                    ? "Ask the first question..."
                    : composerMode === "child" ? "Ask the first question in the new child node..." : "Ask the next question in this branch..."}
                  aria-label={composerMode === "child" ? "Child node question" : "Continue branch from selected node"}
                />
                <div className="threadModalComposerActions">
                  <span>Markdown supported · inherits ancestor context</span>
                  <button
                    type="submit"
                    className="primaryButton"
                    disabled={!messageDraft.trim() || Boolean(selectedNode?.messages.some((message) => message.id.startsWith("pending-")))}
                  >
                    {selectedNode && composerMode === "child" ? "Create child" : selectedNode ? "Continue branch" : "Ask Codex"}
                  </button>
                </div>
              </form>
            </section>
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
      aria-label="Conversation tree position"
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
        <span>Tree position</span>
        <small>{selectedLayout ? `Level ${selectedLayout.depth + 1}` : ""}</small>
        <i aria-hidden="true">{props.collapsed ? "⌄" : "⌃"}</i>
      </button>
      {!props.collapsed && (
        <svg
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          role="img"
          aria-label="Tree overview. The blue node is currently open."
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
                aria-label={`${selected ? "Current node: " : "Open node: "}${questionSummary(item.node.question.content)}`}
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
          <span>{props.root ? "Root" : "Node"}</span>
          <small>{pending ? "Thinking…" : answered ? "Answered" : "Waiting"}</small>
        </span>
        <strong>{questionSummary(props.node.question.content)}</strong>
        <span className="threadCanvasNodeMeta">
          {userTurns} turn{userTurns === 1 ? "" : "s"}
          {props.node.children.length > 0 ? ` · ${props.node.children.length} children` : ""}
          {hasSelectedOrigin ? " · quoted" : ""}
        </span>
      </button>
      <button
        type="button"
        className="threadCanvasNodeAdd"
        aria-label={`Create a child node under ${questionSummary(props.node.question.content)}`}
        title="Create child node"
        onClick={props.onAskChild}
      >
        <span aria-hidden="true">+</span>
        <small>Child</small>
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
            {message.role === "assistant" ? "Codex" : "You"} <time>{formatMessageTime(message.createdAt)}</time>
            {message.role === "assistant" && !message.id.startsWith("pending-") && (
              <button type="button" onClick={() => props.onRetryAssistant(props.threadId, message.id)}>Retry</button>
            )}
          </span>
          {!message.id.startsWith("pending-") && (
            <span className="messageActions">
              {message.role === "user" && <button type="button" onClick={() => props.onEdit(message)}>Edit</button>}
              <button type="button" onClick={() => props.onDeleteMessage(props.threadId, message.id)}>Delete</button>
            </span>
          )}
        </div>
        {props.editingMessage === message.id ? (
          <div>
            <textarea className="editMessageBox" value={props.editText} onChange={(event) => props.setEditText(event.target.value)} />
            <div className="editMessageActions">
              <button type="button" onClick={props.onCancelEdit}>Cancel</button>
              <button type="button" className="primaryButton" onClick={() => props.onSaveEdit(props.threadId, message.id)}>Save</button>
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
