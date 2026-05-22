import { useEffect, useMemo, useState } from "react";
import type { MarkdownFile } from "../types";

type FilePickerModalProps = {
  open: boolean;
  root: string;
  currentPath: string;
  files: MarkdownFile[];
  onClose: () => void;
  onRefresh: () => void;
  onBrowse: () => void;
  onOpenFile: (path: string) => void;
};

export function FilePickerModal({ open, root, currentPath, files, onClose, onRefresh, onBrowse, onOpenFile }: FilePickerModalProps) {
  const [query, setQuery] = useState("");
  const [pathInput, setPathInput] = useState(currentPath);

  useEffect(() => {
    if (open) {
      setPathInput(currentPath);
      setQuery("");
    }
  }, [open, currentPath]);

  const filteredFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((file) => `${file.relativePath} ${file.name} ${file.directory}`.toLowerCase().includes(needle));
  }, [files, query]);

  if (!open) return null;

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="fileModal" role="dialog" aria-modal="true" aria-labelledby="file-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="fileModalHeader">
          <div>
            <h2 id="file-modal-title">Open Markdown File</h2>
            <p>{root}</p>
          </div>
          <button type="button" className="ghostButton" onClick={onClose}>Close</button>
        </header>

        <div className="filePathRow">
          <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} aria-label="Markdown file path" />
          <button type="button" onClick={onBrowse}>Browse...</button>
          <button type="button" className="primaryButton" onClick={() => onOpenFile(pathInput)}>Open</button>
        </div>

        <div className="fileToolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search markdown files..." aria-label="Search markdown files" />
          <button type="button" onClick={onRefresh}>Refresh</button>
        </div>

        <div className="fileList">
          {filteredFiles.length === 0 && <div className="emptyState">No Markdown files found.</div>}
          {filteredFiles.map((file) => (
            <button
              key={file.path}
              type="button"
              className={file.active ? "fileRow active" : "fileRow"}
              onClick={() => setPathInput(file.relativePath)}
              onDoubleClick={() => onOpenFile(file.relativePath)}
            >
              <span className="fileName">{file.name}</span>
              <span className="fileDir">{file.directory || "workspace root"}</span>
              <span className="fileMeta">{formatFileSize(file.size)} - {formatDate(file.modifiedAt)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
