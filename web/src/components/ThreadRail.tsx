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
import { useMessageSelection } from "../hooks/useMessageSelection";
import { renderMarkdown, renderMermaidBlocks, renderMessageMarkdown } from "../markdown";
import {
  THREAD_CANVAS_NODE_HEIGHT,
  THREAD_CANVAS_NODE_WIDTH,
  layoutConversationTree
} from "../thread-canvas";
import { threadNodeDraftKey } from "../thread-drafts";
import {
  buildConversationTree,
  CONVERSATION_NODE_KINDS,
  conversationBreadcrumb,
  conversationNavigation,
  conversationNodeKind,
  conversationNodeStatus,
  defaultConversationRoute,
  flattenConversationTree
} from "../thread-tree";
import type { BranchSelection, ConversationMessageCommand, ConversationNodeKind, DocumentPayload, Message, PermissionOption, PermissionRequest, Thread, ThreadSpatialLayout } from "../types";

const THREAD_FOCUS_NODE_WIDTH = 920;
const THREAD_FOCUS_NODE_HEIGHT = 720;
const ROUTE_CHOICE_REQUIRED = "__route_choice_required__";

const NODE_KIND_META: Record<ConversationNodeKind, { label: string; shortLabel: string }> = {
  question: { label: "问题", shortLabel: "问" },
  idea: { label: "想法", shortLabel: "想" },
  assumption: { label: "假设", shortLabel: "假" },
  evidence: { label: "证据", shortLabel: "证" },
  risk: { label: "风险", shortLabel: "险" },
  decision: { label: "决策", shortLabel: "决" },
  task: { label: "任务", shortLabel: "任" }
};

const NODE_QUICK_ACTIONS = [
  { id: "expand", label: "发散", forceNewBranch: true },
  { id: "critique", label: "审查", forceNewBranch: false },
  { id: "decide", label: "收敛", forceNewBranch: false },
  { id: "task", label: "转任务", forceNewBranch: true }
] as const;

type NodeQuickActionId = typeof NODE_QUICK_ACTIONS[number]["id"];
type ThreadQuestionCommand = Omit<ConversationMessageCommand, "threadId" | "askAgent">;

type ThreadRailProps = {
  documentData: DocumentPayload | null;
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
  onUpdateMessageMeta: (threadId: string, messageId: string, nodeKind: ConversationNodeKind) => void;
  onRetryAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
  onSpatialScroll: (scrollTop: number) => void;
  setEditText: (value: string) => void;
  setMessageDraft: (draftKey: string, value: string) => void;
  onSend: (command: ConversationMessageCommand) => void;
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
            <h2>讨论</h2>
            <p>{props.threads.length} 个文档锚点</p>
          </div>
          <button type="button" className="primaryButton" onClick={props.onAskSelection}>选中文字提问</button>
        </div>
        <div className="threadList threadListSpatial" ref={listRef} onScroll={handleListScroll} onWheel={handleListWheel}>
          {props.threads.length === 0 && <div className="emptyState">暂无讨论。请先在文档中选择文字。</div>}
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
                    title="打开讨论树"
                    onClick={() => openThread(thread)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openThread(thread);
                      }
                    }}
                  >
                    <div className="threadAnchorHeader">
                      <span className="threadCount">{(thread.messages || []).length} 条消息</span>
                      {threadPermissionRequests.length > 0 && <span className="permissionBadge">等待授权</span>}
                    </div>
                    <div className="threadAnchorText">{threadDisplayTitle(thread)}</div>
                    <div className="threadSourceExcerpt">{thread.selectedText || "未保存文档引用"}</div>
                  </div>
                  <div className="threadCardActions">
                    <span className="threadNavControls" aria-label="讨论导航">
                      <button
                        type="button"
                        className="threadNavButton"
                        aria-label="上一个讨论"
                        title="上一个讨论"
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
                        aria-label="下一个讨论"
                        title="下一个讨论"
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
                      aria-label="删除讨论"
                      title="删除讨论"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onDelete(thread);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      删除
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
          documentData={props.documentData}
          thread={openThreadDetail}
          permissionRequests={props.permissionRequests.filter((request) => (
            request.threadId === openThreadDetail.id || (!request.threadId && openThreadDetail.id === props.activeThreadId)
          ))}
          resolvingPermissionIds={props.resolvingPermissionIds}
          editingMessage={props.editingMessage}
          editText={props.editText}
          messageDrafts={props.messageDrafts}
          onClose={() => setOpenThreadId(null)}
          onRevealSource={() => {
            props.onActivate(openThreadDetail);
            setOpenThreadId(null);
          }}
          onEdit={props.onEdit}
          onCancelEdit={props.onCancelEdit}
          onSaveEdit={props.onSaveEdit}
          onUpdateMessageMeta={props.onUpdateMessageMeta}
          onRetryAssistant={props.onRetryAssistant}
          onDeleteMessage={props.onDeleteMessage}
          onResolvePermission={props.onResolvePermission}
          setEditText={props.setEditText}
          setMessageDraft={props.setMessageDraft}
          onSend={props.onSend}
        />,
        document.body
      )}
    </>
  );
}

function ThreadDetailModal(props: {
  documentData: DocumentPayload | null;
  thread: Thread;
  permissionRequests: PermissionRequest[];
  resolvingPermissionIds: Set<string>;
  editingMessage: string | null;
  editText: string;
  messageDrafts: Record<string, string>;
  onClose: () => void;
  onRevealSource: () => void;
  onEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (threadId: string, messageId: string) => void;
  onUpdateMessageMeta: (threadId: string, messageId: string, nodeKind: ConversationNodeKind) => void;
  onRetryAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
  setEditText: (value: string) => void;
  setMessageDraft: (draftKey: string, value: string) => void;
  onSend: (command: ConversationMessageCommand) => void;
}) {
  const modalRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const documentContextRef = useRef<HTMLElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const messageSelectionSurfaceRef = useRef<HTMLDivElement | null>(null);
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
  const [minimapCollapsed, setMinimapCollapsed] = useState(true);
  const [documentContextOpen, setDocumentContextOpen] = useState(true);
  const [isPanning, setIsPanning] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [canvasTransform, setCanvasTransform] = useState({ x: 0, y: 0, scale: 1 });
  const compactFocusLayout = canvasSize.width > 0 && canvasSize.width <= 700;
  const focusNodeWidth = compactFocusLayout
    ? Math.max(320, canvasSize.width - 28)
    : THREAD_FOCUS_NODE_WIDTH;
  const focusNodeHeight = compactFocusLayout
    ? Math.max(520, canvasSize.height - 28)
    : THREAD_FOCUS_NODE_HEIGHT;
  const canvasTransformRef = useRef(canvasTransform);
  const {
    selectionPopover,
    setSelectionPopover,
    selectionComposerRef,
    beginMessageSelection,
    captureMessageSelection,
    clearCapturedMessageSelection
  } = useMessageSelection({
    inspectorRef,
    canvasScaleRef: canvasTransformRef,
    selectedNodeId,
    defaultRouteChoice
  });
  inspectorOpenRef.current = inspectorOpen;
  selectionPopoverOpenRef.current = Boolean(selectionPopover);
  canvasTransformRef.current = canvasTransform;
  const knownNodeIdsRef = useRef(new Set(nodes.map((node) => node.id)));
  const centeredThreadRef = useRef<string | null>(null);
  const overviewTransformRef = useRef<{ x: number; y: number; scale: number } | null>(null);
  const documentAnchorOutdated = useMemo(() => {
    const source = props.thread.selectedText.replace(/\s+/g, " ").trim();
    const content = props.documentData?.content.replace(/\s+/g, " ").trim() || "";
    return Boolean(source && content && !content.includes(source));
  }, [props.documentData?.content, props.thread.selectedText]);
  const documentHtml = useMemo(
    () => props.documentData
      ? renderDocumentContextMarkdown(
        props.documentData.content,
        documentAnchorOutdated ? null : props.thread.anchor.lineStart,
        props.thread.anchor.lineEnd
      )
      : "",
    [documentAnchorOutdated, props.documentData?.content, props.thread.anchor.lineEnd, props.thread.anchor.lineStart]
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const root = documentContextRef.current;
      if (!root || !documentHtml) return;

      const sourceBlocks = [...root.querySelectorAll<HTMLElement>("[data-source-line]")];
      const start = props.thread.anchor.lineStart;
      if (!start) return;

      const target = root.querySelector<HTMLElement>(".threadContextAnchorBlock")
        || sourceBlocks.find((element) => Number(element.dataset.sourceLine) >= start);
      if (target) {
        const rootRect = root.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        root.scrollTop = Math.max(
          0,
          root.scrollTop + targetRect.top - rootRect.top - root.clientHeight * 0.18
        );
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [documentHtml, documentContextOpen, props.thread.anchor.lineEnd, props.thread.anchor.lineStart]);

  useEffect(() => {
    const root = documentContextRef.current;
    if (!root || !documentHtml) return;
    void renderMermaidBlocks(root);
  }, [documentHtml, documentContextOpen]);

  useEffect(() => {
    const knownIds = knownNodeIdsRef.current;
    const addedNodes = nodes.filter((node) => !knownIds.has(node.id));
    knownNodeIdsRef.current = new Set(nodes.map((node) => node.id));
    if (addedNodes.length > 0) {
      const addedNode = addedNodes.at(-1) || null;
      const route = addedNode ? defaultConversationRoute(addedNode) : null;
      setSelectedNodeId(addedNode?.id || null);
      setInsertBeforeNodeId(route?.kind === "choose" ? ROUTE_CHOICE_REQUIRED : route?.insertBeforeNodeId || null);
      clearCapturedMessageSelection();
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
    if (!selectedNodeId) {
      const node = nodes.at(-1) || null;
      const route = node ? defaultConversationRoute(node) : null;
      setInsertBeforeNodeId(route?.kind === "choose" ? ROUTE_CHOICE_REQUIRED : route?.insertBeforeNodeId || null);
      setSelectedNodeId(node?.id || null);
    }
    setInspectorOpen(true);
  }, [inspectorOpen, nodes, props.permissionRequests.length, selectedNodeId]);

  useEffect(() => {
    if (!inspectorOpen || !canvasSize.width || !canvasSize.height) return;
    const selectedLayout = selectedNodeId
      ? canvasLayout.nodes.find((item) => item.node.id === selectedNodeId)
      : null;
    const focusX = selectedLayout?.x || 0;
    const focusY = selectedLayout?.y || 0;
    const scale = clamp(Math.min(
      (canvasSize.width - (compactFocusLayout ? 24 : 56)) / focusNodeWidth,
      (canvasSize.height - (compactFocusLayout ? 32 : 48)) / focusNodeHeight,
      1
    ), 0.35, 1);
    setCanvasTransform({
      x: canvasSize.width / 2 - focusX * scale,
      y: canvasSize.height / 2 - focusY * scale,
      scale
    });
  }, [canvasLayout.nodes, canvasSize, compactFocusLayout, focusNodeHeight, focusNodeWidth, inspectorOpen, selectedNodeId]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (selectionPopoverOpenRef.current) {
          clearCapturedMessageSelection();
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
      if (event.key === "Tab" && modalRef.current) {
        const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])"
        )].filter((element) => element.offsetParent !== null);
        if (focusable.length > 0) {
          const first = focusable[0];
          const last = focusable.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
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
  const selectedNodeKind = selectedNode ? conversationNodeKind(selectedNode) : "question";
  const semanticStats = useMemo(() => conversationSemanticStats(nodes), [nodes]);
  const selectedInsertTarget = selectedNode?.children.find((node) => node.id === insertBeforeNodeId) || null;
  const routeChoiceRequired = insertBeforeNodeId === ROUTE_CHOICE_REQUIRED;
  const lineStart = props.thread.anchor.lineStart;
  const lineEnd = props.thread.anchor.lineEnd;
  const lineLabel = lineStart
    ? `第 ${lineStart}${lineEnd && lineEnd !== lineStart ? `–${lineEnd}` : ""} 行`
    : "未锚定";

  function defaultRouteChoice(nodeId: string, forceNewBranch = false): string | null {
    if (forceNewBranch) return null;
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return null;
    const route = defaultConversationRoute(node);
    return route.kind === "choose" ? ROUTE_CHOICE_REQUIRED : route.insertBeforeNodeId;
  }

  function applyNodeQuickAction(actionId: NodeQuickActionId, forceNewBranch: boolean) {
    if (!selectedNode) return;
    clearCapturedMessageSelection();
    setInsertBeforeNodeId(defaultRouteChoice(selectedNode.id, forceNewBranch));
    props.setMessageDraft(draftKey, promptForNodeQuickAction(actionId, selectedNode));
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openNode(nodeId: string, startComposer = false, forceNewBranch = false) {
    if (!inspectorOpenRef.current) overviewTransformRef.current = canvasTransform;
    setSelectedNodeId(nodeId);
    setInsertBeforeNodeId(defaultRouteChoice(nodeId, forceNewBranch));
    clearCapturedMessageSelection();
    setInspectorOpen(true);
    window.getSelection()?.removeAllRanges();
    if (startComposer) window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openInsertBetween(parentNodeId: string, childNodeId: string) {
    if (!inspectorOpenRef.current) overviewTransformRef.current = canvasTransform;
    setSelectedNodeId(parentNodeId);
    setInsertBeforeNodeId(childNodeId);
    clearCapturedMessageSelection();
    setInspectorOpen(true);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function navigateToNode(nodeId: string | null | undefined) {
    if (!nodeId) return;
    setSelectedNodeId(nodeId);
    setInsertBeforeNodeId(defaultRouteChoice(nodeId));
    clearCapturedMessageSelection();
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
    clearCapturedMessageSelection();
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
    clearCapturedMessageSelection();
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

  function sendQuestion(command: ThreadQuestionCommand) {
    props.onSend({
      ...command,
      threadId: props.thread.id,
      askAgent: true
    });
  }

  function submitSelectionQuestion() {
    if (
      !selectionPopover
      || !selectedNode
      || !selectionPopover.prompt.trim()
      || selectionPopover.insertBeforeNodeId === ROUTE_CHOICE_REQUIRED
    ) return;
    sendQuestion({
      content: selectionPopover.prompt,
      draftKey: null,
      nodeId: null,
      parentMessageId: selectedNode.id,
      branchSelection: {
        sourceMessageId: selectionPopover.sourceMessageId,
        text: selectionPopover.text
      },
      adoptExistingChildren: false,
      insertBeforeNodeId: selectionPopover.insertBeforeNodeId
    });
    clearCapturedMessageSelection();
    window.getSelection()?.removeAllRanges();
  }

  const selectedCanvasItem = selectedNodeId
    ? canvasLayout.nodes.find((item) => item.node.id === selectedNodeId) || null
    : null;
  const ghostNode = (() => {
    if (!inspectorOpen || !messageDraft.trim() || routeChoiceRequired) return null;
    if (!selectedCanvasItem) return { x: 0, y: 0 };
    return {
      x: selectedCanvasItem.x + focusNodeWidth / 2 + 132,
      y: selectedCanvasItem.y
    };
  })();

  return (
    <div className="modalBackdrop threadModalBackdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={modalRef}
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
            <h2 id="thread-modal-title">{threadDisplayTitle(props.thread)}</h2>
          </div>
          <div className="threadModalHeaderActions">
            <button
              type="button"
              className={`threadContextToggle ${documentContextOpen ? "active" : ""}`}
              aria-pressed={documentContextOpen}
              onClick={() => setDocumentContextOpen((current) => !current)}
            >
              <span aria-hidden="true">◫</span>
              {documentContextOpen ? "隐藏文章" : "显示文章"}
            </button>
            <button ref={closeButtonRef} type="button" className="threadModalClose" aria-label="关闭讨论树" onClick={props.onClose}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div className={`threadModalBody ${documentContextOpen ? "" : "contextCollapsed"}`}>
          {documentContextOpen && (
            <aside className="threadDocumentContext" aria-label="文章上下文">
              <header className="threadDocumentContextHeader">
                <div>
                  <span>文章上下文</span>
                  <strong>{props.documentData?.title || "当前文档"}</strong>
                </div>
                <button type="button" onClick={props.onRevealSource}>在编辑器中定位</button>
              </header>
              <div className={`threadContextQuote ${documentAnchorOutdated ? "stale" : ""}`}>
                <div>
                  <span>讨论锚点</span>
                  <small>{documentAnchorOutdated ? `原文已变化 · 上次${lineLabel}` : lineLabel}</small>
                </div>
                <blockquote>{props.thread.selectedText || "未保存引用内容"}</blockquote>
              </div>
              {documentHtml ? (
                <article
                  ref={documentContextRef}
                  className="threadContextDocument preview"
                  dangerouslySetInnerHTML={{ __html: documentHtml }}
                />
              ) : (
                <div className="threadContextEmpty">文章内容暂不可用。</div>
              )}
            </aside>
          )}
          <div
            ref={canvasRef}
            className={`threadModalWorkspace threadCanvasViewport ${isPanning ? "panning" : ""} ${inspectorOpen ? "focusMode" : ""}`}
            aria-label="讨论树画布"
            onWheel={handleCanvasWheel}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={finishCanvasPan}
            onPointerCancel={finishCanvasPan}
          >
          <div className="threadCanvasHint">拖动画布 · 滚轮移动 · ⌘/Ctrl + 滚轮缩放</div>
          <div className="threadCanvasInsightStrip" aria-label="讨论计划摘要">
            <span>任务 {semanticStats.task}</span>
            <span>风险 {semanticStats.risk}</span>
            <span>决策 {semanticStats.decision}</span>
            <span>未答 {semanticStats.unanswered}</span>
          </div>
          <div className="threadCanvasControls" aria-label="画布控制">
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
                  d={`M ${selectedCanvasItem.x + focusNodeWidth / 2} ${selectedCanvasItem.y} C ${selectedCanvasItem.x + focusNodeWidth / 2 + 48} ${selectedCanvasItem.y}, ${ghostNode.x - 150} ${ghostNode.y}, ${ghostNode.x - 105} ${ghostNode.y}`}
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
                    left: item.x - focusNodeWidth / 2,
                    top: item.y - focusNodeHeight / 2,
                    width: focusNodeWidth,
                    height: focusNodeHeight
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
                      {selectedNode && (
                        <div className="threadNodeMetaBar">
                          <label>
                            <span>类型</span>
                            <select
                              value={selectedNodeKind}
                              onChange={(event) => props.onUpdateMessageMeta(
                                props.thread.id,
                                selectedNode.question.id,
                                event.target.value as ConversationNodeKind
                              )}
                            >
                              {CONVERSATION_NODE_KINDS.map((kind) => (
                                <option key={kind} value={kind}>{NODE_KIND_META[kind].label}</option>
                              ))}
                            </select>
                          </label>
                          <div className="threadNodeQuickActions" aria-label="AI 快捷操作">
                            {NODE_QUICK_ACTIONS.map((action) => (
                              <button
                                key={action.id}
                                type="button"
                                onClick={() => applyNodeQuickAction(action.id, action.forceNewBranch)}
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
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
                                clearCapturedMessageSelection();
                                window.getSelection()?.removeAllRanges();
                              }
                            }}
                            placeholder="基于选中内容继续追问…"
                            aria-label="基于选中内容继续追问"
                          />
                          <button
                            type="submit"
                            className="primaryButton"
                            disabled={!selectionPopover.prompt.trim() || selectionPopover.insertBeforeNodeId === ROUTE_CHOICE_REQUIRED}
                          >
                            发送
                          </button>
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
                            {selectedNode.children.length > 1 && (
                              <option value={ROUTE_CHOICE_REQUIRED} disabled>请选择新节点位置…</option>
                            )}
                            {selectedNode.children.map((child) => (
                              <option key={child.id} value={child.id}>
                                {selectedNode.children.length === 1 ? "继续当前路径" : "插入路径"} → {questionSummary(child.question.content)}
                              </option>
                            ))}
                            <option value="">另建分支</option>
                          </select>
                        ) : (
                          <small>创建子节点</small>
                        )}
                      </form>
                    </>
                  )}

                  <div
                    ref={messageSelectionSurfaceRef}
                    className="threadModalContent threadCanvasInspectorContent"
                    onPointerDown={beginMessageSelection}
                    onKeyUp={captureMessageSelection}
                    onScroll={clearCapturedMessageSelection}
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
                      <div className="threadNodeAnswerEmpty">此节点尚未获得 Codex 回答。</div>
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
                      if (routeChoiceRequired) return;
                      if (!selectedNode) {
                        sendQuestion({
                          content: messageDraft,
                          draftKey,
                          nodeId: null,
                          parentMessageId: null
                        });
                      } else {
                        sendQuestion({
                          content: messageDraft,
                          draftKey,
                          nodeId: null,
                          parentMessageId: selectedNode.id,
                          branchSelection: null,
                          adoptExistingChildren: false,
                          insertBeforeNodeId
                        });
                      }
                      clearCapturedMessageSelection();
                    }}
                  >
                    <div className="threadFocusComposerTopline">
                      <label htmlFor="thread-canvas-question">
                        {routeChoiceRequired
                          ? "请选择新节点位置"
                          : selectedInsertTarget
                            ? <>{selectedNode?.children.length === 1 ? "继续当前路径" : "插入路径"} <strong>→ {questionSummary(selectedInsertTarget.question.content)}</strong></>
                            : selectedNode?.children.length
                              ? "从当前节点新建分支"
                              : "创建子节点"}
                      </label>
                      {selectedNode && selectedNode.children.length > 0 && (
                        <select
                          aria-label="追问位置"
                          value={insertBeforeNodeId || ""}
                          onChange={(event) => setInsertBeforeNodeId(event.target.value || null)}
                        >
                          {selectedNode.children.length > 1 && (
                            <option value={ROUTE_CHOICE_REQUIRED} disabled>请选择新节点位置…</option>
                          )}
                          {selectedNode.children.map((child) => (
                            <option key={child.id} value={child.id}>
                              {selectedNode.children.length === 1 ? "继续当前路径" : "插入路径"} → {questionSummary(child.question.content)}
                            </option>
                          ))}
                          <option value="">另建分支</option>
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
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                      placeholder="写下你的追问、判断或下一步任务…"
                      aria-label="继续追问"
                    />
                    <div className="threadModalComposerActions">
                      <span>支持 Markdown · ⌘/Ctrl + Enter 发送 · 自动继承祖先上下文</span>
                      <button
                        type="submit"
                        className="primaryButton"
                        disabled={
                          !messageDraft.trim()
                          || routeChoiceRequired
                          || Boolean(selectedNode?.messages.some((message) => message.id.startsWith("pending-")))
                        }
                      >
                        {routeChoiceRequired
                          ? "选择位置"
                          : selectedInsertTarget
                            ? "继续当前路径"
                            : selectedNode?.children.length
                              ? "创建分支"
                              : "创建子节点"}
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
                  onAskChild={() => openNode(item.node.id, true, true)}
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
                    left: -focusNodeWidth / 2,
                    top: -focusNodeHeight / 2,
                    width: focusNodeWidth,
                    height: focusNodeHeight
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
                      sendQuestion({
                        content: messageDraft,
                        draftKey,
                        nodeId: null,
                        parentMessageId: null
                      });
                    }}
                  >
                    <textarea
                      id="thread-canvas-question"
                      ref={composerRef}
                      value={messageDraft}
                      onChange={(event) => props.setMessageDraft(draftKey, event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                      placeholder="写下第一个问题，建立这棵讨论树…"
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
        aria-label={props.collapsed ? "展开树形位置" : "收起树形位置"}
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
  const status = conversationNodeStatus(props.node);
  const kind = conversationNodeKind(props.node);
  const hasSelectedOrigin = Boolean(messageBranchSelection(props.node.question));
  const statusLabel = {
    unanswered: "未回答",
    thinking: "思考中…",
    answered: "已回答",
    failed: "回答失败"
  }[status];
  return (
    <article
      className={`threadCanvasNode ${props.root ? "root" : ""} ${props.active ? "active" : ""} kind-${kind}`}
      style={{
        left: props.x - THREAD_CANVAS_NODE_WIDTH / 2,
        top: props.y - THREAD_CANVAS_NODE_HEIGHT / 2,
        width: THREAD_CANVAS_NODE_WIDTH,
        height: THREAD_CANVAS_NODE_HEIGHT
      }}
    >
      <button type="button" className="threadCanvasNodeMain" onClick={props.onOpen}>
        <span className="threadCanvasNodeTopline">
          <span className={`threadNodeKindPill kind-${kind}`}>{props.root ? "根" : NODE_KIND_META[kind].shortLabel}</span>
          <small className={status === "failed" ? "error" : ""}>{statusLabel}</small>
        </span>
        <strong>{questionSummary(props.node.question.content)}</strong>
        <span className="threadCanvasNodeMeta">
          {userTurns} 轮
          {` · ${NODE_KIND_META[kind].label}`}
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

function messageBranchSelection(message: Message): BranchSelection | null {
  const value = message.meta?.branchSelection;
  if (!value || typeof value !== "object") return null;
  const sourceMessageId = "sourceMessageId" in value && typeof value.sourceMessageId === "string" ? value.sourceMessageId : "";
  const text = "text" in value && typeof value.text === "string" ? value.text : "";
  return sourceMessageId && text ? { sourceMessageId, text } : null;
}

function conversationSemanticStats(nodes: ReturnType<typeof flattenConversationTree>) {
  const stats: Record<ConversationNodeKind, number> & { unanswered: number } = {
    question: 0,
    idea: 0,
    assumption: 0,
    evidence: 0,
    risk: 0,
    decision: 0,
    task: 0,
    unanswered: 0
  };
  for (const node of nodes) {
    stats[conversationNodeKind(node)] += 1;
    if (conversationNodeStatus(node) === "unanswered") stats.unanswered += 1;
  }
  return stats;
}

function promptForNodeQuickAction(actionId: NodeQuickActionId, node: ReturnType<typeof flattenConversationTree>[number]): string {
  const kindLabel = NODE_KIND_META[conversationNodeKind(node)].label;
  const latestAnswer = node.messages.filter((message) => message.role === "assistant" && !message.error).at(-1)?.content || "";
  const context = [
    `当前节点类型：${kindLabel}`,
    `当前问题：${node.question.content.trim()}`,
    latestAnswer ? `当前回答摘要：${truncatePlainText(latestAnswer, 260)}` : ""
  ].filter(Boolean).join("\n");

  const actionPrompts: Record<NodeQuickActionId, string> = {
    expand: "请基于当前节点发散 3 个值得继续探索的子方向。每个方向说明为什么重要、适合验证什么，以及建议优先级。",
    critique: "请审查当前节点：列出关键假设、主要风险、可能反例、缺失证据，并给出最应该先追问的一个问题。",
    decide: "请把当前节点收敛成一个决策建议：给出推荐选择、理由、取舍、仍不确定的点和下一步动作。",
    task: "请把当前节点转成可执行任务：拆成步骤、验收标准、依赖项、风险和建议负责人角色。"
  };

  return `${actionPrompts[actionId]}\n\n${context}`;
}

function truncatePlainText(content: string, maxLength: number): string {
  const normalized = content.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
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

function threadDisplayTitle(thread: Thread): string {
  const rootQuestion = buildConversationTree(thread.messages)[0]?.question.content;
  return questionSummary(rootQuestion || thread.title || thread.selectedText);
}

function questionSummary(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "未命名问题";
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
}

function renderDocumentContextMarkdown(content: string, lineStart: number | null, lineEnd: number | null): string {
  const html = renderMarkdown(content);
  if (!lineStart || typeof DOMParser === "undefined") return html;

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const end = lineEnd ?? lineStart;
  const candidates = [...parsed.body.querySelectorAll<HTMLElement>("[data-source-line]")].filter((element) => {
    const line = Number(element.dataset.sourceLine);
    return Number.isInteger(line) && line >= lineStart && line <= end;
  });
  const candidateSet = new Set(candidates);
  candidates
    .filter((element) => ![...element.querySelectorAll<HTMLElement>("[data-source-line]")].some((child) => candidateSet.has(child)))
    .forEach((element) => element.classList.add("threadContextAnchorBlock"));
  return parsed.body.innerHTML;
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
        <span>权限请求</span>
        <time>{formatMessageTime(props.request.createdAt)}</time>
      </div>
      <div className="permissionRequestTitle">{props.request.title}</div>
      {props.request.rawInput && <div className="permissionRequestDetail">{props.request.rawInput}</div>}
      <div className="permissionRequestActions">
        {allowOnce && (
          <button type="button" className="primaryButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, allowOnce.optionId)}>
            允许一次
          </button>
        )}
        {allowAlways && (
          <button type="button" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, allowAlways.optionId)}>
            始终允许
          </button>
        )}
        {rejectOnce && (
          <button type="button" className="dangerButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, rejectOnce.optionId)}>
            拒绝一次
          </button>
        )}
        {rejectAlways && (
          <button type="button" className="dangerButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, rejectAlways.optionId)}>
            始终拒绝
          </button>
        )}
        {fallbackOptions.map((option) => (
          <button key={option.optionId} type="button" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, option.optionId)}>
            {labelForPermissionOption(option)}
          </button>
        ))}
        <button type="button" className="ghostButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, null)}>
          取消
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
  const knownLabels: Record<string, string> = {
    allow_once: "允许一次",
    allow_always: "始终允许",
    reject_once: "拒绝一次",
    reject_always: "始终拒绝"
  };
  const knownLabel = knownLabels[option.kind];
  if (knownLabel) return knownLabel;
  const label = option.name.trim();
  if (label) return label;
  return option.kind.replace(/_/g, " ");
}

function formatMessageTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
