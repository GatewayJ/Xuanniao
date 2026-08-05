import { useEffect, useMemo, useState } from "react";

import type { AgentRunSnapshot, FileBrowserPayload, Message, PermissionRequest } from "../types";
import { AgentRunTimeline } from "./AgentRunTimeline";
import { DirectoryPickerModal } from "./DirectoryPickerModal";
import { PermissionRequestPanel } from "./PermissionRequestPanel";

export type NewDocumentCommand = {
  instruction: string;
  directory: string | null;
  fileName: string | null;
};

type NewDocumentModalProps = {
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
  const [instruction, setInstruction] = useState("");
  const [directory, setDirectory] = useState("");
  const [fileName, setFileName] = useState("");
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);

  useEffect(() => {
    if (props.open && !props.creating) {
      setInstruction("");
      setDirectory("");
      setFileName("");
      setDirectoryPickerOpen(false);
    }
  }, [props.open]);

  const runMessage = useMemo(() => props.run ? messageForRun(props.run) : null, [props.run]);
  const creationThreadId = props.run ? `document-creation-${props.run.id}` : null;
  const permissionRequests = props.permissionRequests.filter((request) => (
    request.threadId === creationThreadId || request.threadId === null
  ));

  if (!props.open) return null;

  function submit() {
    if (!instruction.trim() || props.creating) return;
    props.onCreate({
      instruction: instruction.trim(),
      directory: directory || null,
      fileName: fileName.trim() || null
    });
  }

  return (
    <>
      <div className="modalBackdrop newDocumentBackdrop" role="presentation" onMouseDown={() => !props.creating && props.onClose()}>
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
          <button type="button" className="ghostButton" disabled={props.creating} onClick={props.onClose}>关闭</button>
        </header>

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

        <footer className="newDocumentFooter">
          <span>可在描述中指定 Issue、代码仓库、输出结构和文件名。</span>
          <div>
            <button type="button" disabled={props.creating} onClick={props.onClose}>取消</button>
            <button type="button" className="primaryButton" disabled={!instruction.trim() || props.creating} onClick={submit}>
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
