import { useEffect, useRef, useState } from "react";
import { renderMessageMarkdown } from "../markdown";
import type { Message, PermissionOption, PermissionRequest, Thread } from "../types";

type ThreadRailProps = {
  threads: Thread[];
  activeThreadId: string | null;
  permissionRequests: PermissionRequest[];
  resolvingPermissionIds: Set<string>;
  editingMessage: string | null;
  editText: string;
  message: string;
  onActivate: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
  onNewThread: () => void;
  onEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (threadId: string, messageId: string) => void;
  onRetryAssistant: (threadId: string, messageId: string) => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
  setEditText: (value: string) => void;
  setMessage: (value: string) => void;
  onSend: (askAgent: boolean) => void;
};

export function ThreadRail(props: ThreadRailProps) {
  const active = props.threads.find((thread) => thread.id === props.activeThreadId) || null;
  const listRef = useRef<HTMLDivElement | null>(null);
  const previousThreadIdsRef = useRef<Set<string>>(new Set(props.threads.map((thread) => thread.id)));
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(() => {
    return props.activeThreadId ? new Set([props.activeThreadId]) : new Set();
  });

  useEffect(() => {
    if (!props.activeThreadId) return;
    const activeCard = listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(props.activeThreadId)}"]`);
    activeCard?.scrollIntoView({ block: "nearest" });
  }, [props.activeThreadId]);

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
  }, [props.threads, props.permissionRequests]);

  function activateThread(thread: Thread) {
    props.onActivate(thread);
  }

  function toggleThread(thread: Thread) {
    props.onActivate(thread);
    setExpandedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(thread.id)) next.delete(thread.id);
      else next.add(thread.id);
      return next;
    });
  }

  return (
    <aside className="threadPane">
      <div className="threadPaneHeader">
        <div>
          <h2>Comments</h2>
          <p>{props.threads.length} anchored thread{props.threads.length === 1 ? "" : "s"}</p>
        </div>
        <button type="button" className="secondaryButton" onClick={props.onNewThread}>New Thread</button>
      </div>
      <div className="threadList" ref={listRef}>
        {props.threads.length === 0 && <div className="emptyState">No comments yet.</div>}
        {props.threads.map((thread) => {
          const isActive = thread.id === props.activeThreadId;
          const isExpanded = expandedThreadIds.has(thread.id);
          const threadPermissionRequests = props.permissionRequests.filter((request) => (
            request.threadId === thread.id || (!request.threadId && thread.id === props.activeThreadId)
          ));
          return (
            <article key={thread.id} data-thread-id={thread.id} className={`threadCard ${isActive ? "active" : ""} ${isExpanded ? "expanded" : "collapsed"}`}>
              <div className="threadAccent" aria-hidden="true" />
              <div className="threadCardBody">
                <div
                  className="threadCardButton"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  title="Open thread"
                  onClick={() => activateThread(thread)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      props.onActivate(thread);
                    }
                  }}
                >
                  <div className="threadAnchorHeader">
                    <span className="threadCount">{(thread.messages || []).length} msg</span>
                    {threadPermissionRequests.length > 0 && <span className="permissionBadge">Permission</span>}
                    <button
                      type="button"
                      className="threadToggleButton"
                      aria-label={isExpanded ? "Collapse thread" : "Expand thread"}
                      title={isExpanded ? "Collapse thread" : "Expand thread"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleThread(thread);
                      }}
                    >
                      <span className="threadToggleIcon" aria-hidden="true" />
                    </button>
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
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); props.onSend(true); }}>
        <textarea
          value={props.message}
          onChange={(event) => props.setMessage(event.target.value)}
          placeholder={active ? "Reply to this thread..." : "Select text and create a thread first."}
          disabled={!active}
        />
        <div className="composerActions">
          <button type="button" disabled={!active} onClick={() => props.onSend(false)}>Add Comment</button>
          <button className="primaryButton" disabled={!active}>Ask Codex</button>
        </div>
      </form>
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
