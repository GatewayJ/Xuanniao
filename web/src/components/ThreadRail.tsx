import { useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { renderMessageMarkdown } from "../markdown";
import type { Message, PermissionOption, PermissionRequest, Thread, ThreadSpatialLayout } from "../types";

const THREAD_ACTIVATION_DELAY_MS = 180;

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
  setMessageDraft: (threadId: string, value: string) => void;
  onSend: (threadId: string, askAgent: boolean) => void;
};

export function ThreadRail(props: ThreadRailProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const applyingScrollRef = useRef(false);
  const applyingScrollFrameRef = useRef<number | null>(null);
  const activationTimerRef = useRef<number | null>(null);
  const scrollPositionRef = useRef(0);
  const previousThreadIdsRef = useRef<Set<string>>(new Set(props.threads.map((thread) => thread.id)));
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [railViewportHeight, setRailViewportHeight] = useState(0);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(() => {
    return props.activeThreadId ? new Set([props.activeThreadId]) : new Set();
  });

  useEffect(() => {
    const threadIds = new Set(props.threads.map((thread) => thread.id));
    const previousThreadIds = previousThreadIdsRef.current;
    setExpandedThreadIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const threadId of current) {
        if (threadIds.has(threadId)) next.add(threadId);
        else changed = true;
      }
      for (const thread of props.threads) {
        if (!previousThreadIds.has(thread.id)) {
          next.add(thread.id);
          changed = true;
        }
      }
      for (const request of props.permissionRequests) {
        if (request.threadId && threadIds.has(request.threadId) && !next.has(request.threadId)) {
          next.add(request.threadId);
          changed = true;
        }
        if (!request.threadId && props.activeThreadId && threadIds.has(props.activeThreadId) && !next.has(props.activeThreadId)) {
          next.add(props.activeThreadId);
          changed = true;
        }
      }
      return changed || next.size !== current.size ? next : current;
    });
    previousThreadIdsRef.current = threadIds;
  }, [props.threads, props.permissionRequests, props.activeThreadId]);

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
    clearPendingActivation();
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
  }, [props.threads, props.permissionRequests, expandedThreadIds, props.editingMessage, props.editText]);

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
    return placeThreadCards(threadItems, cardHeights, expandedThreadIds);
  }, [threadItems, cardHeights, expandedThreadIds]);

  const spatialHeight = Math.max(
    alignedSpatialHeight(props.spatialLayout, railViewportHeight),
    ...placedThreads.map((item) => item.top + (cardHeights[item.thread.id] || estimatedThreadHeight(item.thread, expandedThreadIds.has(item.thread.id))) + 16),
    1
  );

  function activateThread(thread: Thread) {
    clearPendingActivation();
    props.onActivate(thread);
  }

  function scheduleThreadActivation(thread: Thread) {
    clearPendingActivation();
    activationTimerRef.current = window.setTimeout(() => {
      activationTimerRef.current = null;
      props.onActivate(thread);
    }, THREAD_ACTIVATION_DELAY_MS);
  }

  function clearPendingActivation() {
    if (activationTimerRef.current === null) return;
    window.clearTimeout(activationTimerRef.current);
    activationTimerRef.current = null;
  }

  function toggleThread(thread: Thread) {
    clearPendingActivation();
    props.onActivate(thread);
    setExpandedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(thread.id)) next.delete(thread.id);
      else next.add(thread.id);
      return next;
    });
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

  return (
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
        {placedThreads.map(({ thread, top }, index) => {
          const isActive = thread.id === props.activeThreadId;
          const isExpanded = expandedThreadIds.has(thread.id);
          const previousThread = placedThreads[index - 1]?.thread || null;
          const nextThread = placedThreads[index + 1]?.thread || null;
          const threadPermissionRequests = props.permissionRequests.filter((request) => (
            request.threadId === thread.id || (!request.threadId && thread.id === props.activeThreadId)
          ));
          return (
            <article
              key={thread.id}
              ref={(element) => setCardRef(thread.id, element)}
              data-thread-id={thread.id}
              className={`threadCard ${isActive ? "active" : ""} ${isExpanded ? "expanded" : "collapsed"}`}
              style={{ top }}
            >
              <div className="threadAccent" aria-hidden="true" />
              <div className="threadCardBody">
                <div
                  className="threadCardButton"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  title="Double-click to show or hide replies"
                  onClick={(event) => {
                    if (event.detail > 1) {
                      clearPendingActivation();
                      return;
                    }
                    scheduleThreadActivation(thread);
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    toggleThread(thread);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      props.onActivate(thread);
                    }
                  }}
                >
                  <div className="threadAnchorHeader">
                    <span className="threadCount">{(thread.messages || []).length} msg</span>
                    {threadPermissionRequests.length > 0 && <span className="permissionBadge">Permission</span>}
                    <span className="threadNavControls" aria-label="Thread navigation">
                      <button
                        type="button"
                        className="threadNavButton"
                        aria-label="Previous thread"
                        title="Previous thread"
                        disabled={!previousThread}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (previousThread) activateThread(previousThread);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <span className="threadNavIcon up" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="threadNavButton"
                        aria-label="Next thread"
                        title="Next thread"
                        disabled={!nextThread}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (nextThread) activateThread(nextThread);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
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
                  <div className="threadAnchorText">{thread.selectedText || thread.title || "Untitled thread"}</div>
                </div>
                {isExpanded && (
                  <div className="threadMessages">
                    {(thread.messages || []).map((msg) => (
                      <section key={msg.id} className={`message ${msg.role} ${msg.error ? "error" : ""}`}>
                        <span className="messageAvatar" aria-hidden="true">{msg.role === "assistant" ? "C" : "Y"}</span>
                        <div className="messageBody">
                          <div className="messageRole">
                            <span className="messageMeta">
                              {msg.role === "assistant" ? "Codex" : "You"} <time>{formatMessageTime(msg.createdAt)}</time>
                              {msg.role === "assistant" && !msg.id.startsWith("pending-") && (
                                <button
                                  type="button"
                                  aria-label="Retry Codex reply"
                                  title="Retry Codex reply"
                                  onClick={() => props.onRetryAssistant(thread.id, msg.id)}
                                >
                                  Retry
                                </button>
                              )}
                            </span>
                            {!msg.id.startsWith("pending-") && (
                              <span className="messageActions">
                                {msg.role === "user" && <button type="button" onClick={() => props.onEdit(msg)}>Edit</button>}
                                <button type="button" onClick={() => props.onDeleteMessage(thread.id, msg.id)}>Delete</button>
                              </span>
                            )}
                          </div>
                          {props.editingMessage === msg.id ? (
                            <div>
                              <textarea className="editMessageBox" value={props.editText} onChange={(event) => props.setEditText(event.target.value)} />
                              <div className="editMessageActions">
                                <button type="button" onClick={props.onCancelEdit}>Cancel</button>
                                <button type="button" onClick={() => props.onSaveEdit(thread.id, msg.id)}>Save</button>
                              </div>
                            </div>
                          ) : (
                            <div className="messageContent" dangerouslySetInnerHTML={{ __html: renderMessageMarkdown(msg.content) }} />
                          )}
                        </div>
                      </section>
                    ))}
                    {threadPermissionRequests.map((request) => (
                      <PermissionRequestPanel
                        key={request.id}
                        request={request}
                        resolving={props.resolvingPermissionIds.has(request.id)}
                        onResolve={props.onResolvePermission}
                      />
                    ))}
                    <form
                      className="inlineComposer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        props.onSend(thread.id, true);
                      }}
                    >
                      <textarea
                        value={props.messageDrafts[thread.id] || ""}
                        onChange={(event) => props.setMessageDraft(thread.id, event.target.value)}
                        placeholder="Reply to this thread..."
                      />
                      <div className="inlineComposerActions">
                        <button className="primaryButton">Ask Codex</button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            </article>
          );
        })}
          </div>
        )}
      </div>
    </aside>
  );
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
  heights: Record<string, number>,
  expandedThreadIds: Set<string>
): ThreadPlacement[] {
  let cursor = 8;
  return items.map((item) => {
    const top = Math.max(item.targetTop, cursor);
    const height = heights[item.thread.id] || estimatedThreadHeight(item.thread, expandedThreadIds.has(item.thread.id));
    cursor = top + height + 10;
    return { ...item, top };
  });
}

function estimatedThreadHeight(thread: Thread, expanded: boolean): number {
  if (!expanded) return 72;
  return Math.min(420, 94 + Math.max(1, thread.messages.length) * 82);
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
