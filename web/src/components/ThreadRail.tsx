import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent
} from "react";
import { createPortal } from "react-dom";
import { activeAgentRunMessage, agentRunForMessage } from "../agent-run";
import { agentSettingsSummary } from "../agent-settings-view";
import { useMessageSelection } from "../hooks/useMessageSelection";
import { AgentRunTimeline } from "./AgentRunTimeline";
import { useRenderedPreview } from "../hooks/useRenderedPreview";
import { renderMessageMarkdown } from "../markdown";
import { nodeQuickActions } from "../quick-actions";
import { formatRelativeTime } from "../relative-time";
import {
  THREAD_CANVAS_NODE_HEIGHT,
  THREAD_CANVAS_NODE_WIDTH,
  layoutConversationTree,
  layoutConversationTreeWithDraft
} from "../thread-canvas";
import { threadNodeDraftKey } from "../thread-drafts";
import { findPreviewBlockForThread } from "../thread-spatial";
import {
  buildConversationTree,
  CONVERSATION_NODE_KINDS,
  conversationBreadcrumb,
  conversationNavigation,
  conversationNodeCanBranch,
  conversationNodeKind,
  conversationNodeStatus,
  flattenConversationTree
} from "../thread-tree";
import type { AgentSettingsPayload, BranchSelection, ConversationMessageCommand, ConversationNodeKind, DocumentPayload, Message, NodeQuickAction, PermissionRequest, Thread, ThreadSpatialLayout } from "../types";
import { PermissionRequestPanel } from "./PermissionRequestPanel";
import { ReferenceComposer, ReferenceHistory } from "./ReferenceComposer";
import { IndependentDiscussion, type DiscussionPreparation, type IndependentDiscussionRequest } from "./IndependentDiscussion";
import { appendReference, discussionSources, messageReferences, snapshotReference, selectedReferenceRange, REFERENCE_DRAG_TYPE } from "../discussion-references";
import type { ReferenceSnapshot } from "../types";

import { DiscussionAnswerActions } from "./DiscussionAnswerActions";
import { DiscussionComparison, DiscussionContentTabs, DiscussionNodeReader, DiscussionReviewView, DiscussionViewSwitcher } from "./DiscussionViews";
import { locateReferenceSource, useDiscussionWorkspace, type DiscussionWorkspaceActions } from "./DiscussionWorkspaceContext";
import { comparisonPair, nodeOutcomeCounts, readWorkspaceDraft, reframeCanvas, saveWorkspaceDraft, stableMessage, synthesisSources, workspaceEscapeTarget, workspaceStorageKey, type DiscussionPosition, type DiscussionView } from "./discussion-view-state";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { resolveThreadAnchor } from "../thread-anchors";
const discussionViewStyles = new URL("./discussion-views.css", import.meta.url).href;

const THREAD_PANE_DIVIDER_WIDTH = 6;

const NODE_KIND_META: Record<ConversationNodeKind, { label: string; shortLabel: string }> = {
  question: { label: "问题", shortLabel: "问" },
  idea: { label: "想法", shortLabel: "想" },
  assumption: { label: "假设", shortLabel: "假" },
  evidence: { label: "证据", shortLabel: "证" },
  risk: { label: "风险", shortLabel: "险" },
  decision: { label: "决策", shortLabel: "决" },
  task: { label: "任务", shortLabel: "任" }
};

type NodeCreationMode = "child" | "branch";
type ThreadQuestionCommand = Omit<ConversationMessageCommand, "threadId" | "askAgent">;
type ReferenceDraftProps = {
  referenceDrafts?: Record<string, ReferenceSnapshot[]>;
  setReferenceDraft?: (key: string, references: ReferenceSnapshot[]) => void;
  sendErrors?: Record<string, string>;
};

type ThreadRailProps = ReferenceDraftProps & {
  documentData: DocumentPayload | null;
  agentSettings: AgentSettingsPayload | null;
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
  onRequestAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
  onSpatialScroll: (scrollTop: number) => void;
  setEditText: (value: string) => void;
  setMessageDraft: (draftKey: string, value: string) => void;
  onSend: (command: ConversationMessageCommand) => Promise<boolean>;
  onCreateIndependent?: (source: Thread, title: string, scope: "full" | "references") => Promise<Thread>;
};

export function ThreadRail(props: ThreadRailProps) {
  const workspace = useDiscussionWorkspace();
  const handledNavigationRef = useRef<number | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<DiscussionWorkspaceActions["navigation"] | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const applyingScrollRef = useRef(false);
  const applyingScrollFrameRef = useRef<number | null>(null);
  const scrollPositionRef = useRef(0);
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [railViewportHeight, setRailViewportHeight] = useState(0);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [referenceTarget, setReferenceTarget] = useState<ReferenceSnapshot | null>(null);

  useEffect(() => {
    const target = workspace?.navigation;
    if (!target || handledNavigationRef.current === target.nonce || !props.threads.some((thread) => thread.id === target.threadId)) return;
    handledNavigationRef.current = target.nonce;
    setReferenceTarget(target.reference || null);
    setNavigationTarget(target);
    setOpenThreadId(target.threadId);
  }, [workspace?.navigation, props.threads]);

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
    setNavigationTarget(null);
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
          <button
            type="button"
            className="primaryButton"
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onAskSelection}
          >
            选中文字提问
          </button>
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
                      disabled={Boolean(workspace?.busy)}
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
          key={openThreadDetail.id}
          documentData={props.documentData}
          agentSettings={props.agentSettings}
          thread={openThreadDetail}
          referenceTarget={referenceTarget}
          navigationTarget={navigationTarget}
          onLocateReference={(reference) => locateReferenceSource(reference, props.documentData?.path, {
            preview: (reference) => workspace?.previewReference?.(reference),
            locate: (reference) => {
              setNavigationTarget(null);
              setReferenceTarget({ ...reference });
              if (reference.threadId) setOpenThreadId(reference.threadId);
            }
          })}
          threads={props.threads}
          onOpenThread={(threadId) => { setNavigationTarget(null); setReferenceTarget(null); setOpenThreadId(threadId); }}
          referenceDrafts={props.referenceDrafts}
          sendErrors={props.sendErrors}
          setReferenceDraft={props.setReferenceDraft}
          onStartIndependent={props.onCreateIndependent ? async (request) => {
            const thread = await props.onCreateIndependent!(openThreadDetail, questionSummary(request.content), request.scope);
            const key = threadNodeDraftKey(thread.id, null);
            props.setMessageDraft(key, request.content);
            props.setReferenceDraft?.(key, request.references);
            setNavigationTarget(null);
            setReferenceTarget(null);
            setOpenThreadId(thread.id);
            void props.onSend({ threadId: thread.id, content: request.content, references: request.references, draftKey: key, askAgent: true, parentMessageId: null, nodeId: null });
          } : undefined}
          onOpenSource={openThreadDetail.sourceThreadId && props.threads.some((thread) => thread.id === openThreadDetail.sourceThreadId)
            ? () => { setNavigationTarget(null); setReferenceTarget(null); setOpenThreadId(openThreadDetail.sourceThreadId!); } : undefined}
          permissionRequests={props.permissionRequests.filter((request) => (
            request.threadId === openThreadDetail.id || (!request.threadId && openThreadDetail.id === props.activeThreadId)
          ))}
          resolvingPermissionIds={props.resolvingPermissionIds}
          editingMessage={props.editingMessage}
          editText={props.editText}
          messageDrafts={props.messageDrafts}
          onClose={() => { setNavigationTarget(null); setOpenThreadId(null); }}
          onRevealSource={() => {
            props.onActivate(openThreadDetail);
            setOpenThreadId(null);
          }}
          onEdit={props.onEdit}
          onCancelEdit={props.onCancelEdit}
          onSaveEdit={props.onSaveEdit}
          onUpdateMessageMeta={props.onUpdateMessageMeta}
          onRetryAssistant={props.onRetryAssistant}
          onRequestAssistant={props.onRequestAssistant}
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

export function ThreadDetailModal(props: ReferenceDraftProps & {
  documentData: DocumentPayload | null;
  agentSettings: AgentSettingsPayload | null;
  thread: Thread;
  threads?: Thread[];
  onStartIndependent?: (request: IndependentDiscussionRequest) => Promise<void>;
  onOpenSource?: () => void;
  onOpenThread?: (threadId: string) => void;
  referenceTarget?: ReferenceSnapshot | null;
  navigationTarget?: DiscussionWorkspaceActions["navigation"] | null;
  onLocateReference?: (reference: ReferenceSnapshot) => void;
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
  onRequestAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
  setEditText: (value: string) => void;
  setMessageDraft: (draftKey: string, value: string) => void;
  onSend: (command: ConversationMessageCommand) => Promise<boolean>;
}) {
  const workspace = useDiscussionWorkspace();
  useLayoutEffect(() => {
    workspace?.onDiscussionVisibilityChange?.(true);
    return () => workspace?.onDiscussionVisibilityChange?.(false);
  }, [workspace?.onDiscussionVisibilityChange]);
  const storageKey = workspaceStorageKey(props.documentData?.path, props.thread.id);
  const [savedPosition] = useState(() => readWorkspaceDraft<DiscussionPosition>(storageKey));
  const [view, setView] = useState<DiscussionView>(savedPosition?.view || "discussion");
  const previousViewRef = useRef<DiscussionView>("discussion");
  const [selecting, setSelecting] = useState(savedPosition?.selecting || false);
  const [comparisonIds, setComparisonIds] = useState<string[]>(savedPosition?.selection || []);
  const [pair, setPair] = useState<[string, string]>(savedPosition?.pair || ["", ""]);
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(savedPosition?.pinnedNodeId || null);
  const [mobileTab, setMobileTab] = useState<"work" | "reference">("work");
  const [nodeSearch, setNodeSearch] = useState("");
  const [preparation, setPreparation] = useState<DiscussionPreparation | undefined>();
  const scrollPositions = useRef<Record<string, number>>(savedPosition?.scroll || {});
  const modalRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const modalBodyRef = useRef<HTMLDivElement | null>(null);
  const documentContextRef = useRef<HTMLElement | null>(null);
  const documentReferenceRef = useRef<ReferenceSnapshot | null>(null);
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
  const paneResizeRef = useRef<{
    divider: "document-content" | "content-tree";
    pointerId: number;
  } | null>(null);
  const paneWidthsCustomizedRef = useRef(Boolean(savedPosition?.paneWidths.document));
  const tree = useMemo(() => buildConversationTree(props.thread.messages), [props.thread.messages]);
  const nodes = useMemo(() => flattenConversationTree(tree), [tree]);
  const canvasLayout = useMemo(() => layoutConversationTree(tree), [tree]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => savedPosition ? savedPosition.selectedNodeId : tree[0]?.id || null);
  const [inspectorOpen, setInspectorOpen] = useState(() => savedPosition?.inspectorOpen ?? tree.length > 0);
  const [contentPaneElement, setContentPaneElement] = useState<HTMLElement | null>(null);
  const [documentContextOpen, setDocumentContextOpen] = useState(savedPosition?.documentOpen ?? true);
  const [isPanning, setIsPanning] = useState(false);
  const [selectionSending, setSelectionSending] = useState(false);
  const [independentOpen, setIndependentOpen] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [resizingPane, setResizingPane] = useState<"document-content" | "content-tree" | null>(null);
  const [paneWidths, setPaneWidths] = useState(savedPosition?.paneWidths || { document: 0, content: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [canvasTransform, setCanvasTransform] = useState(savedPosition?.transform || { x: 0, y: 0, scale: 1 });
  const contentScaleRef = useRef({ scale: 1 });
  const {
    selectionPopover,
    setSelectionPopover,
    selectionComposerRef,
    beginMessageSelection,
    captureMessageSelection,
    clearCapturedMessageSelection
  } = useMessageSelection({
    inspectorRef,
    canvasScaleRef: contentScaleRef,
    selectedNodeId
  });
  const selectionPopoverRef = useRef(selectionPopover);
  selectionPopoverRef.current = selectionPopover;
  inspectorOpenRef.current = inspectorOpen;
  selectionPopoverOpenRef.current = Boolean(selectionPopover);
  const knownNodeIdsRef = useRef(new Set(nodes.map((node) => node.id)));
  useEffect(() => {
    const target = props.navigationTarget;
    if (!target || target.threadId !== props.thread.id) return;
    setView("discussion");
    setMobileTab("work");
    setSelectedNodeId(target.nodeId);
    setInspectorOpen(true);
    clearCapturedMessageSelection();
    if (target.focusComposer === false) return;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [props.navigationTarget?.nonce, props.thread.id]);
  useEffect(() => {
    const reference = props.referenceTarget;
    if (!reference) return;
    if (reference.documentPath !== props.documentData?.path) { documentReferenceRef.current = null; return; }
    if (reference.kind === "document") {
      documentReferenceRef.current = reference;
      setDocumentContextOpen(true);
      const frame = window.requestAnimationFrame(scrollDocumentContextToAnchor);
      return () => window.cancelAnimationFrame(frame);
    }
    const source = props.thread.messages.find((message) => message.id === reference.messageId);
    if (source) {
      setSelectedNodeId(source.nodeId || source.id);
      setInspectorOpen(true);
    }
  }, [props.referenceTarget, props.documentData?.path]);
  const savedViewport = savedPosition?.viewport;
  const hasSavedViewport = Boolean(savedViewport && Number.isFinite(savedViewport.width) && savedViewport.width > 0 && Number.isFinite(savedViewport.height) && savedViewport.height > 0);
  const canvasInitializedRef = useRef(hasSavedViewport);
  const canvasViewportRef = useRef(hasSavedViewport ? savedViewport! : null);
  const centeredNodeRef = useRef<string | null>(savedPosition?.selectedNodeId || null);
  const overviewTransformRef = useRef<{ x: number; y: number; scale: number } | null>(hasSavedViewport ? savedPosition?.overviewTransform || null : null);
  const positionRef = useRef<DiscussionPosition | null>(null);
  positionRef.current = { view, selectedNodeId, inspectorOpen, pinnedNodeId, selection: comparisonIds, selecting, pair, documentOpen: documentContextOpen,
    transform: canvasTransform, overviewTransform: overviewTransformRef.current, paneWidths, scroll: scrollPositions.current, viewport: canvasViewportRef.current || undefined };
  function savePosition() { if (positionRef.current) saveWorkspaceDraft(storageKey, { ...positionRef.current, viewport: canvasViewportRef.current || undefined }); }
  useEffect(savePosition, [view, selectedNodeId, inspectorOpen, pinnedNodeId, comparisonIds, selecting, pair, documentContextOpen, canvasTransform, paneWidths]);
  useEffect(() => () => savePosition(), [storageKey]);
  useEffect(() => {
    const ids = new Set(nodes.map((node) => node.id));
    setComparisonIds((current) => current.every((id) => ids.has(id)) ? current : current.filter((id) => ids.has(id)));
    setPinnedNodeId((current) => current && !ids.has(current) ? null : current);
    if (positionRef.current?.view === "compare" && positionRef.current.selection.filter((id) => ids.has(id)).length < 2) setView("discussion");
  }, [nodes]);
  useLayoutEffect(() => {
    if (messageSelectionSurfaceRef.current?.clientHeight) messageSelectionSurfaceRef.current.scrollTop = scrollPositions.current[`work:${selectedNodeId}`] || 0;
    if (documentContextRef.current?.clientHeight) scrollDocumentContextToAnchor();
  }, [selectedNodeId, contentPaneElement, inspectorOpen, view, mobileTab, pinnedNodeId, documentContextOpen]);
  const documentContent = props.documentData?.content ?? null;
  const renderedDocumentContent = documentContextOpen ? documentContent : null;
  const documentPreviewThreads = useMemo(() => [props.thread], [props.thread]);

  useRenderedPreview({
    previewRef: documentContextRef,
    content: renderedDocumentContent,
    threads: documentPreviewThreads,
    activeThreadId: props.thread.id,
    onActivateThread: () => undefined,
    onOpenDiagram: () => undefined,
    onRendered: scrollDocumentContextToAnchor
  });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollDocumentContextToAnchor();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [documentContent, documentContextOpen, selectedNodeId]);

  useEffect(() => {
    const knownIds = knownNodeIdsRef.current;
    const addedNodes = nodes.filter((node) => !knownIds.has(node.id));
    knownNodeIdsRef.current = new Set(nodes.map((node) => node.id));
    if (addedNodes.length > 0) {
      const addedNode = addedNodes.at(-1) || null;
      setSelectedNodeId(addedNode?.id || null);
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

  useLayoutEffect(() => {
    const body = modalBodyRef.current;
    if (!body) return;
    const updateWidths = () => {
      if (!body.clientWidth) return;
      setPaneWidths((current) => paneWidthsCustomizedRef.current
        ? fitThreadPaneWidths(body.clientWidth, current, documentContextOpen)
        : defaultThreadPaneWidths(body.clientWidth, documentContextOpen));
    };
    updateWidths();
    const observer = new ResizeObserver(updateWidths);
    observer.observe(body);
    return () => observer.disconnect();
  }, [documentContextOpen]);

  useEffect(() => {
    if (props.permissionRequests.length === 0 || inspectorOpen) return;
    if (!selectedNodeId) {
      const node = nodes.at(-1) || null;
      setSelectedNodeId(node?.id || null);
    }
    setInspectorOpen(true);
  }, [inspectorOpen, nodes, props.permissionRequests.length, selectedNodeId]);

  useLayoutEffect(() => {
    // Hidden views measure zero; retain the last visible viewport until they return.
    if (!canvasSize.width || !canvasSize.height) return;
    const selectedLayout = selectedNodeId
      ? canvasLayout.nodes.find((item) => item.node.id === selectedNodeId)
      : null;
    const center = !canvasInitializedRef.current
      ? selectedLayout || { x: 0, y: 0 }
      : centeredNodeRef.current !== selectedNodeId ? selectedLayout || undefined : undefined;
    const previous = canvasViewportRef.current;
    if (overviewTransformRef.current) overviewTransformRef.current = reframeCanvas(overviewTransformRef.current, previous, canvasSize);
    setCanvasTransform((current) => reframeCanvas(current, previous, canvasSize, center));
    canvasViewportRef.current = canvasSize;
    canvasInitializedRef.current = true;
    centeredNodeRef.current = selectedNodeId;
  }, [canvasLayout.nodes, canvasSize.height, canvasSize.width, selectedNodeId]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || [...document.querySelectorAll<HTMLElement>("[data-discussion-overlay]")].some((element) => element.getClientRects().length > 0)) return;
      if (event.key === "Escape") {
        const disclosure = event.target instanceof Element ? event.target.closest("details[open]") : null;
        if (disclosure instanceof HTMLDetailsElement) { event.preventDefault(); disclosure.open = false; disclosure.querySelector("summary")?.focus(); return; }
        event.preventDefault();
        const target = workspaceEscapeTarget(selectionPopoverOpenRef.current, positionRef.current?.selecting || false, positionRef.current?.view || "discussion");
        if (target === "selection") {
          clearCapturedMessageSelection();
          window.getSelection()?.removeAllRanges();
          return;
        }
        if (target === "multiselect") { setSelecting(false); return; }
        if (target === "view") { changeView(positionRef.current?.view === "review" ? previousViewRef.current : "discussion"); return; }
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
        || positionRef.current?.view === "compare"
        || positionRef.current?.view === "review"
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

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) || null;
  const activeRunMessage = selectedNode ? activeAgentRunMessage(selectedNode.messages) : null;
  const nodeCreationMode: NodeCreationMode = selectedNode && conversationNodeCanBranch(selectedNode)
    ? "branch"
    : "child";
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
  const draftReferences = props.referenceDrafts?.[draftKey] || [];
  const referenceComposer = props.documentData && props.setReferenceDraft ? <>
    <ReferenceComposer key={draftKey} document={props.documentData} threads={props.threads || [props.thread]}
      references={draftReferences} onChange={(references) => props.setReferenceDraft?.(draftKey, references)}
      onLocate={props.onLocateReference}
      scope={props.thread.contextScope} selectedText={props.thread.selectedText} inheritsHistory={Boolean(selectedNode)} history={selectedNodeBreadcrumb}
      selectionUnavailable={Boolean(props.thread.orphaned || (props.thread.selectedText && !resolveThreadAnchor(props.documentData.content, props.thread)))} />
    {props.sendErrors?.[draftKey] && <p className="workbenchError" role="alert">{props.sendErrors[draftKey]}</p>}
    {referenceError && <p className="workbenchError" role="alert">{referenceError}</p>}
  </> : null;
  const canvasDraftPreview = useMemo(() => (
    inspectorOpen && messageDraft.trim()
      ? layoutConversationTreeWithDraft(tree, selectedNodeId)
      : null
  ), [inspectorOpen, messageDraft, selectedNodeId, tree]);
  const displayedCanvasLayout = canvasDraftPreview?.layout || canvasLayout;
  const ghostNode = canvasDraftPreview?.draftNode || null;
  const selectedNodeOrigin = selectedNode ? messageBranchSelection(selectedNode.question) : null;
  const selectedNodeKind = selectedNode ? conversationNodeKind(selectedNode) : "question";
  const effectiveAgentSettings = agentSettingsSummary(props.agentSettings);
  const quickActions = nodeQuickActions(props.agentSettings);
  const unansweredCount = nodes.filter((node) => conversationNodeStatus(node) === "unanswered").length;
  const validComparisonIds = comparisonIds.filter((id) => nodes.some((node) => node.id === id));
  const pinnedNode = nodes.find((node) => node.id === pinnedNodeId) || null;
  const canCompare = validComparisonIds.length >= 2;
  const canSynthesize = canCompare && !synthesisSources(props.thread, validComparisonIds).generating;
  const relatedThreads = (props.threads || []).filter((thread) => thread.sourceThreadId === props.thread.id);
  const orphaned = Boolean(props.thread.orphaned || (props.documentData && props.thread.selectedText && !resolveThreadAnchor(props.documentData.content, props.thread)));
  function changeView(next: DiscussionView) {
    const current = positionRef.current;
    if (next === "compare" && (current?.selection.length || 0) < 2) return;
    clearCapturedMessageSelection();
    if (next === "review" && workspace?.openResults) { workspace.openResults(props.thread.id); return; }
    if (next === "review" && current?.view !== "review") previousViewRef.current = current?.view || "discussion";
    if (next === "overview" && current?.view !== "overview" && overviewTransformRef.current) {
      setCanvasTransform(overviewTransformRef.current);
    } else if (current?.view === "overview" && next !== "overview") {
      overviewTransformRef.current = current.transform;
    }
    setView(next);
    setMobileTab("work");
  }
  function toggleComparison(nodeId: string) {
    setSelecting(true);
    setComparisonIds((current) => current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]);
  }
  function prepareComparison(mode: DiscussionPreparation["mode"], ids = validComparisonIds) {
    const plan = synthesisSources(props.thread, ids);
    if (plan.selected.length < 2 || plan.generating) return;
    setPreparation({ mode, nodeIds: [...ids] });
    setIndependentOpen(true);
  }
  function applyNodeQuickAction(action: NodeQuickAction) {
    if (!selectedNode) return;
    clearCapturedMessageSelection();
    props.setMessageDraft(draftKey, promptForNodeQuickAction(action.prompt));
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openNode(nodeId: string, startComposer = false) {
    documentReferenceRef.current = null;
    if (!inspectorOpenRef.current || view === "overview") overviewTransformRef.current = canvasTransform;
    if (view === "compare" || view === "overview" || view === "review") setView("discussion");
    setMobileTab("work");
    setSelectedNodeId(nodeId);
    clearCapturedMessageSelection();
    setInspectorOpen(true);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => {
      scrollDocumentContextToAnchor();
      if (startComposer) composerRef.current?.focus();
    });
  }

  function navigateToNode(nodeId: string | null | undefined) {
    documentReferenceRef.current = null;
    if (!nodeId) return;
    setSelectedNodeId(nodeId);
    clearCapturedMessageSelection();
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => {
      scrollDocumentContextToAnchor();
      if (messageSelectionSurfaceRef.current) messageSelectionSurfaceRef.current.scrollTop = scrollPositions.current[`work:${nodeId}`] || 0;
    });
  }

  function scrollDocumentContextToAnchor() {
    const root = documentContextRef.current;
    if (!root?.clientHeight || !props.documentData?.content) return;
    const reference = documentReferenceRef.current;
    if (!reference && scrollPositions.current.document !== undefined) { root.scrollTop = scrollPositions.current.document; return; }
    const referenceBlock = reference ? [...root.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")]
      .find((element) => Number(element.dataset.sourceStart) <= reference.start && Number(element.dataset.sourceEnd) > reference.start) : null;
    const target = referenceBlock || root.querySelector<HTMLElement>(
      `[data-preview-thread-id~="${CSS.escape(props.thread.id)}"]`
    )
      || findPreviewBlockForThread(root, props.thread, props.documentData.content);
    if (!target) return;

    const rootRect = root.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    root.scrollTop = Math.max(
      0,
      root.scrollTop + targetRect.top - rootRect.top - root.clientHeight * 0.18
    );
  }

  function navigateInDirection(direction: keyof typeof selectedNodeNavigation) {
    navigateToNode(selectedNodeNavigation[direction]?.id);
  }

  function closeFocusedNode() {
    setInspectorOpen(false);
    setSelectedNodeId(null);
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
    clearCapturedMessageSelection();
    setInspectorOpen(true);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function resetView() {
    setCanvasTransform({ x: canvasSize.width / 2, y: canvasSize.height / 2, scale: 1 });
  }

  function fitTree() {
    if (displayedCanvasLayout.nodes.length === 0 && !ghostNode) {
      resetView();
      return;
    }
    const width = Math.max(1, displayedCanvasLayout.bounds.right - displayedCanvasLayout.bounds.left);
    const height = Math.max(1, displayedCanvasLayout.bounds.bottom - displayedCanvasLayout.bounds.top);
    const scale = clamp(Math.min((canvasSize.width - 120) / width, (canvasSize.height - 140) / height, 1.15), 0.35, 1.15);
    const centerX = (displayedCanvasLayout.bounds.left + displayedCanvasLayout.bounds.right) / 2;
    const centerY = (displayedCanvasLayout.bounds.top + displayedCanvasLayout.bounds.bottom) / 2;
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
    if ((event.target as HTMLElement).closest(".threadCanvasFocusNode, .threadCanvasControls, .discussionNodeReader")) return;
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

  function beginPaneResize(
    event: ReactPointerEvent<HTMLDivElement>,
    divider: "document-content" | "content-tree"
  ) {
    if (event.button !== 0) return;
    paneWidthsCustomizedRef.current = true;
    paneResizeRef.current = { divider, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingPane(divider);
  }

  function handlePaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = paneResizeRef.current;
    const body = modalBodyRef.current;
    if (!resize || !body || resize.pointerId !== event.pointerId) return;
    const rect = body.getBoundingClientRect();
    const pointerX = clamp(event.clientX - rect.left, 0, rect.width);
    setPaneWidths((current) => {
      const next = { ...current };
      if (resize.divider === "document-content") {
        next.document = pointerX;
      } else {
        next.content = pointerX
          - (documentContextOpen ? current.document + THREAD_PANE_DIVIDER_WIDTH : 0);
      }
      return fitThreadPaneWidths(rect.width, next, documentContextOpen);
    });
  }

  function finishPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (paneResizeRef.current?.pointerId !== event.pointerId) return;
    paneResizeRef.current = null;
    setResizingPane(null);
  }

  function resizePaneWithKeyboard(
    divider: "document-content" | "content-tree",
    delta: number
  ) {
    const width = modalBodyRef.current?.clientWidth || 0;
    paneWidthsCustomizedRef.current = true;
    setPaneWidths((current) => fitThreadPaneWidths(width, {
      document: current.document + (divider === "document-content" ? delta : 0),
      content: current.content + (divider === "content-tree" ? delta : 0)
    }, documentContextOpen));
  }

  function sendQuestion(command: ThreadQuestionCommand): Promise<boolean> {
    return props.onSend({
      ...command,
      references: command.draftKey ? draftReferences : command.references,
      threadId: props.thread.id,
      askAgent: true
    });
  }

  async function quoteMessage(messageId: string, text?: string, threadId = props.thread.id) {
    if (!props.documentData || !props.setReferenceDraft) return;
    setReferenceError("");
    try {
      const sourceThread = (props.threads || [props.thread]).find((thread) => thread.id === threadId);
      if (!sourceThread?.messages.some((message) => message.id === messageId && stableMessage(message))) throw new Error("来源尚未完成或已不可用。");
      const source = discussionSources(props.documentData, props.threads || [props.thread]).find((item) => item.messageId === messageId && item.threadId === threadId);
      if (!source) throw new Error("来源尚未完成或已不可用。");
      const range = selectedReferenceRange(source, text);
      const reference = await snapshotReference(source, range.start, range.end);
      const next = appendReference(draftReferences, reference);
      if (next.length > 24 || next.reduce((sum, item) => sum + item.content.length, 0) > 160_000) throw new Error("引用资料过多，请缩小范围或移除已有引用。");
      props.setReferenceDraft(draftKey, next);
      clearCapturedMessageSelection();
      composerRef.current?.focus();
    } catch (error) { setReferenceError(error instanceof Error ? error.message : String(error)); }
  }

  async function submitSelectionQuestion() {
    if (
      !selectionPopover
      || !selectedNode
      || !selectionPopover.prompt.trim()
      || selectionSending
    ) return;
    const submittedSelection = selectionPopover;
    setSelectionSending(true);
    try {
      const sent = await sendQuestion({
        content: selectionPopover.prompt,
        draftKey: null,
        nodeId: null,
        parentMessageId: selectedNode.id,
        branchSelection: {
          sourceMessageId: selectionPopover.sourceMessageId,
          text: selectionPopover.text
        }
      });
      if (!sent || selectionPopoverRef.current !== submittedSelection) return;
      clearCapturedMessageSelection();
      window.getSelection()?.removeAllRanges();
    } finally {
      setSelectionSending(false);
    }
  }

  return (
    <div className="modalBackdrop threadModalBackdrop" role="presentation" onMouseDown={props.onClose}>
      <link rel="stylesheet" href={discussionViewStyles} precedence="discussion-views" />
      <section
        ref={modalRef}
        className={`threadModal discussionWorkspace view-${view}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-modal-title"
        inert={independentOpen}
        onDragOver={(event) => {
          if (event.target instanceof HTMLTextAreaElement && event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!(event.target instanceof HTMLTextAreaElement)) return;
          const data = event.dataTransfer.getData(REFERENCE_DRAG_TYPE);
          if (!data) return;
          event.preventDefault();
          try {
            const input = JSON.parse(data);
            if (typeof input.messageId !== "string" || typeof input.threadId !== "string" || typeof input.text !== "string") return;
            void quoteMessage(input.messageId, input.text, input.threadId);
          } catch { setReferenceError("拖入的引用无效，请通过‘添加引用’选择来源。"); }
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="threadModalHeader">
          <div className="threadModalHeading">
            <h2 id="thread-modal-title">{threadDisplayTitle(props.thread)}</h2>
          </div>
          <div className="threadModalHeaderActions">
            {props.thread.independent && <span className="independentBadge">独立讨论</span>}
            {props.onOpenSource && <button type="button" className="threadContextToggle" onClick={props.onOpenSource}>来源讨论 ↗</button>}
            {props.thread.sourceThreadId && !props.onOpenSource && <span className="contextToken">来源讨论已删除</span>}
            {props.onStartIndependent && <button type="button" className="threadContextToggle" disabled={Boolean(activeAgentRunMessage(props.thread.messages))} onClick={() => { setPreparation(undefined); setIndependentOpen(true); }}>开启独立讨论</button>}
            {relatedThreads.length > 0 && <details className="discussionRelated"><summary>相关讨论 {relatedThreads.length}</summary>
              {relatedThreads.map((thread) => <button type="button" key={thread.id} disabled={!props.onOpenThread} onClick={() => props.onOpenThread?.(thread.id)}>{thread.title} ↗</button>)}
            </details>}
            {orphaned && <span className="discussionOrphan">原文位置已变化 <button type="button" disabled={!workspace?.reanchor || workspace.busy} title="先在当前文档选中要关联的原文" onClick={() => workspace?.reanchor?.(props.thread)}>重新关联原文</button></span>}
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
        <WorkspaceNavigation placement="discussion" />
        <div className="discussionWorkspaceToolbar">
          <DiscussionViewSwitcher view={view} onChange={changeView} canCompare={canCompare} />
          <button type="button" aria-pressed={selecting} onClick={() => setSelecting(!selecting)}>选择节点</button>
          <label className="discussionNodeJump">工作节点<select aria-label="选择工作节点" value={selectedNodeId || ""} onChange={(event) => openNode(event.target.value)}>
            <option value="" disabled>选择节点…</option>{nodes.map((node) => <option key={node.id} value={node.id}>{questionSummary(node.question.content)}</option>)}
          </select></label>
          {selectedNode && <button type="button" aria-pressed={pinnedNodeId === selectedNodeId} onClick={() => setPinnedNodeId(pinnedNodeId === selectedNodeId ? null : selectedNodeId)}>固定为参考</button>}
          {view === "overview" && <input aria-label="搜索讨论节点" placeholder="搜索节点…" value={nodeSearch} onChange={(event) => setNodeSearch(event.target.value)} />}
        </div>
        {(selecting || validComparisonIds.length > 0) && <div className="discussionSelectionBar">
          <strong>已选 {validComparisonIds.length} 个节点</strong>
          <button type="button" disabled={!canCompare} onClick={() => { setPair(comparisonPair(validComparisonIds, pair)); changeView("compare"); }}>并排查看</button>
          <button type="button" disabled={!canSynthesize || !props.onStartIndependent || !props.documentData} onClick={() => prepareComparison("compare")}>比较方案</button>
          <button type="button" disabled={!canSynthesize || !props.onStartIndependent || !props.documentData} onClick={() => prepareComparison("synthesize")}>生成综合结论</button>
          <button type="button" onClick={() => { setSelecting(false); setComparisonIds([]); if (view === "compare") changeView("discussion"); }}>取消选择</button>
          {!canCompare && <small>至少选择两个节点 · Ctrl / ⌘ 点击可多选</small>}
          {canCompare && !canSynthesize && <small>所选回答生成中，可并排阅读，完成后再综合</small>}
        </div>}
        <div className="discussionComparisonHost" hidden={view !== "compare"}>
          {view === "compare" && <DiscussionComparison thread={props.thread} nodes={nodes} selectedIds={validComparisonIds} pair={pair} onPairChange={setPair}
            scroll={scrollPositions.current} onSaveScroll={savePosition} onOpen={openNode}
            onQuote={props.setReferenceDraft ? (id, text) => { void quoteMessage(id, text); changeView("discussion"); } : undefined} />}
        </div>
        <div className="discussionReviewHost" hidden={view !== "review"}><DiscussionReviewView thread={props.thread} onBack={() => changeView(previousViewRef.current)} /></div>
        {view !== "compare" && view !== "review" && <DiscussionContentTabs value={mobileTab} onChange={setMobileTab} />}
        <div
          ref={modalBodyRef}
          className={`threadModalBody ${documentContextOpen ? "" : "contextCollapsed"} ${resizingPane ? "resizing" : ""} ${pinnedNode ? "hasPinned" : ""} mobile-${mobileTab}`}
          style={{
            gridTemplateColumns: paneWidths.content > 0
              ? documentContextOpen
                ? `${paneWidths.document}px ${THREAD_PANE_DIVIDER_WIDTH}px ${paneWidths.content}px ${THREAD_PANE_DIVIDER_WIDTH}px minmax(0, 1fr)`
                : `${paneWidths.content}px ${THREAD_PANE_DIVIDER_WIDTH}px minmax(0, 1fr)`
              : documentContextOpen
                ? `minmax(0, 3fr) ${THREAD_PANE_DIVIDER_WIDTH}px minmax(0, 5fr) ${THREAD_PANE_DIVIDER_WIDTH}px minmax(0, 2fr)`
                : `minmax(0, 5fr) ${THREAD_PANE_DIVIDER_WIDTH}px minmax(0, 2fr)`
          }}
          onPointerMove={handlePaneResize}
          onPointerUp={finishPaneResize}
          onPointerCancel={finishPaneResize}
        >
          {documentContextOpen && (
            <aside className="threadDocumentContext" aria-label="文档预览">
              <header className="threadDocumentContextHeader">
                <div>
                  <strong>{props.documentData?.title || "当前文档"}</strong>
                </div>
                <button type="button" onClick={props.onRevealSource}>在编辑器中定位</button>
              </header>
              {documentContent !== null ? (
                <article
                  ref={documentContextRef}
                  className="threadContextDocument preview"
                  onScroll={(event) => { if (!event.currentTarget.clientHeight) return; scrollPositions.current.document = event.currentTarget.scrollTop; savePosition(); }}
                />
              ) : (
                <div className="threadContextEmpty">文章内容暂不可用。</div>
              )}
            </aside>
          )}
          {documentContextOpen && (
            <div
              className={`threadPaneDivider documentDivider ${resizingPane === "document-content" ? "active" : ""}`}
              role="separator"
              aria-label="调整文档预览与节点内容宽度"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(event) => beginPaneResize(event, "document-content")}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                resizePaneWithKeyboard("document-content", event.key === "ArrowLeft" ? -24 : 24);
              }}
            />
          )}
          <main
            ref={setContentPaneElement}
            className="threadContentPane"
            aria-label="节点内容"
          >
            {!inspectorOpen && (
              <div className="threadContentEmpty">
                <span>节点内容</span>
                <strong>{nodes.length > 0 ? "从右侧 tree 选择一个节点" : "从右侧创建根问题"}</strong>
                <p>当前节点的问题、回答和后续输入会显示在这里。</p>
              </div>
            )}
          </main>
          <div
            className={`threadPaneDivider treeDivider ${resizingPane === "content-tree" ? "active" : ""}`}
            role="separator"
            aria-label="调整节点内容与讨论树宽度"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={(event) => beginPaneResize(event, "content-tree")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              resizePaneWithKeyboard("content-tree", event.key === "ArrowLeft" ? -24 : 24);
            }}
          />
          <div
            ref={canvasRef}
            className={`threadModalWorkspace threadCanvasViewport ${isPanning ? "panning" : ""}`}
            aria-label="讨论树画布"
            onWheel={handleCanvasWheel}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={finishCanvasPan}
            onPointerCancel={finishCanvasPan}
          >
          <div className="threadCanvasInsightStrip" aria-label="讨论计划摘要">
            <span>问答 {nodes.length}</span>
            <span>未答 {unansweredCount}</span>
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
              {displayedCanvasLayout.connectors.map((connector) => {
                const middleY = (connector.fromY + connector.toY) / 2;
                return (
                  <path
                    key={connector.id}
                    d={`M ${connector.fromX} ${connector.fromY} C ${connector.fromX} ${middleY}, ${connector.toX} ${middleY}, ${connector.toX} ${connector.toY}`}
                  />
                );
              })}
              {canvasDraftPreview?.draftConnector && (() => {
                const connector = canvasDraftPreview.draftConnector;
                const middleY = (connector.fromY + connector.toY) / 2;
                return (
                  <path
                    className="ghostConnector"
                    d={`M ${connector.fromX} ${connector.fromY} C ${connector.fromX} ${middleY}, ${connector.toX} ${middleY}, ${connector.toX} ${connector.toY}`}
                  />
                );
              })()}
            </svg>

            {displayedCanvasLayout.nodes.map((item) => (
              <Fragment key={item.node.id}>
                <ConversationCanvasNode
                  node={item.node}
                  root={item.depth === 0}
                  active={selectedNodeId === item.node.id}
                  x={item.x}
                  y={item.y}
                  selecting={selecting}
                  checked={validComparisonIds.includes(item.node.id)}
                  onToggle={() => toggleComparison(item.node.id)}
                  searchMatch={!nodeSearch || item.node.messages.some((message) => message.content.toLowerCase().includes(nodeSearch.toLowerCase()))}
                  outcomes={nodeOutcomeCounts(workspace?.records || [], props.thread.id, item.node.messages.map((message) => message.id))}
                  onOpen={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey || selecting) toggleComparison(item.node.id); else openNode(item.node.id); }}
                  onCreate={() => openNode(item.node.id, true)}
                />
                {inspectorOpen && selectedNodeId === item.node.id && contentPaneElement && createPortal(
                <article
                  ref={inspectorRef}
                  className="threadCanvasFocusNode"
                  aria-label="当前节点详情"
                >
                  <header className="threadCanvasFocusHeader">
                    <div className="threadCanvasInspectorTitle">
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
                          <details className="legacyNodeLabel">
                            <summary>标签</summary>
                            <label><span>可选历史标签</span>
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
                          </details>
                          <div className="threadNodeQuickActions" aria-label="AI 快捷操作">
                            {quickActions.map((action) => (
                              <button
                                key={action.id}
                                type="button"
                                title={action.prompt}
                                onClick={() => applyNodeQuickAction(action)}
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
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
                          void submitSelectionQuestion();
                        }}
                      >
                        {(() => {
                          const message = props.thread.messages.find((message) => message.id === selectionPopover.sourceMessageId);
                          return message ? <DiscussionAnswerActions thread={props.thread} message={message} text={selectionPopover.text} onAction={clearCapturedMessageSelection} /> : null;
                        })()}
                        <small className="selectionContextHint">本轮参考：{props.thread.contextScope === "references" ? "所选资料" : "完整文档背景"} + 分支历史 + 当前片段</small>
                        <div>
                          {props.setReferenceDraft && <button type="button" disabled={selectionSending || !props.thread.messages.some((message) => message.id === selectionPopover.sourceMessageId && stableMessage(message))} onClick={() => void quoteMessage(selectionPopover.sourceMessageId, selectionPopover.text)}>引用到输入框</button>}
                          <input
                            ref={selectionComposerRef}
                            value={selectionPopover.prompt}
                            disabled={selectionSending}
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
                            disabled={!selectionPopover.prompt.trim() || selectionSending}
                          >
                            {selectionSending ? "发送中…" : "发送"}
                          </button>
                        </div>
                        <small>{nodeCreationMode === "branch" ? "创建分支" : "创建子节点"}</small>
                      </form>
                    </>
                  )}

                  <div
                    ref={messageSelectionSurfaceRef}
                    className="threadModalContent threadCanvasInspectorContent"
                    onPointerDown={beginMessageSelection}
                    onKeyUp={captureMessageSelection}
                    onScroll={(event) => { if (!event.currentTarget.clientHeight) return; clearCapturedMessageSelection(); scrollPositions.current[`work:${selectedNodeId}`] = event.currentTarget.scrollTop; savePosition(); }}
                  >
                    {selectedNodeOrigin && (
                      <div className="threadNodeOriginQuote">
                        <span>引用内容</span>
                        <blockquote>{selectedNodeOrigin.text}</blockquote>
                      </div>
                    )}
                    {selectedNode?.messages.map((message) => (
                      <ThreadMessageDetail
                        onQuote={props.setReferenceDraft ? (messageId) => void quoteMessage(messageId) : undefined}
                        threads={props.threads}
                        onLocateReference={props.onLocateReference}
                        key={message.id}
                        threadId={props.thread.id}
                        thread={props.thread}
                        message={message}
                        editingMessage={props.editingMessage}
                        editText={props.editText}
                        onEdit={props.onEdit}
                        onCancelEdit={props.onCancelEdit}
                        onSaveEdit={props.onSaveEdit}
                        onRetryAssistant={props.onRetryAssistant}
                        onDeleteMessage={props.onDeleteMessage}
                        setEditText={props.setEditText}
                        hideLiveAgentRun={message.id === activeRunMessage?.id}
                      />
                    ))}
                    {selectedNode && !selectedNode.messages.some((message) => message.role === "assistant") && (
                      <div className="threadNodeAnswerEmpty">
                        <span>此节点尚未获得 Codex 回答。</span>
                        <button
                          type="button"
                          className="primaryButton"
                          onClick={() => props.onRequestAssistant(props.thread.id, selectedNode.question.id)}
                        >
                          让 Codex 回答
                        </button>
                      </div>
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
                          branchSelection: null
                        });
                      }
                      clearCapturedMessageSelection();
                    }}
                  >
                    {activeRunMessage && (
                      <div className="threadFocusAgentRun" aria-label="当前节点的 Codex 执行进度">
                        <AgentRunTimeline message={activeRunMessage} variant="floating" />
                      </div>
                    )}
                    {referenceComposer}
                    <div className="threadFocusComposerTopline">
                      <div className="threadCreationMode" aria-label="新节点创建方式">
                        <span>{nodeCreationMode === "branch" ? "分支" : "子节点"}</span>
                      </div>
                      <label htmlFor="thread-canvas-question">
                        {nodeCreationMode === "branch"
                          ? "从当前节点继续另一条分支"
                          : "在当前叶子节点下创建下一步"}
                      </label>
                    </div>
                    {messageDraft.trim() && selectedNode && (
                      <div className="threadFocusRoutePreview" aria-label="新节点预览">
                        <span>{questionSummary(selectedNode.question.content)}</span>
                        <i aria-hidden="true">→</i>
                        <strong>{questionSummary(messageDraft)}</strong>
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
                      <div className="threadComposerContext">
                        <span>沿当前路径继续讨论 · 继承分支历史</span>
                        {effectiveAgentSettings && <small>{effectiveAgentSettings}</small>}
                      </div>
                      <button
                        type="submit"
                        className="primaryButton"
                        disabled={
                          !messageDraft.trim()
                          || Boolean(selectedNode?.messages.some((message) => message.id.startsWith("pending-")))
                        }
                      >
                        {nodeCreationMode === "branch" ? "创建分支" : "创建子节点"}
                      </button>
                    </div>
                  </form>
                </article>,
                contentPaneElement
              )}
              </Fragment>
            ))}

            {(canvasLayout.nodes.length === 0 || (inspectorOpen && !selectedNodeId)) && (
              <>
              {inspectorOpen && contentPaneElement && createPortal(
                <article
                  ref={inspectorRef}
                  className="threadCanvasFocusNode rootComposer"
                  aria-label="创建根问题"
                >
                  <header className="threadCanvasFocusHeader">
                    <div className="threadCanvasInspectorTitle">
                      <span>根节点</span>
                      <strong>开始新的讨论树</strong>
                    </div>
                    <button type="button" className="threadCanvasInspectorClose" aria-label="关闭根节点输入" onClick={closeFocusedNode}>×</button>
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
                    {referenceComposer}
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
                      <div className="threadComposerContext">
                        <span>这将成为讨论树的起点</span>
                        {effectiveAgentSettings && <small>{effectiveAgentSettings}</small>}
                      </div>
                      <button type="submit" className="primaryButton" disabled={!messageDraft.trim()}>询问 Codex</button>
                    </div>
                  </form>
                </article>,
                contentPaneElement
              )}
              {canvasLayout.nodes.length === 0 && <button type="button" className="threadCanvasRootPlaceholder" onClick={openRootComposer}>
                <span>+</span>
                创建根问题
              </button>}
              </>
            )}

            {ghostNode && (
              <div
                className="threadCanvasGhostNode"
                style={{ left: ghostNode.x - 105, top: ghostNode.y - 38 }}
                aria-hidden="true"
              >
                <small>新节点预览</small>
                <strong>{questionSummary(messageDraft)}</strong>
              </div>
            )}
          </div>

          </div>
          {pinnedNode && <aside className="discussionPinned" aria-label="固定参考节点">
            <header><strong>固定参考 · 仅显示</strong><button type="button" onClick={() => setPinnedNodeId(null)}>取消固定</button></header>
            <p>不会自动加入 AI 上下文。需要时请明确引用。</p>
            <div className="discussionPinnedActions">
              <button type="button" disabled={!selectedNode || selectedNode.id === pinnedNode.id} onClick={() => {
                const workScroll = scrollPositions.current[`work:${selectedNodeId}`] || 0;
                const pinScroll = scrollPositions.current[`pinned:${pinnedNode.id}`] || 0;
                scrollPositions.current[`work:${pinnedNode.id}`] = pinScroll;
                scrollPositions.current[`pinned:${selectedNodeId}`] = workScroll;
                setPinnedNodeId(selectedNodeId); openNode(pinnedNode.id);
              }}>交换工作与参考</button>
              <button type="button" disabled={!selectedNode || selectedNode.id === pinnedNode.id || !props.onStartIndependent || Boolean(synthesisSources(props.thread, [selectedNode.id, pinnedNode.id]).generating)} onClick={() => selectedNode && prepareComparison("synthesize", [selectedNode.id, pinnedNode.id])}>综合这两个节点</button>
            </div>
            <DiscussionNodeReader thread={props.thread} node={pinnedNode} label="固定参考问答" scrollKey={`pinned:${pinnedNode.id}`} visibilityKey={`${view}:${mobileTab}`}
              scroll={scrollPositions.current} onSaveScroll={savePosition} onOpen={openNode} onQuote={props.setReferenceDraft ? (id, text) => void quoteMessage(id, text) : undefined} />
          </aside>}
        </div>
      </section>
      {props.documentData && props.onStartIndependent && <IndependentDiscussion
        preparation={preparation}
        open={independentOpen} document={props.documentData} threads={props.threads || [props.thread]}
        source={props.thread} messageIds={selectedNode?.messages.filter((message) => !message.id.startsWith("pending-")).map((message) => message.id) || []}
        onClose={() => setIndependentOpen(false)} onStart={props.onStartIndependent} />}
    </div>
  );
}

function ConversationCanvasNode(props: {
  node: ReturnType<typeof flattenConversationTree>[number];
  root: boolean;
  active: boolean;
  x: number;
  y: number;
  onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onCreate: () => void;
  selecting: boolean;
  checked: boolean;
  onToggle: () => void;
  searchMatch: boolean;
  outcomes: ReturnType<typeof nodeOutcomeCounts>;
}) {
  const legacyTurnCount = props.node.messages.filter((message) => message.role === "user").length;
  const status = conversationNodeStatus(props.node);
  const kind = conversationNodeKind(props.node);
  const canCreateBranch = conversationNodeCanBranch(props.node);
  const hasSelectedOrigin = Boolean(messageBranchSelection(props.node.question));
  const statusLabel = {
    unanswered: "未回答",
    thinking: "Codex 执行中…",
    answered: "已回答",
    failed: "回答失败",
    interrupted: "已中断",
    unknown: "结果未知 · 需核对",
    stopping: "正在停止…"
  }[status];
  return (
    <article
      className={`threadCanvasNode ${props.root ? "root" : ""} ${props.active ? "active" : ""} kind-${kind} status-${status}`}
      data-comparison-selected={props.checked || undefined}
      data-search-match={props.searchMatch}
      style={{
        left: props.x - THREAD_CANVAS_NODE_WIDTH / 2,
        top: props.y - THREAD_CANVAS_NODE_HEIGHT / 2,
        width: THREAD_CANVAS_NODE_WIDTH,
        height: THREAD_CANVAS_NODE_HEIGHT
      }}
    >
      {props.selecting && <label className="discussionNodeCheckbox"><input type="checkbox" checked={props.checked} onChange={props.onToggle} aria-label={`选择节点 ${questionSummary(props.node.question.content)}`} /><span>比较</span></label>}
      {props.outcomes.total > 0 && <span className="discussionNodeOutcomes" title={`已应用 ${props.outcomes.applied} · 执行 ${props.outcomes.executions}`}>成果 {props.outcomes.total}</span>}
      <button type="button" className="threadCanvasNodeMain" onClick={props.onOpen}>
        <span className="threadCanvasNodeTopline">
          <span className={`threadNodeKindPill kind-${kind}`}>{NODE_KIND_META[kind].shortLabel}</span>
          <small className={status === "failed" ? "error" : ""}>{statusLabel}</small>
        </span>
        <strong>{questionSummary(props.node.question.content)}</strong>
        <span className="threadCanvasNodeMeta">
          {legacyTurnCount > 1 ? `历史 ${legacyTurnCount} 轮 · ` : ""}
          {NODE_KIND_META[kind].label}
          {props.node.children.length > 0 ? ` · ${props.node.children.length} 个子节点` : ""}
          {hasSelectedOrigin ? " · 包含引用" : ""}
        </span>
      </button>
      <div className="threadCanvasNodeActions" aria-label="创建后续节点">
        {canCreateBranch ? (
          <button
            type="button"
            className="threadCanvasNodeAdd branch"
            aria-label={`从 ${questionSummary(props.node.question.content)} 新建分支`}
            title="从这里继续另一条分支，继承此前历史"
            onClick={props.onCreate}
          >
            <span aria-hidden="true">⑂</span>
            <small>分支</small>
          </button>
        ) : (
          <button
            type="button"
            className="threadCanvasNodeAdd"
            aria-label={`从 ${questionSummary(props.node.question.content)} 创建子节点`}
            title="在当前叶子节点下创建下一步"
            onClick={props.onCreate}
          >
            <span aria-hidden="true">+</span>
            <small>子节点</small>
          </button>
        )}
      </div>
    </article>
  );
}

export function defaultThreadPaneWidths(
  containerWidth: number,
  documentOpen: boolean
): { document: number; content: number } {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { document: 0, content: 0 };
  }
  const dividerCount = documentOpen ? 2 : 1;
  const available = Math.max(1, containerWidth - dividerCount * THREAD_PANE_DIVIDER_WIDTH);
  if (!documentOpen) {
    return {
      document: 0,
      content: Math.round(available * 5 / 7)
    };
  }
  return {
    document: Math.round(available * 3 / 10),
    content: Math.round(available * 5 / 10)
  };
}

export function threadDetailEscapeTarget(selectionPopoverOpen: boolean): "selection" | "modal" {
  return selectionPopoverOpen ? "selection" : "modal";
}

function fitThreadPaneWidths(
  containerWidth: number,
  desired: { document: number; content: number },
  documentOpen: boolean
): { document: number; content: number } {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return desired;
  const dividerCount = documentOpen ? 2 : 1;
  const available = Math.max(1, containerWidth - dividerCount * THREAD_PANE_DIVIDER_WIDTH);
  const baseMinimums = documentOpen
    ? { document: 240, content: 360, tree: 260 }
    : { document: 0, content: 360, tree: 260 };
  const minimumTotal = baseMinimums.document + baseMinimums.content + baseMinimums.tree;
  const minimumScale = Math.min(1, available / minimumTotal);
  const minimumDocument = baseMinimums.document * minimumScale;
  const minimumContent = baseMinimums.content * minimumScale;
  const minimumTree = baseMinimums.tree * minimumScale;

  if (!documentOpen) {
    return {
      document: desired.document,
      content: Math.round(clamp(desired.content, minimumContent, available - minimumTree))
    };
  }

  const documentWidth = clamp(
    desired.document,
    minimumDocument,
    available - minimumContent - minimumTree
  );
  const contentWidth = clamp(
    desired.content,
    minimumContent,
    available - documentWidth - minimumTree
  );
  return {
    document: Math.round(documentWidth),
    content: Math.round(contentWidth)
  };
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

export function promptForNodeQuickAction(prompt: string): string {
  return prompt.trim();
}

export function ThreadMessageDetail(props: {
  thread: Thread;
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
  hideLiveAgentRun?: boolean;
  threads?: Thread[];
  onLocateReference?: (reference: ReferenceSnapshot) => void;
  onQuote?: (messageId: string) => void;
}) {
  const message = props.message;
  const workspace = useDiscussionWorkspace();
  const question = props.thread.messages.find((item) => item.id === message.parentId);
  const retryThroughOutcome = Boolean(question?.meta?.executionId) || agentRunForMessage(message)?.status === "unknown";
  return (
    <section
      className={`message ${message.role} ${message.error ? "error" : ""}`}
      data-thread-message-id={message.id}
      onDragStart={(event) => {
        const text = window.getSelection()?.toString();
        if (!text || !stableMessage(message)) { event.preventDefault(); return; }
        event.dataTransfer.setData(REFERENCE_DRAG_TYPE, JSON.stringify({ threadId: props.threadId, messageId: message.id, text }));
        event.dataTransfer.effectAllowed = "copy";
      }}
    >
      <span className="messageAvatar" aria-hidden="true">{message.role === "assistant" ? "C" : "Y"}</span>
      <div className="messageBody">
        <div className="messageRole">
          <span className="messageMeta">
            {message.role === "assistant" ? "Codex" : "你"} <time>{formatRelativeTime(message.createdAt)}</time>
            {message.role === "assistant" && !message.id.startsWith("pending-") && (
              <button type="button" disabled={Boolean(workspace?.busy && !retryThroughOutcome) || (retryThroughOutcome && !workspace)} onClick={() => {
                if (workspace?.busy && !retryThroughOutcome) return;
                if (retryThroughOutcome) { workspace?.openResults(props.thread.id); return; }
                props.onRetryAssistant(props.threadId, message.id);
              }}>{retryThroughOutcome ? "执行记录" : "重试"}</button>
            )}
          </span>
          {!message.id.startsWith("pending-") && (
            <span className="messageActions">
              {props.onQuote && <button type="button" disabled={!stableMessage(message)} onClick={() => props.onQuote?.(message.id)}>引用</button>}
              {message.role === "user" && <button type="button" onClick={() => props.onEdit(message)}>编辑</button>}
              <button type="button" disabled={Boolean(workspace?.busy)} onClick={() => props.onDeleteMessage(props.threadId, message.id)}>删除</button>
            </span>
          )}
        </div>
        <DiscussionAnswerActions thread={props.thread} message={message} />
        {props.editingMessage === message.id ? (
          <div>
            <textarea className="editMessageBox" value={props.editText} onChange={(event) => props.setEditText(event.target.value)} />
            <small>保存后会从父节点创建新分支，原节点和后代保持不变。</small>
            <div className="editMessageActions">
              <button type="button" onClick={props.onCancelEdit}>取消</button>
              <button type="button" className="primaryButton" onClick={() => props.onSaveEdit(props.threadId, message.id)}>创建分支</button>
            </div>
          </div>
        ) : (
          <>
            {message.role === "assistant" && !props.hideLiveAgentRun && <AgentRunTimeline message={message} />}
            {message.meta?.contextRecovery === "rebuilt" && <p className="contextRecovery" role="status">本轮未沿用原生会话，已依据保存的问答重建上下文。部分执行过程和工具状态可能缺失；继续执行前请核对必要的文件状态。</p>}
            <ReferenceHistory references={messageReferences(message.meta)} threads={props.threads} onLocate={props.onLocateReference}
              onReevaluate={workspace && stableMessage(message) ? (references) => workspace.reevaluate(props.thread, message, references) : undefined} />
            {message.content && (
              <div className="messageContent" dangerouslySetInnerHTML={{ __html: renderMessageMarkdown(message.content) }} />
            )}
          </>
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
