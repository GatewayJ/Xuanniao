import { useEffect, useRef, useState } from "react";

import { agentRunForMessage } from "../agent-run";
import { effortLabel } from "../agent-settings-view";
import type { AgentRunState, AgentRunUpdate, Message } from "../types";

export function AgentRunTimeline({ message }: { message: Message }) {
  const run = agentRunForMessage(message);
  const [open, setOpen] = useState(() => Boolean(run && isRunning(run.status)));
  const previousStatus = useRef(run?.status);
  const [, setClock] = useState(0);

  useEffect(() => {
    if (previousStatus.current && isRunning(previousStatus.current) && run && !isRunning(run.status)) {
      setOpen(false);
    }
    previousStatus.current = run?.status;
  }, [run?.status]);

  useEffect(() => {
    if (!run || !isRunning(run.status)) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [run?.status]);

  if (!run) return null;
  const duration = displayDuration(run);
  const execution = executionLabel(message);
  const label = run.status === "failed"
    ? "处理失败"
    : isRunning(run.status)
      ? "处理中"
      : "已处理";

  return (
    <div className={`agentRunTimeline ${isRunning(run.status) ? "running" : "terminal"}`}>
      <button
        type="button"
        className="agentRunToggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {isRunning(run.status) && <span className="agentRunSpinner" aria-hidden="true" />}
        <span>{label}{duration ? ` ${duration}` : ""}</span>
        {run.events.length > 0 && <span className="agentRunCount">{run.events.length} 个步骤</span>}
        {execution && <span className="agentRunExecution">{execution}</span>}
        <span className={`agentRunChevron ${open ? "open" : ""}`} aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="agentRunSteps">
          {run.events.length === 0 ? (
            <div className="agentRunEmpty">正在等待 Codex 开始执行…</div>
          ) : run.events.map((event, index) => (
            <AgentRunStep key={`${event.type}:${event.itemId || event.seq || index}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

function executionLabel(message: Message): string | null {
  const model = typeof message.meta?.model === "string" ? message.meta.model : null;
  const reasoningEffort = typeof message.meta?.reasoningEffort === "string"
    ? message.meta.reasoningEffort
    : null;
  if (!model && !reasoningEffort) return null;
  return [model, reasoningEffort ? effortLabel(reasoningEffort) : null].filter(Boolean).join(" · ");
}

function AgentRunStep({ event }: { event: AgentRunUpdate }) {
  const output = eventOutput(event);
  return (
    <div className={`agentRunStep ${stepState(event.status)}`}>
      <span className="agentRunStepMarker" aria-hidden="true">{stepIcon(event)}</span>
      <div className="agentRunStepBody">
        <div className="agentRunStepTitle">{stepTitle(event)}</div>
        {event.command && <pre className="agentRunOutput"><code>$ {event.command}</code></pre>}
        {event.changes && event.changes.length > 0 && (
          <ul className="agentRunFiles">
            {event.changes.map((change, index) => (
              <li key={`${change.path || "file"}-${index}`}>{change.kind ? `${change.kind} · ` : ""}{change.path || "文件"}</li>
            ))}
          </ul>
        )}
        {event.plan && event.plan.length > 0 && (
          <ol className="agentRunPlan">
            {event.plan.map((entry, index) => (
              <li key={`${entry.step || "step"}-${index}`} className={stepState(entry.status)}>{entry.step || "计划步骤"}</li>
            ))}
          </ol>
        )}
        {output && <pre className="agentRunOutput"><code>{output}</code></pre>}
      </div>
    </div>
  );
}

function displayDuration(run: AgentRunState): string | null {
  const startedAt = Date.parse(run.startedAt || "");
  const durationMs = Number.isFinite(run.durationMs)
    ? Number(run.durationMs)
    : isRunning(run.status) && Number.isFinite(startedAt)
      ? Math.max(0, Date.now() - startedAt)
      : null;
  if (durationMs === null) return null;
  return `${Math.max(0, Math.round(durationMs / 1_000))}s`;
}

function stepTitle(event: AgentRunUpdate): string {
  switch (event.type) {
    case "commandExecution": return `运行命令${event.exitCode !== null && event.exitCode !== undefined ? ` · 退出码 ${event.exitCode}` : ""}`;
    case "fileChange": return "修改文件";
    case "mcpToolCall": return `调用工具${event.server ? ` · ${event.server}` : ""}${event.tool ? ` / ${event.tool}` : ""}`;
    case "dynamicToolCall": return `调用工具${event.tool ? ` · ${event.tool}` : ""}`;
    case "toolCall": return event.title || event.tool || "调用工具";
    case "webSearch": return `搜索网页${event.query ? ` · ${truncate(event.query, 120)}` : ""}`;
    case "reasoning": return "整理分析摘要";
    case "plan": return "更新执行计划";
    case "collabToolCall": return `协作任务${event.tool ? ` · ${event.tool}` : ""}`;
    case "imageView": return `查看图片${event.path ? ` · ${event.path}` : ""}`;
    case "contextCompaction": return "整理上下文";
    case "error": return event.message || "执行出错";
    default: return event.title || event.type || "执行步骤";
  }
}

function eventOutput(event: AgentRunUpdate): string {
  return event.error || event.result || event.output || event.summary || event.action || event.message || "";
}

function stepIcon(event: AgentRunUpdate): string {
  if (stepState(event.status) === "failed") return "!";
  if (stepState(event.status) === "completed") return "✓";
  return "·";
}

function stepState(status?: string): "running" | "completed" | "failed" {
  if (status === "failed" || status === "error" || status === "declined") return "failed";
  if (status === "completed" || status === "success") return "completed";
  return "running";
}

function isRunning(status: AgentRunState["status"]): boolean {
  return status === "waiting" || status === "running";
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
