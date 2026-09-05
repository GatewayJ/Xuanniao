import { useEffect, useMemo, useState } from "react";

import type { DocumentCreationRetry, NewDocumentCommand } from "../document-creation";
import type { AgentRunSnapshot, FileBrowserPayload, Message, PermissionRequest } from "../types";
import { AgentRunTimeline } from "./AgentRunTimeline";
import { DirectoryPickerModal } from "./DirectoryPickerModal";
import { PermissionRequestPanel } from "./PermissionRequestPanel";
import { useDiscussionWorkspace } from "./DiscussionWorkspaceContext";

type NewDocumentModalProps = {
  retry?: DocumentCreationRetry | null;
  open: boolean;
  workspaceRoot: string;
  creating: boolean;
  error: string;
  run: AgentRunSnapshot | null;
  directoryBrowser: FileBrowserPayload;
  directoryLoading: boolean;
  directoryError: string;
  permissionRequests: PermissionRequest[];
  resolvingPermissionIds: Set<string>;
  onClose: () => void;
  onBrowseDirectory: (path: string) => void;
  onCreate: (command: NewDocumentCommand) => void;
  onResolvePermission: (requestId: string, optionId: string | null) => void;
};

export function NewDocumentModal(props: NewDocumentModalProps) {
  const workspace = useDiscussionWorkspace();
  const [instruction, setInstruction] = useState(props.retry?.command.instruction || "");
  const [directory, setDirectory] = useState(props.retry?.command.directory || "");
  const [fileName, setFileName] = useState(props.retry?.command.fileName || "");
  const [retryReviewed, setRetryReviewed] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);

  useEffect(() => {
    if (props.open && !props.creating) {
      setInstruction(props.retry?.command.instruction || "");
      setDirectory(props.retry?.command.directory || "");
      setFileName(props.retry?.command.fileName || "");
      setRetryReviewed(false);
      setDirectoryPickerOpen(false);
    }
  }, [props.open, props.retry?.recordId]);

  const runMessage = useMemo(() => props.run ? messageForRun(props.run) : null, [props.run]);
  const creationThreadId = props.run ? `document-creation-${props.run.id}` : null;
  const permissionRequests = props.permissionRequests.filter((request) => (
    request.threadId === creationThreadId || request.threadId === null
  ));

  if (!props.open) return null;

  function submit() {
    if (!instruction.trim() || props.creating || (props.retry && !retryReviewed)) return;
    props.onCreate({
      instruction: instruction.trim(),
      directory: directory || null,
      fileName: fileName.trim() || null
    });
  }

  return (
    <>
      <div className="modalBackdrop newDocumentBackdrop" role="presentation" onMouseDown={props.onClose}>
        <section
          className="newDocumentModal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-document-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
        <header className="fileModalHeader">
          <div>
            <h2 id="new-document-title">创建新文档</h2>
            <p>用自然语言描述目标，Codex 会分析工作区并生成首版 Markdown。</p>
          </div>
          <button type="button" className="ghostButton" onClick={props.onClose}>关闭</button>
        </header>

        {props.retry && <section className="newDocumentRetry" aria-label="重新创建文档核对">
          <p>来源文档：{props.retry.documentPath}</p>
          {props.retry.createdPath && <p>已创建文件：{props.retry.createdPath}</p>}
          <p>将创建新的执行记录，前次输出和已创建文件保留。请核对已有文件，并在必要时调整目标文件名。</p>
          <details open><summary>前次输出</summary><pre tabIndex={0} aria-label="前次创建输出">{props.retry.previousResult}</pre></details>
          <label><input type="checkbox" checked={retryReviewed} disabled={props.creating} onChange={(event) => setRetryReviewed(event.target.checked)} />已核对前次输出和已创建文件，准备重新创建</label>
        </section>}
        <label className="newDocumentPrompt">
          <span>你想从什么工作开始？</span>
          <textarea
            autoFocus
            value={instruction}
            disabled={props.creating}
            placeholder="例如：创建文档，分析 Issue #123 的意图，并根据当前代码仓库给出解决方案"
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
            }}
          />
        </label>

        <div className="newDocumentDestination">
          <div className="newDocumentDestinationHeader">
            <span>保存位置（可选）</span>
            {(directory || fileName) && (
              <button type="button" className="ghostButton" disabled={props.creating} onClick={() => {
                setDirectory("");
                setFileName("");
              }}>
                恢复自动
              </button>
            )}
          </div>
          <label className="newDocumentDestinationField">
            <span>目录</span>
            <div>
              <input
                aria-label="文档目录"
                readOnly
                value={directory}
                placeholder="由 Codex 自动选择"
              />
              <button type="button" disabled={props.creating} onClick={() => {
                setDirectoryPickerOpen(true);
                props.onBrowseDirectory(directory || props.workspaceRoot);
              }}>
                选择目录
              </button>
            </div>
          </label>
          <label className="newDocumentDestinationField">
            <span>文件名</span>
            <input
              aria-label="文档文件名"
              value={fileName}
              disabled={props.creating}
              placeholder="由 Codex 自动命名，例如 issue-123-solution.md"
              onChange={(event) => setFileName(event.target.value)}
            />
          </label>
          <small>留空时由 Codex 自动决定；手动选择后以这里的目录和文件名为准，已有文件不会被覆盖。</small>
        </div>

        {runMessage && <AgentRunTimeline message={runMessage} variant="floating" />}

        {permissionRequests.length > 0 && (
          <div className="newDocumentPermissions">
            {permissionRequests.map((request) => (
              <PermissionRequestPanel
                key={request.id}
                request={request}
                resolving={props.resolvingPermissionIds.has(request.id)}
                onResolve={props.onResolvePermission}
              />
            ))}
          </div>
        )}

        {props.error && <div className="fileBrowserError" role="alert">{props.error}</div>}
        {props.run?.status === "unknown" && workspace && <button type="button" onClick={() => { props.onClose(); workspace.openResults(); }}>查看运行记录并核对</button>}

        <footer className="newDocumentFooter">
          <span>{props.creating ? "关闭面板后继续生成；停止不会撤销已经创建的文件。" : "可在描述中指定 Issue、代码仓库、输出结构和文件名。"}</span>
          <div>
            <button type="button" onClick={props.onClose}>{props.creating ? "后台继续" : "取消"}</button>
            {props.creating && <button type="button" disabled={!workspace?.canStop} onClick={() => workspace?.stop()}>停止创建</button>}
            <button type="button" className="primaryButton" disabled={!instruction.trim() || props.creating || Boolean(props.retry && !retryReviewed)} onClick={submit}>
              {props.creating ? "正在创建…" : "创建文档"}
            </button>
          </div>
        </footer>
        </section>
      </div>
      <DirectoryPickerModal
        open={directoryPickerOpen}
        workspaceRoot={props.workspaceRoot}
        browser={props.directoryBrowser}
        loading={props.directoryLoading}
        error={props.directoryError}
        onClose={() => setDirectoryPickerOpen(false)}
        onBrowse={props.onBrowseDirectory}
        onSelect={(path) => {
          setDirectory(path);
          setDirectoryPickerOpen(false);
        }}
      />
    </>
  );
}

function messageForRun(run: AgentRunSnapshot): Message {
  return {
    id: `new-document-${run.id}`,
    role: "assistant",
    content: "",
    meta: { agentRun: run },
    createdAt: run.startedAt || new Date().toISOString()
  };
}
