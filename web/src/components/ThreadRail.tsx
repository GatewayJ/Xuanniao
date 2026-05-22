import { useEffect, useRef, useState } from "react";
import { renderMessageMarkdown } from "../markdown";
import type { Message, Thread } from "../types";

type ThreadRailProps = {
  threads: Thread[];
  activeThreadId: string | null;
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
  setEditText: (value: string) => void;
  setMessage: (value: string) => void;
  onSend: (askAgent: boolean) => void;
};

export function ThreadRail(props: ThreadRailProps) {
  const active = props.threads.find((thread) => thread.id === props.activeThreadId) || null;
  const listRef = useRef<HTMLDivElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(() => {
    return props.activeThreadId ? new Set([props.activeThreadId]) : new Set();
  });

  useEffect(() => {
    if (!props.activeThreadId) return;
    const activeCard = listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(props.activeThreadId)}"]`);
    activeCard?.scrollIntoView({ block: "nearest" });
    setExpandedThreadIds((current) => {
      if (current.has(props.activeThreadId || "")) return current;
      const next = new Set(current);
      next.add(props.activeThreadId || "");
      return next;
    });
  }, [props.activeThreadId]);

  useEffect(() => {
    const threadIds = new Set(props.threads.map((thread) => thread.id));
    setExpandedThreadIds((current) => {
      const next = new Set([...current].filter((threadId) => threadIds.has(threadId)));
      return next.size === current.size ? current : next;
    });
  }, [props.threads]);

  useEffect(() => () => clearClickTimer(), []);

  function clearClickTimer() {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }

  function activateThread(thread: Thread) {
    clearClickTimer();
    clickTimerRef.current = window.setTimeout(() => {
      props.onActivate(thread);
      clickTimerRef.current = null;
    }, 160);
  }

  function toggleThread(thread: Thread) {
    clearClickTimer();
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
          return (
            <article key={thread.id} data-thread-id={thread.id} className={`threadCard ${isActive ? "active" : ""} ${isExpanded ? "expanded" : "collapsed"}`}>
              <div className="threadAccent" aria-hidden="true" />
              <div className="threadCardBody">
                <div
                  className="threadCardButton"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  title="Double-click to show or hide replies"
                  onClick={() => activateThread(thread)}
                  onDoubleClick={() => toggleThread(thread)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      props.onActivate(thread);
                    }
                    if (event.key === " ") {
                      event.preventDefault();
                      toggleThread(thread);
                    }
                  }}
                >
                  <div className="threadAnchorHeader">
                    <span className="threadCount">{(thread.messages || []).length} msg</span>
                    <span className="threadToggleIcon" aria-hidden="true" />
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
