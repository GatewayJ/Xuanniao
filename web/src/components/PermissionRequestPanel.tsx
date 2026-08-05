import { formatRelativeTime } from "../relative-time";
import type { PermissionOption, PermissionRequest } from "../types";

type PermissionRequestPanelProps = {
  request: PermissionRequest;
  resolving: boolean;
  onResolve: (requestId: string, optionId: string | null) => void;
};

export function PermissionRequestPanel(props: PermissionRequestPanelProps) {
  const allowOnce = optionByKind(props.request.options, "allow_once");
  const allowAlways = optionByKind(props.request.options, "allow_always");
  const rejectOnce = optionByKind(props.request.options, "reject_once");
  const rejectAlways = optionByKind(props.request.options, "reject_always");
  const fallbackOptions = props.request.options.filter((option) => (
    option !== allowOnce && option !== allowAlways && option !== rejectOnce && option !== rejectAlways
  ));

  return (
    <section className="permissionRequest">
      <div className="permissionRequestHeader">
        <span>权限请求</span>
        <time>{formatRelativeTime(props.request.createdAt)}</time>
      </div>
      <div className="permissionRequestTitle">{props.request.title}</div>
      {props.request.sourceAgentName && (
        <div className="permissionRequestSource">来自 Subagent · {props.request.sourceAgentName}</div>
      )}
      {props.request.rawInput && <div className="permissionRequestDetail">{props.request.rawInput}</div>}
      <div className="permissionRequestActions">
        {allowOnce && (
          <button type="button" className="primaryButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, allowOnce.optionId)}>
            允许一次
          </button>
        )}
        {allowAlways && (
          <button type="button" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, allowAlways.optionId)}>
            始终允许
          </button>
        )}
        {rejectOnce && (
          <button type="button" className="dangerButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, rejectOnce.optionId)}>
            拒绝一次
          </button>
        )}
        {rejectAlways && (
          <button type="button" className="dangerButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, rejectAlways.optionId)}>
            始终拒绝
          </button>
        )}
        {fallbackOptions.map((option) => (
          <button key={option.optionId} type="button" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, option.optionId)}>
            {labelForPermissionOption(option)}
          </button>
        ))}
        <button type="button" className="ghostButton" disabled={props.resolving} onClick={() => props.onResolve(props.request.id, null)}>
          取消
        </button>
      </div>
    </section>
  );
}

function optionByKind(options: PermissionOption[], kind: string): PermissionOption | null {
  return options.find((option) => option.kind === kind) || null;
}

function labelForPermissionOption(option: PermissionOption): string {
  const knownLabels: Record<string, string> = {
    allow_once: "允许一次",
    allow_always: "始终允许",
    reject_once: "拒绝一次",
    reject_always: "始终拒绝"
  };
  const knownLabel = knownLabels[option.kind];
  if (knownLabel) return knownLabel;
  const label = option.name.trim();
  if (label) return label;
  return option.kind.replace(/_/g, " ");
}
