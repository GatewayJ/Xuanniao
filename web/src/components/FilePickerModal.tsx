import { useEffect, useMemo, useState } from "react";
import type { FileBrowserPayload } from "../types";

type FilePickerModalProps = {
  open: boolean;
  currentPath: string;
  browser: FileBrowserPayload;
  loading: boolean;
  error: string;
  onClose: () => void;
  onBrowse: (path: string) => void;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
};

export function FilePickerModal({
  open,
  currentPath,
  browser,
  loading,
  error,
  onClose,
  onBrowse,
  onOpenDirectory,
  onOpenFile
}: FilePickerModalProps) {
  const [query, setQuery] = useState("");
  const [pathInput, setPathInput] = useState(currentPath);
  const [selectedPath, setSelectedPath] = useState(currentPath);

  useEffect(() => {
    if (open) {
      setPathInput(currentPath);
      setSelectedPath(currentPath);
      setQuery("");
    }
  }, [open, currentPath]);

  useEffect(() => {
    if (!open || !browser.directory) return;
    const nextPath = browser.selectedPath || browser.directory;
    setPathInput(nextPath);
    setSelectedPath(browser.selectedPath || "");
  }, [open, browser.directory, browser.selectedPath]);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return browser.entries;
    return browser.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [browser.entries, query]);

  if (!open) return null;

  const openPath = selectedPath || (pathInput.trim() !== browser.directory ? pathInput.trim() : "");

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="fileModal" role="dialog" aria-modal="true" aria-labelledby="file-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="fileModalHeader">
          <div>
            <h2 id="file-modal-title">打开目录或 Markdown 文档</h2>
            <p>{browser.directory || "正在加载目录…"}</p>
          </div>
          <button type="button" className="ghostButton" onClick={onClose}>关闭</button>
        </header>

        <div className="filePathRow">
          <input
            value={pathInput}
            onChange={(event) => {
              setPathInput(event.target.value);
              setSelectedPath("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && pathInput.trim()) onBrowse(pathInput.trim());
            }}
            aria-label="文件或目录路径"
          />
          <button type="button" disabled={!pathInput.trim() || loading} onClick={() => onBrowse(pathInput.trim())}>前往</button>
          <button
            type="button"
            disabled={!browser.directory || loading}
            onClick={() => onOpenDirectory(browser.directory)}
          >
            打开目录
          </button>
          <button
            type="button"
            className="primaryButton"
            disabled={!openPath || loading}
            onClick={() => onOpenFile(openPath)}
          >
            打开文件
          </button>
        </div>

        <div className="fileToolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Markdown 文档…" aria-label="搜索 Markdown 文档" />
          <div className="fileToolbarActions">
            <button type="button" disabled={!browser.parent || loading} onClick={() => browser.parent && onBrowse(browser.parent)}>上一级</button>
            <button type="button" disabled={!browser.directory || loading} onClick={() => onBrowse(browser.directory)}>刷新</button>
          </div>
        </div>

        {error && <div className="fileBrowserError" role="alert">{error}</div>}
        <div className="fileList">
          {loading && <div className="emptyState">正在加载…</div>}
          {!loading && filteredEntries.length === 0 && <div className="emptyState">没有找到目录或 Markdown 文档。</div>}
          {!loading && filteredEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={entry.path === selectedPath || entry.path === currentPath ? "fileRow active" : "fileRow"}
              onClick={() => {
                if (entry.kind === "directory") {
                  onBrowse(entry.path);
                  return;
                }
                setSelectedPath(entry.path);
                setPathInput(entry.path);
              }}
              onDoubleClick={() => entry.kind === "file" && onOpenFile(entry.path)}
            >
              <span className="fileName">{entry.kind === "directory" ? `▸ ${entry.name}` : entry.name}</span>
              <span className="fileDir">{entry.kind === "directory" ? "目录" : "Markdown 文档"}</span>
              {entry.kind === "file" && entry.size !== null && entry.modifiedAt && (
                <span className="fileMeta">{formatFileSize(entry.size)} - {formatDate(entry.modifiedAt)}</span>
              )}
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
