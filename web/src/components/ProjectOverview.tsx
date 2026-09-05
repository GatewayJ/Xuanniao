import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { projectApi } from "../project-api";
import type { ProjectPayload, ReferenceCheck } from "../project-api";
import { messageReferences } from "../discussion-references";
import type { OutcomeRecord, ReferenceSnapshot, Thread } from "../types";
import { appliedOutcomeCount, OutcomeDetail, WorkspaceDialog, outcomeReferences, outcomeStatus } from "./OutcomeReview";

export type ProjectFilter = { kind: "discussion" | "proposal" | "execution" | "applied"; path: string; status: string; changed: boolean; query: string };
type Selection = { path: string; kind: "discussion" | "record"; id: string };
type View = { root: string; filter: ProjectFilter; selected: Selection | null };
export type ProjectRow = Selection & { title: string; date: string; status: string; thread?: Thread; record?: OutcomeRecord; changed: boolean; external: boolean };
const defaultFilter: ProjectFilter = { kind: "discussion", path: "", status: "", changed: false, query: "" };
const sessionMemory = new Map<string, unknown>();
function readSession<T>(key: string): T | null {
  if (sessionMemory.has(key)) return sessionMemory.get(key) as T;
  try { return JSON.parse(sessionStorage.getItem(key) || "null") as T | null; } catch { return null; }
}
function saveSession(key: string, value: unknown) {
  sessionMemory.set(key, value);
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* This session still keeps its reading position. */ }
}
export function normalizeProjectFilter(value?: Partial<ProjectFilter> | null): ProjectFilter {
  return { kind: value?.kind && ["discussion", "proposal", "execution", "applied"].includes(value.kind) ? value.kind : "discussion",
    path: typeof value?.path === "string" ? value.path : "", status: typeof value?.status === "string" ? value.status : "",
    changed: value?.changed === true, query: typeof value?.query === "string" ? value.query : "" };
}
export function projectViewKey(root: string) { return `xuanniao:project-overview:${encodeURIComponent(root)}`; }
export function projectScrollKey(root: string, filter: ProjectFilter) { return `${projectViewKey(root)}:scroll:${JSON.stringify([filter.kind, filter.path, filter.status, filter.changed, filter.query])}`; }
export function projectSelectionKey(value: Selection) { return JSON.stringify([value.path, value.kind, value.id]); }
export function projectReferences(project: ProjectPayload): ReferenceSnapshot[] {
  return [...new Map(project.documents.flatMap((document) => [
    ...document.records.flatMap(outcomeReferences), ...document.threads.flatMap((thread) => thread.messages.flatMap((message) => messageReferences(message.meta)))
  ]).map((reference) => [reference.id, reference])).values()];
}
export function projectRows(project: ProjectPayload | null, checks: ReferenceCheck[]): ProjectRow[] {
  const stale = new Set(checks.filter((check) => check.state !== "current").map((check) => check.id));
  const changed = (references: ReferenceSnapshot[]) => references.some((reference) => stale.has(reference.id));
  return (project?.documents || []).flatMap((document) => [
    ...document.threads.map((thread): ProjectRow => ({ path: document.path, kind: "discussion", id: thread.id, title: thread.title, date: thread.updatedAt, status: thread.orphaned ? "待定位" : "讨论", thread, changed: changed(thread.messages.flatMap((message) => messageReferences(message.meta))), external: document.external })),
    ...document.records.map((record): ProjectRow => ({ path: document.path, kind: "record", id: record.id, title: record.title, date: record.updatedAt, status: outcomeStatus[record.status], record, changed: changed(outcomeReferences(record)), external: document.external }))
  ]).sort((a, b) => b.date.localeCompare(a.date));
}
export function filterProjectRows(rows: ProjectRow[], filter: ProjectFilter): ProjectRow[] {
  return rows.filter((row) => (filter.kind === "discussion" ? row.kind === "discussion" : filter.kind === "applied" ? row.record?.kind === "proposal" && row.record.status === "applied" && !row.record.inverseOf : row.record?.kind === filter.kind)
    && (!filter.path || row.path === filter.path) && (!filter.status || row.status === filter.status) && (!filter.changed || row.changed)
    && (!filter.query.trim() || `${row.title} ${row.path}`.toLowerCase().includes(filter.query.trim().toLowerCase())));
}

export function ProjectOverview({ busy, canStop = false, currentPath, permissions, waitingPermissions = 0, onClose, onOpen, onStop }: {
  busy: boolean; permissions?: ReactNode; waitingPermissions?: number; canStop?: boolean; currentPath?: string; onClose(): void;
  onOpen(path: string, recordId?: string, threadId?: string, messageId?: string): Promise<void>; onStop(): void;
}) {
  const [project, setProject] = useState<ProjectPayload | null>(null);
  const [view, setView] = useState<View>({ root: "", filter: defaultFilter, selected: null });
  const { filter, selected } = view;
  const [checks, setChecks] = useState<ReferenceCheck[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checksReady, setChecksReady] = useState(false);
  const [opening, setOpening] = useState(false);
  const request = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const change = (patch: Partial<ProjectFilter>) => setView((previous) => ({ ...previous, filter: { ...previous.filter, ...patch } }));

  async function refresh() {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setChecksReady(false); setError("");
    try {
      const data = await projectApi.list(controller.signal);
      if (controller.signal.aborted) return;
      setProject(data);
      setView((previous) => {
        if (previous.root === data.root) return previous;
        const saved = readSession<Partial<View>>(projectViewKey(data.root));
        const selected = saved?.selected;
        return { root: data.root, filter: normalizeProjectFilter(saved?.filter), selected: selected && typeof selected.path === "string" && typeof selected.id === "string" && ["record", "discussion"].includes(selected.kind) ? selected : null };
      });
      const refs = projectReferences(data);
      const results: ReferenceCheck[] = [];
      for (let index = 0; index < refs.length; index += 24) {
        results.push(...await projectApi.checkReferences(refs.slice(index, index + 24), controller.signal));
        if (controller.signal.aborted) return;
      }
      setChecks(results);
    } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (!controller.signal.aborted) { setLoading(false); setChecksReady(true); } }
  }
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, []);
  useEffect(() => { if (view.root) saveSession(projectViewKey(view.root), view); }, [view]);
  const listKey = projectScrollKey(view.root, filter);
  const selectedKey = selected ? projectSelectionKey(selected) : "";
  const previewKey = `${projectViewKey(view.root)}:preview:${selectedKey}`;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !view.root || !checksReady) return;
    const position = readSession<number>(listKey);
    list.scrollTop = typeof position === "number" && Number.isFinite(position) ? position : 0;
  }, [listKey, view.root, checksReady]);
  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview || !view.root) return;
    const position = readSession<number>(previewKey);
    preview.scrollTop = typeof position === "number" && Number.isFinite(position) ? position : 0;
  }, [previewKey, view.root]);
  const docs = project?.documents || [];
  const records = docs.filter((document) => !document.external).flatMap((document) => document.records);
  const allRows = projectRows(project, checks);
  const rows = filterProjectRows(allRows, filter);
  const selectedRow = allRows.find((row) => projectSelectionKey(row) === selectedKey);
  const selectedDocument = docs.find((document) => document.path === selected?.path);
  const changedCount = allRows.filter((row) => !row.external && row.changed).length;
  const hiddenSelection = selectedRow && !rows.some((row) => projectSelectionKey(row) === selectedKey);
  const resetFilters = () => change({ ...defaultFilter, kind: filter.kind });
  const switchBlocked = busy && selected?.path !== currentPath;

  return <WorkspaceDialog title="项目总览" wide onClose={onClose}>
    {permissions}
    <div className="projectSummary">{waitingPermissions > 0 && <div><b>{waitingPermissions}</b><span>等待权限</span></div>}<div><b>{records.filter((record) => ["review", "conflict"].includes(record.status)).length}</b><span>待审核修改</span></div><div><b>{appliedOutcomeCount(records)}</b><span>已应用成果</span></div><div><b>{records.filter((record) => ["running", "stopping", "unknown"].includes(record.status)).length}</b><span>执行中或待核对</span></div><div><b>{changedCount}</b><span>依据更新或不可用</span></div><small>{project?.root}<br />检查于 {project && new Date(project.checkedAt).toLocaleString()} · <button disabled={loading} onClick={() => void refresh()}>{loading ? "正在检查…" : "刷新"}</button></small></div>
    {error && <p className="outcomeError" role="alert">{error}。已有记录与上次检查仍保留。</p>}
    <div className="projectFilters"><nav aria-label="项目记录类型">{([["discussion", "最近讨论"], ["proposal", "修改提案"], ["execution", "执行记录"], ["applied", "已应用成果"]] as const).map(([kind, label]) => <button key={kind} aria-pressed={filter.kind === kind} onClick={() => change({ kind, status: "" })}>{label}</button>)}</nav><label>文档<select value={filter.path} onChange={(event) => change({ path: event.target.value })}><option value="">所有关联文档</option>{filter.path && !docs.some((doc) => doc.path === filter.path) && <option value={filter.path}>原筛选文档已不可用 · {filter.path}</option>}{docs.map((document) => <option key={document.path} value={document.path}>{document.title}{document.external ? "（项目外）" : ""}{!document.available ? "（来源不可用）" : ""}</option>)}</select></label><label>状态<select value={filter.status} onChange={(event) => change({ status: event.target.value })}><option value="">全部状态</option>{[...new Set(["讨论", "待定位", ...Object.values(outcomeStatus), ...(filter.status ? [filter.status] : [])])].map((status) => <option key={status}>{status}</option>)}</select></label><label className="projectCheck"><input type="checkbox" checked={filter.changed} onChange={(event) => change({ changed: event.target.checked })} />依据有变化</label><input aria-label="搜索项目记录" placeholder="搜索标题或文档…" value={filter.query} onChange={(event) => change({ query: event.target.value })} /><button onClick={resetFilters}>清除筛选</button></div>
    <div className="projectBody"><div className="projectRows" ref={listRef} tabIndex={0} aria-label="项目记录列表" onScroll={(event) => { if (view.root && checksReady) saveSession(listKey, event.currentTarget.scrollTop); }}>
      <small role="status">{rows.length} 项匹配记录 · 已加载 {allRows.length} 项</small>
      {!rows.length && <p className="outcomeEmpty">{loading ? "正在读取已有讨论和成果…" : "没有匹配的记录。请清除筛选或切换记录类型。"}</p>}
      {rows.map((row) => <button key={projectSelectionKey(row)} aria-pressed={selectedKey === projectSelectionKey(row)} className={selectedKey === projectSelectionKey(row) ? "active" : ""} onClick={() => setView((previous) => ({ ...previous, selected: { path: row.path, kind: row.kind, id: row.id } }))}><strong>{row.title}</strong><span>{row.status}{row.changed ? " · 依据已更新或不可用" : ""}{row.external ? " · 项目外" : ""}</span><small>{row.path} · {new Date(row.date).toLocaleString()}</small></button>)}
    </div><section className="projectPreview" ref={previewRef} tabIndex={0} aria-label="项目记录预览" onScroll={(event) => { if (view.root && selectedKey) saveSession(previewKey, event.currentTarget.scrollTop); }}>{selectedRow ? <>
      <div className="projectPreviewBar"><span>只读预览</span><button className="primary" disabled={switchBlocked || opening || !selectedDocument?.available} onClick={() => {
        setOpening(true); setError("");
        void onOpen(selectedRow.path, selectedRow.record?.id, selectedRow.thread?.id).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setOpening(false));
      }}>{opening ? "正在打开…" : "打开文档处理"}</button></div>
      {hiddenSelection && <p role="status">当前预览不在筛选列表中，仍可查看。<button onClick={() => change({ ...defaultFilter, kind: selectedRow.record?.kind || "discussion" })}>显示这类记录</button></p>}
      {!selectedDocument?.available && <p role="status">{selectedDocument?.unavailableReason || "文档当前不可用，保留已保存记录。"}</p>}
      {selectedDocument?.errors?.map((error) => <p key={error} className="outcomeError">{error}</p>)}
      {switchBlocked && <p>当前操作结束后可切换，仍可继续预览。{canStop && <button onClick={onStop}>停止当前执行</button>}</p>}
      {selectedRow.record ? <OutcomeDetail key={selectedKey} readonly record={selectedRow.record} records={selectedDocument?.records || []} sourceThread={selectedDocument?.threads.find((thread) => thread.id === selectedRow.record?.source.threadId)} busy={false} /> : selectedRow.thread && <><h3>{selectedRow.thread.title}</h3><blockquote>{selectedRow.thread.selectedText}</blockquote>{selectedRow.thread.messages.map((message) => <section key={message.id}><h4>{message.role === "user" ? "问题" : "回答"}</h4><pre>{message.content}</pre></section>)}</>}
    </> : <div className="outcomeEmpty"><span>◈</span><h3>{selected ? "原记录已不可用" : "讨论与实际成果"}</h3><p>{selected ? "该记录已不在最新项目数据中，请选择其他记录。" : "选择记录直接预览，处理时再打开对应文档。"}</p></div>}</section></div>
    {docs.some((document) => document.external) && <p>项目外关联文档保留在列表中，以“项目外”标记，不计入项目内部统计。</p>}
  </WorkspaceDialog>;
}
