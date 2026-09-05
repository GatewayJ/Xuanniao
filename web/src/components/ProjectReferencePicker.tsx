import { useEffect, useMemo, useState } from "react";
import { discussionSources } from "../discussion-references";
import type { ReferenceSource } from "../discussion-references";
import { projectApi } from "../project-api";
import type { ProjectPayload, ProjectPreview } from "../project-api";
import type { DocumentPayload, Thread } from "../types";

export function ProjectReferencePicker({ document, threads, disabled, onAdd }: {
  document: DocumentPayload;
  threads: Thread[];
  disabled?: boolean;
  onAdd: (source: ReferenceSource, range?: { start: number; end: number }) => void;
}) {
  const [project, setProject] = useState<ProjectPayload | null>(null);
  const [linkPath, setLinkPath] = useState("");
  const [relink, setRelink] = useState(false);
  const [selectedPath, setSelectedPath] = useState(document.path);
  const [loaded, setLoaded] = useState<ProjectPreview | null>(null);
  const [preview, setPreview] = useState<ReferenceSource | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [search, setSearch] = useState("");
  const [indexError, setIndexError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const isCurrent = selectedPath === document.path;
  const payload = isCurrent ? { document, threads } : loaded?.document.path === selectedPath ? loaded : null;
  const sources = useMemo(() => payload ? discussionSources(payload.document, payload.threads) : [], [payload?.document, payload?.threads]);
  useEffect(() => {
    const controller = new AbortController();
    setIndexError("");
    projectApi.list(controller.signal).then((value) => { if (!controller.signal.aborted) setProject(value); })
      .catch((error) => { if (!controller.signal.aborted) setIndexError(error instanceof Error ? error.message : "无法读取项目文档"); });
    return () => controller.abort();
  }, [document.path, refresh]);
  useEffect(() => { setSelectedPath(document.path); setPreview(null); }, [document.path]);
  useEffect(() => {
    setLoaded(null);
    setPreview(null);
    setPreviewError("");
    if (isCurrent) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    projectApi.preview(selectedPath, controller.signal).then((value) => { if (!controller.signal.aborted) setLoaded(value); })
      .catch((error) => { if (!controller.signal.aborted) setPreviewError(error instanceof Error ? error.message : "来源不可用，请重新关联"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedPath, isCurrent, refresh]);
  return <div className="referencePicker">
    <details><summary>关联其他 Markdown 文档</summary><label className="workbenchField">文件路径<input value={linkPath} onChange={(event) => setLinkPath(event.target.value)} placeholder="项目相对路径或绝对路径" /></label>
      <label><input type="checkbox" checked={relink} onChange={(event) => setRelink(event.target.checked)} />重新关联此路径的当前文件</label>
      {relink && <p>用于路径目标已改变的来源。历史快照保留原身份；请从当前文件重新选择引用。</p>}
      <button type="button" disabled={disabled || loading || !linkPath.trim()} onClick={() => {
      setLoading(true); setIndexError("");
      void projectApi.register(linkPath.trim(), relink).then((value) => { setProject(value); setSelectedPath(value.registeredPath); setLinkPath(""); setRelink(false); setRefresh((value) => value + 1); })
        .catch((caught) => setIndexError(caught instanceof Error ? caught.message : String(caught))).finally(() => setLoading(false));
    }}>关联并预览</button><p>只登记来源并只读预览，不切换活动文档，也不启动 Agent。</p></details>
    <label className="workbenchField">来源文档
      <select aria-label="选择引用来源文档" value={selectedPath} disabled={disabled} onChange={(event) => { setSelectedPath(event.target.value); setPreview(null); setSearch(""); }}>
        <option value={document.path}>当前文档 · {document.title}</option>
        {project?.documents.filter((item) => item.path !== document.path).map((item) => <option key={item.path} value={item.path} disabled={!item.available}>
          {item.title} · {item.path}{item.external ? " · 项目外" : ""}{!item.available ? " · 来源不可用" : ""}
        </option>)}
      </select>
    </label>
    <div className="workbenchActions"><small>{project ? <time dateTime={project.checkedAt}>目录检查：{new Date(project.checkedAt).toLocaleString()}</time> : "正在读取已登记文档…"}</small><button type="button" disabled={disabled || loading} onClick={() => { setPreview(null); setRefresh((value) => value + 1); }}>刷新来源</button></div>
    {!isCurrent && <p className="workbenchDescription">只读预览 · {selectedPath}{loaded?.external || project?.documents.find((item) => item.path === selectedPath)?.external ? " · 项目外文档" : ""}</p>}
    {indexError && <p className="workbenchError" role="alert">项目文档列表不可用：{indexError}。可继续引用当前文档。</p>}
    {previewError && <p className="workbenchError" role="alert">{previewError}</p>}
    {loading && <p role="status">正在只读加载来源…</p>}
    <input aria-label="搜索参考资料" placeholder="搜索章节、问题或回答…" value={search} onChange={(event) => { setSearch(event.target.value); setPreview(null); }} />
    {preview && (isCurrent || !loading) ? <div className="referencePreview">
      <strong>{preview.title}</strong>
      <textarea aria-label="参考原文，可选择片段" readOnly value={preview.content} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} />
      <div className="workbenchActions">
        <button type="button" onClick={() => setPreview(null)}>返回资料</button>
        <button type="button" disabled={disabled || selection.end <= selection.start} onClick={() => onAdd(preview, selection)}>引用选中片段</button>
        <button type="button" disabled={disabled || !preview.content} onClick={() => onAdd(preview)}>引用整项</button>
      </div>
    </div> : <div className="referenceSourceList">
      {sources.filter((source) => `${source.title} ${source.content}`.toLowerCase().includes(search.toLowerCase())).slice(0, 60).map((source) => (
        <button type="button" key={source.key} disabled={disabled} onClick={() => { setPreview(source); setSelection({ start: 0, end: 0 }); }}>
          <span>{source.kind === "document" ? "文档" : "讨论"}</span><strong>{source.title}</strong><small>{source.content.length.toLocaleString()} 字符</small>
        </button>
      ))}
    </div>}
  </div>;
}
