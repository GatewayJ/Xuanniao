import { useEffect, useRef, useState } from "react";

import { agentRunForMessage, agentRunUpdateKey } from "../agent-run";
import { effortLabel } from "../agent-settings-view";
import type { AgentRunState, AgentRunUpdate, Message } from "../types";

type AgentRunTimelineProps = {
  message: Message;
  variant?: "inline" | "floating";
};

type SubagentView = {
  threadId: string;
  lifecycle: AgentRunUpdate;
  events: AgentRunUpdate[];
};

export function AgentRunTimeline({ message, variant = "inline" }: AgentRunTimelineProps) {
  const run = agentRunForMessage(message);
  const floating = variant === "floating";
  const [open, setOpen] = useState(() => floating || Boolean(run && isRunning(run.status)));
  const previousStatus = useRef(run?.status);
  const [, setClock] = useState(0);

  useEffect(() => {
    if (previousStatus.current && isRunning(previousStatus.current) && run && !isRunning(run.status)) {
      setOpen(false);
    } else if (floating && run && isRunning(run.status)) {
      setOpen(true);
    }
    previousStatus.current = run?.status;
  }, [floating, run?.status]);

  useEffect(() => {
    if (!run || !isRunning(run.status)) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [run?.status]);

  if (!run) return null;
  const summary = summarizeAgentRun(run);
  const duration = displayDuration(run);
  const execution = executionLabel(message);
  const label = run.status === "failed"
    ? "执行失败"
    : isRunning(run.status)
      ? summary.plan
        ? `第 ${summary.currentStep}/${summary.totalSteps} 步`
        : "Codex 正在执行"
      : "执行留档";

  return (
    <section className={`agentRunTimeline ${isRunning(run.status) ? "running" : "terminal"} ${floating ? "floating" : "inline"}`}>
      <button
        type="button"
        className="agentRunToggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {isRunning(run.status) && <span className="agentRunSpinner" aria-hidden="true" />}
        <span>{label}{duration ? ` · ${duration}` : ""}</span>
        {summary.subagents.length > 0 && <span className="agentRunCount">{summary.subagents.length} 个 Subagent</span>}
        {summary.filesChanged !== null && (
          <span className="agentRunDiffStats">
            {summary.filesChanged} 个文件 <ins>+{summary.additions || 0}</ins> <del>−{summary.deletions || 0}</del>
          </span>
        )}
        {execution && <span className="agentRunExecution">{execution}</span>}
        <span className={`agentRunChevron ${open ? "open" : ""}`} aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="agentRunDetails">
          {summary.plan ? (
            <ol className="agentRunPlan agentRunPrimaryPlan">
              {summary.plan.plan?.map((entry, index) => (
                <li key={`${entry.step || "step"}-${index}`} className={stepState(entry.status)}>
                  <span className="agentRunPlanMarker" aria-hidden="true">{planIcon(entry.status)}</span>
                  <span>{entry.step || "计划步骤"}</span>
                </li>
              ))}
            </ol>
          ) : summary.mainEvents.length === 0 && summary.subagents.length === 0 ? (
            <div className="agentRunEmpty">正在等待 Codex 开始执行…</div>
          ) : (
            <div className="agentRunEmpty active">Codex 正在执行，尚未发布计划。</div>
          )}

          {summary.subagents.length > 0 && (
            <div className="agentRunSubagents">
              {summary.subagents.map((subagent) => (
                <SubagentDetails key={subagent.threadId} subagent={subagent} running={isRunning(run.status)} />
              ))}
            </div>
          )}

          {summary.mainEvents.length > 0 && (
            <details className="agentRunActivity" open={!summary.plan && summary.subagents.length === 0}>
              <summary>执行明细 · {summary.mainEvents.length}</summary>
              <div className="agentRunSteps">
                {summary.mainEvents.map((event, index) => (
                  <AgentRunStep key={agentRunUpdateKey(event) || `${event.type}:${event.seq || index}`} event={event} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export function summarizeAgentRun(run: AgentRunState) {
  const mainPlan = [...run.events].reverse().find((event) => event.type === "plan" && event.scope !== "subagent") || null;
  const planEntries = mainPlan?.plan || [];
  const firstIncomplete = planEntries.findIndex((entry) => stepState(entry.status) !== "completed");
  const currentStep = planEntries.length === 0
    ? 0
    : firstIncomplete >= 0
      ? firstIncomplete + 1
      : planEntries.length;
  const diff = latestDiffSummary(run.events);
  const lifecycleByThread = new Map<string, AgentRunUpdate>();
  const scopedEvents = new Map<string, AgentRunUpdate[]>();

  for (const event of run.events) {
    if (event.type === "subagent" && event.agentThreadId) {
      lifecycleByThread.set(event.agentThreadId, { ...lifecycleByThread.get(event.agentThreadId), ...event });
    }
    if (event.scope === "subagent" && event.agentThreadId && event.type !== "subagent") {
      const events = scopedEvents.get(event.agentThreadId) || [];
      events.push(event);
      scopedEvents.set(event.agentThreadId, events);
    }
  }

  const subagents: SubagentView[] = [...new Set([...lifecycleByThread.keys(), ...scopedEvents.keys()])].map((threadId) => ({
    threadId,
    lifecycle: lifecycleByThread.get(threadId) || {
      type: "subagent",
      scope: "subagent",
      agentThreadId: threadId,
      agentStatus: "running"
    },
    events: scopedEvents.get(threadId) || []
  }));
  const mainEvents = run.events.filter((event) => (
    event.scope !== "subagent" && event.type !== "plan" && event.type !== "diff" && event.type !== "subagent"
  ));

  return {
    plan: mainPlan,
    currentStep,
    totalSteps: planEntries.length,
    filesChanged: diff?.filesChanged ?? null,
    additions: diff?.additions ?? null,
    deletions: diff?.deletions ?? null,
    subagents,
    mainEvents
  };
}

function latestDiffSummary(events: AgentRunUpdate[]): AgentRunUpdate | null {
  const main = [...events].reverse().find((event) => event.type === "diff" && event.scope !== "subagent");
  if (main) return main;
  const latestByAgent = new Map<string, AgentRunUpdate>();
  for (const event of events) {
    if (event.type === "diff") latestByAgent.set(event.agentThreadId || "main", event);
  }
  if (latestByAgent.size === 0) return null;
  return [...latestByAgent.values()].reduce<AgentRunUpdate>((total, event) => ({
    type: "diff",
    filesChanged: (total.filesChanged || 0) + (event.filesChanged || 0),
    additions: (total.additions || 0) + (event.additions || 0),
    deletions: (total.deletions || 0) + (event.deletions || 0)
  }), { type: "diff", filesChanged: 0, additions: 0, deletions: 0 });
}

function SubagentDetails({ subagent, running }: { subagent: SubagentView; running: boolean }) {
  const event = subagent.lifecycle;
  const status = subagentStatus(event, running);
  const duration = subagentDuration(event, running);
  const plan = [...subagent.events].reverse().find((item) => item.type === "plan");
  const diff = [...subagent.events].reverse().find((item) => item.type === "diff");
  const result = event.result || [...subagent.events].reverse().find((item) => item.result || item.message)?.result;
  return (
    <details className={`agentRunSubagent ${stepState(status)}`}>
      <summary>
        <span className="agentRunSubagentState" aria-hidden="true">{stepIcon({ ...event, status })}</span>
        <span className="agentRunSubagentIdentity">
          <strong>{event.agentName || event.agentRole || "Subagent"}</strong>
          {event.task && <small>{event.task}</small>}
        </span>
        <span className="agentRunSubagentMeta">
          {[event.agentRole, event.model, event.reasoningEffort ? effortLabel(event.reasoningEffort) : null]
            .filter(Boolean).join(" · ")}
        </span>
        <span className="agentRunSubagentStatus">
          {subagentStatusLabel(status)}{duration ? ` · ${duration}` : ""}
        </span>
      </summary>
      <div className="agentRunSubagentBody">
        {plan?.plan && plan.plan.length > 0 && (
          <ol className="agentRunPlan compact">
            {plan.plan.map((entry, index) => (
              <li key={`${entry.step || "step"}-${index}`} className={stepState(entry.status)}>{entry.step || "计划步骤"}</li>
            ))}
          </ol>
        )}
        {diff?.filesChanged !== undefined && (
          <div className="agentRunSubagentDiff">
            {diff.filesChanged} 个文件 <ins>+{diff.additions || 0}</ins> <del>−{diff.deletions || 0}</del>
          </div>
        )}
        {subagent.events.filter((item) => item.type !== "plan" && item.type !== "diff").map((item, index) => (
          <AgentRunStep key={agentRunUpdateKey(item) || `${item.type}:${item.seq || index}`} event={item} />
        ))}
        {result && <pre className="agentRunOutput"><code>{result}</code></pre>}
        {subagent.events.length === 0 && !result && <div className="agentRunEmpty">等待 Subagent 活动…</div>}
      </div>
    </details>
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
    case "diff": return `代码变更${event.filesChanged !== undefined ? ` · ${event.filesChanged} 个文件` : ""}`;
    case "mcpToolCall": return `调用工具${event.server ? ` · ${event.server}` : ""}${event.tool ? ` / ${event.tool}` : ""}`;
    case "dynamicToolCall": return `调用工具${event.tool ? ` · ${event.tool}` : ""}`;
    case "toolCall": return event.title || event.tool || "调用工具";
    case "webSearch": return `搜索网页${event.query ? ` · ${truncate(event.query, 120)}` : ""}`;
    case "reasoning": return "整理分析摘要";
    case "plan": return "更新执行计划";
    case "subagent": return `Subagent${event.agentName ? ` · ${event.agentName}` : ""}`;
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
  if (stepState(event.status || event.agentStatus) === "failed") return "!";
  if (stepState(event.status || event.agentStatus) === "completed") return "✓";
  return "·";
}

function planIcon(status?: string): string {
  return stepState(status) === "completed" ? "✓" : stepState(status) === "failed" ? "!" : "";
}

function subagentStatus(event: AgentRunUpdate, parentRunning: boolean): string {
  if (event.agentStatus) return event.agentStatus;
  if (event.status && event.status !== "inProgress") return event.status;
  return parentRunning ? "running" : "completed";
}

function subagentStatusLabel(status: string): string {
  if (["failed", "error", "errored", "notFound", "declined"].includes(status)) return "失败";
  if (status === "interrupted") return "已中断";
  if (["completed", "success", "idle", "shutdown"].includes(status)) return "完成";
  return "执行中";
}

function subagentDuration(event: AgentRunUpdate, running: boolean): string | null {
  const startedAt = Date.parse(event.startedAt || event.at || "");
  const durationMs = Number.isFinite(event.durationMs)
    ? Number(event.durationMs)
    : running && Number.isFinite(startedAt)
      ? Math.max(0, Date.now() - startedAt)
      : null;
  return durationMs === null ? null : `${Math.max(0, Math.round(durationMs / 1_000))}s`;
}

function stepState(status?: string): "running" | "completed" | "failed" {
  if (["failed", "error", "errored", "notFound", "declined"].includes(status || "")) return "failed";
  if (["completed", "success", "idle", "shutdown", "interrupted"].includes(status || "")) return "completed";
  return "running";
}

function isRunning(status: AgentRunState["status"]): boolean {
  return status === "waiting" || status === "running";
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
