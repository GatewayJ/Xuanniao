// Browser-only fixture: mount via a temporary Vite entry when exercising workspace interactions.
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThreadDetailModal, ThreadRail } from "./ThreadRail";
import { DiscussionWorkspaceContext } from "./DiscussionWorkspaceContext";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import type { IndependentDiscussionRequest } from "./IndependentDiscussion";
import type { Message, OutcomeRecord, ReferenceSnapshot, Thread } from "../types";
import "../../styles.css";
import "./discussion-workspace.css";

const at = "2026-09-05T00:00:00Z";
const messages: Message[] = [];
for (const [id, parentId, title] of [["root", null, "原始目标：不新增依赖"], ["constraint", "root", "约束：保留旧客户端"], ["a", "constraint", "方案 A：分块重试"], ["b", "constraint", "方案 B：整包重试"], ["c", "root", "方案 C：性能风险"]]) {
  messages.push({ id: id!, nodeId: id!, parentId, content: title!, role: "user", createdAt: at });
  messages.push({ id: `${id}-answer`, nodeId: id!, parentId: id!, content: `${title}的完整回答。\n\n${Array.from({ length: 22 }, (_, i) => `### 验证事项 ${i + 1}\n\n需要核对吞吐、失败恢复和兼容性。保存这段阅读位置，并准备后续验证。`).join("\n\n")}`, role: "assistant", createdAt: at });
}
const source: Thread = { id: "ui-fixture", title: "上传方案讨论", selectedText: "原文要求：兼容性与可恢复性", anchor: { start: 0, end: 15, lineStart: 1, lineEnd: 1, blockId: null }, messages, createdAt: at, updatedAt: at };
const doc = { path: "/fixture/discussion.md", title: "方案设计.md", content: `${source.selectedText}\n\n${Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段文档要求与背景。`).join("\n\n")}`, revision: "fixture-v1", blocks: [] };
const records: OutcomeRecord[] = [{ id: "outcome-1", title: "采纳分块重试", kind: "proposal", status: "applied", documentPath: doc.path, source: { id: "source", kind: "message", threadId: source.id, messageId: "a-answer", documentPath: doc.path, title: "方案 A", content: "分块重试", revision: "fixture", start: 0, end: 4 }, references: [], instruction: "采纳", createdAt: at, updatedAt: at, revision: 1 }];
function Fixture() {
  const [threads, setThreads] = useState([source]);
  const [currentId, setCurrentId] = useState(source.id);
  const [open, setOpen] = useState(true);
  const [discussionVisible, setDiscussionVisible] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, ReferenceSnapshot[]>>({});
  const [lastAction, setLastAction] = useState("");
  const current = threads.find((thread) => thread.id === currentId)!;
  async function start(request: IndependentDiscussionRequest) {
    setLastAction(JSON.stringify(request));
    const thread: Thread = { ...source, id: `synthesis-${threads.length}`, independent: true, sourceThreadId: current.id, contextScope: request.scope, title: request.content.slice(0, 28), messages: [{ id: "new-root", nodeId: "new-root", parentId: null, content: request.content, role: "user", createdAt: at, meta: { references: request.references } }] };
    setThreads((items) => [...items, thread]); setCurrentId(thread.id);
  }
  return <DiscussionWorkspaceContext value={{ records, busy: false, references: [], document: doc, onDiscussionVisibilityChange: setDiscussionVisible, openProject: () => setLastAction("project"), stop: () => setLastAction("stop"), reevaluate: () => setLastAction("reevaluate"), adopt: (_, message, text) => setLastAction(`adopt:${message.id}:${text || "full"}`), execute: (_, message, text) => setLastAction(`execute:${message.id}:${text || "full"}`), referenceTo: (_, message, text) => setLastAction(`reference:${message.id}:${text || "full"}`), openResults: () => setLastAction("results"), reanchor: () => setLastAction("reanchor") }}>
    <WorkspaceNavigation placement="workspace" hidden={discussionVisible} />
    <button type="button" onClick={() => setOpen(true)}>重新打开讨论</button><output aria-label="最近操作">{lastAction}</output>
    {open && <ThreadDetailModal key={current.id} documentData={doc} agentSettings={null} thread={current} threads={threads}
      onOpenThread={setCurrentId} onOpenSource={current.sourceThreadId ? () => setCurrentId(current.sourceThreadId!) : undefined}
      onStartIndependent={start} permissionRequests={[]} resolvingPermissionIds={new Set()} editingMessage={null} editText="" messageDrafts={drafts}
      referenceDrafts={references} setReferenceDraft={(key, refs) => setReferences((items) => ({ ...items, [key]: refs }))}
      onClose={() => setOpen(false)} onRevealSource={() => {}} onEdit={() => {}} onCancelEdit={() => {}} onSaveEdit={() => {}} onUpdateMessageMeta={() => {}} onRetryAssistant={() => {}} onRequestAssistant={() => {}} onDeleteMessage={() => {}} onResolvePermission={() => {}} setEditText={() => {}}
      setMessageDraft={(key, content) => setDrafts((items) => ({ ...items, [key]: content }))} onSend={async () => true} />}
  </DiscussionWorkspaceContext>;
}


function NavigationFixture() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, ReferenceSnapshot[]>>({});
  const [navigation, setNavigation] = useState({ threadId: source.id, nodeId: "a" as string | null, nonce: 1 });
  const [reviewOpen, setReviewOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const destination = { ...source, id: "navigation-target", title: "引用目标讨论" };
  useEffect(() => { if (reviewOpen) dialog.current?.showModal(); }, [reviewOpen]);
  return <DiscussionWorkspaceContext value={{ records, references: [], document: doc, busy: false,
    adopt() {}, execute() {}, stop() {}, reevaluate() {}, navigation,
    referenceTo: () => {
      setDrafts((items) => ({ ...items, "thread:navigation-target:node:b": "来自回答的预填引用草稿" }));
      setNavigation((current) => ({ threadId: destination.id, nodeId: "b", nonce: current.nonce + 1 }));
    }, openResults: () => setReviewOpen(true)
  }}>
    <ThreadRail documentData={doc} agentSettings={null} threads={[source, destination]} activeThreadId={source.id} spatialLayout={null}
      permissionRequests={[]} resolvingPermissionIds={new Set()} editingMessage={null} editText="" messageDrafts={drafts} referenceDrafts={references}
      setReferenceDraft={(key, refs) => setReferences((items) => ({ ...items, [key]: refs }))}
      onActivate={() => {}} onDelete={() => {}} onAskSelection={() => {}} onSpatialScroll={() => {}} onEdit={() => {}} onCancelEdit={() => {}} onSaveEdit={() => {}} onUpdateMessageMeta={() => {}} onRetryAssistant={() => {}} onRequestAssistant={() => {}} onDeleteMessage={() => {}} onResolvePermission={() => {}} setEditText={() => {}}
      setMessageDraft={(key, content) => setDrafts((items) => ({ ...items, [key]: content }))} onSend={async () => true} />
    {reviewOpen && <dialog ref={dialog} data-discussion-overlay onCancel={(event) => { event.preventDefault(); setReviewOpen(false); }}><h2>模拟父审核弹层</h2><button type="button" onClick={() => setReviewOpen(false)}>关闭审核</button></dialog>}
  </DiscussionWorkspaceContext>;
}

if (typeof document !== "undefined") {
  const mount = document.getElementById("discussion-fixture") as (HTMLElement & { fixtureRoot?: Root }) | null;
  if (mount) { mount.fixtureRoot ||= createRoot(mount); mount.fixtureRoot.render(location.search.includes("navigation") ? <NavigationFixture /> : <Fixture />); }
}
