import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type { FileBrowserEntry, FileBrowserPayload } from "../types";

type WorkspaceTreeProps = {
  rootPath: string;
  currentPath: string;
  collapsed: boolean;
  openingPath: string | null;
  onBrowse: (path: string) => Promise<FileBrowserPayload>;
  onChooseDirectory: () => void;
  onOpenFile: (path: string) => void;
  onToggleCollapsed: () => void;
};

type DirectoryEntries = Record<string, FileBrowserEntry[]>;

export function WorkspaceTree({
  rootPath,
  currentPath,
  collapsed,
  openingPath,
  onBrowse,
  onChooseDirectory,
  onOpenFile,
  onToggleCollapsed
}: WorkspaceTreeProps) {
  const [entriesByDirectory, setEntriesByDirectory] = useState<DirectoryEntries>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const rootGenerationRef = useRef(0);
  const normalizedRoot = normalizePath(rootPath);
  const activeDirectoryChain = useMemo(
    () => directoryPathChain(rootPath, currentPath),
    [rootPath, currentPath]
  );

  useEffect(() => {
    const generation = rootGenerationRef.current + 1;
    rootGenerationRef.current = generation;
    setEntriesByDirectory({});
    setExpandedPaths(new Set([normalizedRoot, ...activeDirectoryChain]));
    setLoadingPaths(new Set());
    setError("");

    if (!rootPath) return;
    void Promise.all([...new Set([rootPath, ...activeDirectoryChain])].map(async (directory) => {
      await loadDirectory(directory, generation);
    }));
  }, [rootPath]);

  useEffect(() => {
    if (!rootPath || activeDirectoryChain.length === 0) return;
    setExpandedPaths((current) => new Set([...current, ...activeDirectoryChain]));
    const generation = rootGenerationRef.current;
    void Promise.all(activeDirectoryChain.map(async (directory) => {
      if (entriesByDirectory[normalizePath(directory)]) return;
      await loadDirectory(directory, generation);
    }));
  }, [currentPath]);

  async function loadDirectory(path: string, generation = rootGenerationRef.current) {
    const normalizedPath = normalizePath(path);
    setLoadingPaths((current) => new Set(current).add(normalizedPath));
    try {
      const payload = await onBrowse(path);
      if (generation !== rootGenerationRef.current) return;
      setEntriesByDirectory((current) => ({
        ...current,
        [normalizePath(payload.directory)]: payload.entries
      }));
      setError("");
    } catch (loadError) {
      if (generation !== rootGenerationRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (generation === rootGenerationRef.current) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(normalizedPath);
          return next;
        });
      }
    }
  }

  function toggleDirectory(path: string) {
    const normalizedPath = normalizePath(path);
    if (expandedPaths.has(normalizedPath)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(normalizedPath);
        return next;
      });
      return;
    }

    setExpandedPaths((current) => new Set(current).add(normalizedPath));
    if (!entriesByDirectory[normalizedPath]) void loadDirectory(path);
  }

  function refreshTree() {
    const generation = rootGenerationRef.current;
    const directories = [...expandedPaths];
    if (directories.length === 0 && rootPath) directories.push(rootPath);
    void Promise.all(directories.map((directory) => loadDirectory(directory, generation)));
  }

  const rootName = baseName(rootPath) || rootPath || "目录";
  const rootExpanded = expandedPaths.has(normalizedRoot);
  const rootLoading = loadingPaths.has(normalizedRoot);

  if (collapsed) {
    return (
      <aside className="fileTreePane collapsed" aria-label="已收起的目录文件树">
        <button
          type="button"
          className="fileTreeExpandButton"
          onClick={onToggleCollapsed}
          aria-label="展开目录"
          title="展开目录"
        >
          <span aria-hidden="true">›</span>
          <small>目录</small>
        </button>
      </aside>
    );
  }

  return (
    <aside className="fileTreePane" aria-label="目录文件树">
      <header className="fileTreeHeader">
        <div>
          <span>目录</span>
          <strong title={rootPath}>{rootName}</strong>
        </div>
        <div className="fileTreeHeaderActions">
          <button type="button" onClick={refreshTree} disabled={!rootPath} aria-label="刷新目录" title="刷新目录">
            ↻
          </button>
          <button type="button" onClick={onChooseDirectory}>打开</button>
          <button
            type="button"
            className="fileTreeCollapseButton"
            onClick={onToggleCollapsed}
            aria-label="收起目录"
            title="收起目录"
          >
            ‹
          </button>
        </div>
      </header>

      {error && <div className="fileTreeError" role="alert">{error}</div>}
      <div className="fileTreeScroll">
        {!rootPath && <div className="fileTreeEmpty">正在加载目录…</div>}
        {rootPath && (
          <div className="fileTree" role="tree" aria-label={rootName} aria-busy={rootLoading}>
            <DirectoryRow
              path={rootPath}
              name={rootName}
              depth={0}
              expanded={rootExpanded}
              loading={rootLoading}
              entriesByDirectory={entriesByDirectory}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              currentPath={currentPath}
              openingPath={openingPath}
              onToggleDirectory={toggleDirectory}
              onOpenFile={onOpenFile}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

type DirectoryRowProps = {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
  entriesByDirectory: DirectoryEntries;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  currentPath: string;
  openingPath: string | null;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
};

function DirectoryRow(props: DirectoryRowProps) {
  const entries = props.entriesByDirectory[normalizePath(props.path)];
  const rowStyle = { "--file-tree-depth": props.depth } as CSSProperties;

  return (
    <div className="fileTreeBranch" role="treeitem" aria-expanded={props.expanded}>
      <button
        type="button"
        className="fileTreeRow directory"
        style={rowStyle}
        onClick={() => props.onToggleDirectory(props.path)}
        title={props.path}
      >
        <span className={props.expanded ? "fileTreeChevron expanded" : "fileTreeChevron"} aria-hidden="true">›</span>
        <FolderIcon open={props.expanded} />
        <span className="fileTreeName">{props.name}</span>
        {props.loading && <span className="fileTreeLoading" aria-label="正在加载" />}
      </button>

      {props.expanded && (
        <div className="fileTreeChildren" role="group">
          {!props.loading && entries?.length === 0 && <div className="fileTreeEmpty nested">空目录</div>}
          {entries?.map((entry) => entry.kind === "directory" ? (
            <DirectoryRow
              key={entry.path}
              {...props}
              path={entry.path}
              name={entry.name}
              depth={props.depth + 1}
              expanded={props.expandedPaths.has(normalizePath(entry.path))}
              loading={props.loadingPaths.has(normalizePath(entry.path))}
            />
          ) : (
            <FileRow
              key={entry.path}
              entry={entry}
              depth={props.depth + 1}
              active={samePath(entry.path, props.currentPath)}
              opening={samePath(entry.path, props.openingPath || "")}
              onOpenFile={props.onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({
  entry,
  depth,
  active,
  opening,
  onOpenFile
}: {
  entry: FileBrowserEntry;
  depth: number;
  active: boolean;
  opening: boolean;
  onOpenFile: (path: string) => void;
}) {
  const rowStyle = { "--file-tree-depth": depth } as CSSProperties;
  return (
    <button
      type="button"
      role="treeitem"
      className={active ? "fileTreeRow file active" : "fileTreeRow file"}
      style={rowStyle}
      aria-current={active ? "page" : undefined}
      disabled={opening}
      onClick={() => !active && onOpenFile(entry.path)}
      title={entry.path}
    >
      <span className="fileTreeChevron placeholder" aria-hidden="true" />
      <FileIcon />
      <span className="fileTreeName">{entry.name}</span>
      {opening && <span className="fileTreeLoading" aria-label="正在打开" />}
    </button>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="fileTreeIcon folder" viewBox="0 0 20 20" aria-hidden="true">
      <path d={open ? "M2.5 6.5h15l-1.7 8.5H4.2L2.5 6.5Z" : "M2.5 5h5l1.5 2h8.5v8H2.5V5Z"} />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="fileTreeIcon file" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 2.5h6l4 4V17.5H5V2.5Z" />
      <path d="M11 2.5V7h4" />
    </svg>
  );
}

export function directoryPathChain(rootPath: string, filePath: string): string[] {
  const root = normalizePath(rootPath);
  const file = normalizePath(filePath);
  const childPrefix = root === "/" ? "/" : `${root}/`;
  if (!root || !file || (file !== root && !file.startsWith(childPrefix))) return [];
  const relativePath = root === "/" ? file.slice(1) : file.slice(root.length);
  const relativeParts = relativePath.split("/").filter(Boolean);
  relativeParts.pop();
  const result = [root];
  let current = root;
  for (const part of relativeParts) {
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    result.push(current);
  }
  return result;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || (value.startsWith("/") ? "/" : normalized);
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function baseName(value: string): string {
  return normalizePath(value).split("/").filter(Boolean).pop() || "";
}
