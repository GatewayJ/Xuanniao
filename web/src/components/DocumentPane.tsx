import type { CSSProperties, RefObject } from "react";
import type { Block, DocumentPayload, Thread } from "../types";

export type Mode = "edit" | "preview" | "outline";

type DocumentPaneProps = {
  mode: Mode;
  documentData: DocumentPayload | null;
  activeThread: Thread | null;
  editorHostRef: RefObject<HTMLDivElement | null>;
  previewRef: RefObject<HTMLElement | null>;
  onModeChange: (mode: Mode) => void;
  onNavigateToLine: (line: number) => void;
  onPreviewScroll: () => void;
};

export function DocumentPane({
  mode,
  documentData,
  activeThread,
  editorHostRef,
  previewRef,
  onModeChange,
  onNavigateToLine,
  onPreviewScroll
}: DocumentPaneProps) {
  const headings = documentData?.blocks.filter((block) => block.type === "heading") || [];
  const activeHeading = nearestHeadingForLine(headings, activeThread?.anchor.lineStart ?? null);

  return (
    <section className="documentPane">
      <div className="paneHeader">
        <div className="tabs">
          <button type="button" className={mode === "edit" ? "tab active" : "tab"} onClick={() => onModeChange("edit")}>Edit</button>
          <button type="button" className={mode === "preview" ? "tab active" : "tab"} onClick={() => onModeChange("preview")}>Preview</button>
          <button type="button" className={mode === "outline" ? "tab active" : "tab"} onClick={() => onModeChange("outline")}>Outline</button>
        </div>
        <div className="selectionInfo">{activeThread ? `Thread line ${activeThread.anchor.lineStart || "-"}` : "No active thread"}</div>
      </div>
      <div className={mode === "edit" ? "editorHost" : "editorHost hidden"} ref={editorHostRef} />
      <article className={mode === "preview" ? "preview" : "preview hidden"} ref={previewRef} onScroll={onPreviewScroll} />
      <aside className={mode === "outline" ? "outline" : "outline hidden"}>
        <div className="outlineHeader">
          <div>
            <h2>Document Outline</h2>
            <p>{headings.length} headings · click to jump</p>
          </div>
        </div>
        {headings.length === 0 && <div className="emptyState">No headings found.</div>}
        <nav className="outlineTree" aria-label="Document outline">
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
            <span className="outlineLine">Line {block.lineStart}</span>
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
