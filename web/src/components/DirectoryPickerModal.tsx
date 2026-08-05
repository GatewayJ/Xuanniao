import type { FileBrowserPayload } from "../types";

type DirectoryPickerModalProps = {
  open: boolean;
  workspaceRoot: string;
  browser: FileBrowserPayload;
  loading: boolean;
  error: string;
  onClose: () => void;
  onBrowse: (path: string) => void;
  onSelect: (path: string) => void;
};

export function DirectoryPickerModal(props: DirectoryPickerModalProps) {
  if (!props.open) return null;
  const directories = props.browser.entries.filter((entry) => entry.kind === "directory");
  const atWorkspaceRoot = samePath(props.browser.directory, props.workspaceRoot);

  return (
    <div className="modalBackdrop directoryPickerBackdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className="directoryPickerModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="directory-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="fileModalHeader">
          <div>
            <h2 id="directory-picker-title">选择保存目录</h2>
            <p>{props.browser.directory || "正在加载工作区…"}</p>
          </div>
          <button type="button" className="ghostButton" onClick={props.onClose}>关闭</button>
        </header>

        <div className="directoryPickerToolbar">
          <button
            type="button"
            disabled={atWorkspaceRoot || !props.browser.parent || props.loading}
            onClick={() => props.browser.parent && props.onBrowse(props.browser.parent)}
          >
            上一级
          </button>
          <button
            type="button"
            className="primaryButton"
            disabled={!props.browser.directory || props.loading}
            onClick={() => props.onSelect(props.browser.directory)}
          >
            选择当前目录
          </button>
        </div>

        {props.error && <div className="fileBrowserError" role="alert">{props.error}</div>}
        <div className="fileList directoryList">
          {props.loading && <div className="emptyState">正在加载…</div>}
          {!props.loading && directories.length === 0 && <div className="emptyState">当前目录没有子目录。</div>}
          {!props.loading && directories.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="fileRow"
              onClick={() => props.onBrowse(entry.path)}
            >
              <span className="fileName">▸ {entry.name}</span>
              <span className="fileDir">目录</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/, "") === right.replace(/[\\/]+$/, "");
}
