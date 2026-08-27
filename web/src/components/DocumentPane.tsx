import type { CSSProperties, RefObject } from "react";
import type { Block, DocumentPayload, Thread } from "../types";

export type Mode = "edit" | "preview" | "outline";
export const DEFAULT_DOCUMENT_MODE: Mode = "preview";

type DocumentPaneProps = {
  mode: Mode;
  documentData: DocumentPayload | null;
  activeThread: Thread | null;
  editorHostRef: RefObject<HTMLDivElement | null>;
  previewRef: RefObject<HTMLElement | null>;
  onModeChange: (mode: Mode) => void;
  onNavigateToLine: (line: number) => void;
  onPreviewScroll: () => void;
  onPreviewSelectionChange: () => void;
};

export function DocumentPane({
  mode,
  documentData,
  activeThread,
  editorHostRef,
  previewRef,
  onModeChange,
  onNavigateToLine,
  onPreviewScroll,
  onPreviewSelectionChange
}: DocumentPaneProps) {
  const headings = documentData?.blocks.filter((block) => block.type === "heading") || [];
  const activeHeading = nearestHeadingForLine(headings, activeThread?.anchor.lineStart ?? null);

  return (
    <section className="documentPane">
      <div className="paneHeader">
        <div className="tabs">
          <button type="button" className={mode === "preview" ? "tab active" : "tab"} onClick={() => onModeChange("preview")}>预览</button>
          <button type="button" className={mode === "edit" ? "tab active" : "tab"} onClick={() => onModeChange("edit")}>编辑</button>
          <button type="button" className={mode === "outline" ? "tab active" : "tab"} onClick={() => onModeChange("outline")}>大纲</button>
        </div>
        <div className="selectionInfo">{activeThread ? `讨论位于第 ${activeThread.anchor.lineStart || "-"} 行` : "当前没有活动讨论"}</div>
      </div>
      <div className={mode === "edit" ? "editorHost" : "editorHost hidden"} ref={editorHostRef} />
      <article
        className={mode === "preview" ? "preview" : "preview hidden"}
        ref={previewRef}
        onMouseUp={onPreviewSelectionChange}
        onScroll={onPreviewScroll}
      />
      <aside className={mode === "outline" ? "outline" : "outline hidden"}>
        <div className="outlineHeader">
          <div>
            <h2>文档大纲</h2>
            <p>{headings.length} 个标题 · 点击跳转</p>
          </div>
        </div>
        {headings.length === 0 && <div className="emptyState">文档中没有标题。</div>}
        <nav className="outlineTree" aria-label="文档大纲">
        {headings.map((block) => (
          <button
            key={block.id}
            type="button"
            className={block.id === activeHeading?.id ? "outlineItem active" : "outlineItem"}
            style={{ "--depth": Math.max((block.depth || 1) - 1, 0) } as CSSProperties}
            onClick={() => onNavigateToLine(block.lineStart)}
          >
            <span className="outlineMarker" aria-hidden="true" />
            <span className="outlineTitle">{block.content.replace(/^#{1,6}\s+/, "")}</span>
            <span className="outlineLine">第 {block.lineStart} 行</span>
          </button>
        ))}
        </nav>
      </aside>
    </section>
  );
}

function nearestHeadingForLine(headings: Block[], line: number | null): Block | null {
  if (!line) return null;
  let candidate: Block | null = null;
  for (const heading of headings) {
    if (heading.lineStart <= line) candidate = heading;
    else break;
  }
  return candidate;
}
