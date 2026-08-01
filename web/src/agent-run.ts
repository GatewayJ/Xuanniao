import type { AgentRunSnapshot, AgentRunState, AgentRunUpdate, Message, Thread } from "./types";

export type ResumableAgentRun = {
  threadId: string;
  userMessageId: string;
  runId: string;
};

export function createAgentRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `run_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function pendingAgentRunMeta(id: string, startedAt: string): Record<string, unknown> {
  return {
    agentRun: {
      id,
      status: "running",
      startedAt,
      completedAt: null,
      durationMs: null,
      error: null,
      events: []
    } satisfies AgentRunState
  };
}

export function resumableAgentRuns(threads: Thread[]): ResumableAgentRun[] {
  const runs: ResumableAgentRun[] = [];
  for (const thread of threads) {
    const answeredQuestionIds = new Set(
      thread.messages
        .filter((message) => message.role === "assistant" && message.parentId)
        .map((message) => message.parentId)
    );
    for (const message of thread.messages) {
      const runId = message.meta?.agentRunId;
      if (
        message.role === "user"
        && typeof runId === "string"
        && runId
        && !answeredQuestionIds.has(message.id)
      ) {
        runs.push({ threadId: thread.id, userMessageId: message.id, runId });
      }
    }
  }
  return runs;
}

export function restorePendingAgentRun(
  threads: Thread[],
  candidate: ResumableAgentRun,
  snapshot: AgentRunSnapshot
): Thread[] {
  return threads.map((thread) => {
    if (thread.id !== candidate.threadId) return thread;
    const userIndex = thread.messages.findIndex((message) => (
      message.id === candidate.userMessageId && message.role === "user"
    ));
    if (userIndex < 0) return thread;
    if (thread.messages.some((message) => (
      message.role === "assistant" && message.parentId === candidate.userMessageId
    ))) return thread;
    const userMessage = thread.messages[userIndex];
    const pending: Message = {
      id: `pending-agent-${candidate.runId}`,
      role: "assistant",
      content: "",
      nodeId: userMessage.nodeId || userMessage.id,
      parentId: userMessage.id,
      meta: {
        agentRun: {
          ...snapshot,
          events: coalesceAgentRunUpdates(snapshot.events)
        } satisfies AgentRunState
      },
      createdAt: snapshot.startedAt || userMessage.updatedAt || userMessage.createdAt
    };
    const messages = [...thread.messages];
    messages.splice(userIndex + 1, 0, pending);
    return { ...thread, messages };
  });
}

export function applyAgentRunSnapshot(
  threads: Thread[],
  threadId: string,
  runId: string,
  snapshot: AgentRunSnapshot
): Thread[] {
  return updatePendingRun(threads, threadId, runId, () => ({
    ...snapshot,
    events: coalesceAgentRunUpdates(snapshot.events)
  }));
}

export function applyAgentRunUpdate(
  threads: Thread[],
  threadId: string,
  runId: string,
  update: AgentRunUpdate
): Thread[] {
  return updatePendingRun(threads, threadId, runId, (state) => ({
    ...state,
    status: state.status === "waiting" ? "running" : state.status,
    events: mergeAgentRunUpdate(state.events, update)
  }));
}

export function agentRunForMessage(message: Message): AgentRunState | null {
  const live = message.meta?.agentRun;
  if (isAgentRunState(live)) {
    return { ...live, events: coalesceAgentRunUpdates(live.events) };
  }
  const updates = message.meta?.updates;
  const durationMs = message.meta?.durationMs;
  const visibleUpdates = Array.isArray(updates) ? updates.filter(isAgentRunUpdate) : [];
  if (visibleUpdates.length === 0 && !Number.isFinite(durationMs)) return null;
  return {
    id: message.id,
    status: message.error ? "failed" : "completed",
    startedAt: message.createdAt,
    completedAt: message.updatedAt || message.createdAt,
    durationMs: Number.isFinite(durationMs) ? Number(durationMs) : null,
    error: message.error ? "Codex request failed" : null,
    events: coalesceAgentRunUpdates(visibleUpdates)
  };
}

export function activeAgentRunMessage(messages: Message[]): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const run = agentRunForMessage(message);
    if (run?.status === "waiting" || run?.status === "running") return message;
  }
  return null;
}

export function coalesceAgentRunUpdates(updates: AgentRunUpdate[]): AgentRunUpdate[] {
  return updates.reduce<AgentRunUpdate[]>((current, update) => mergeAgentRunUpdate(current, update), []);
}

function updatePendingRun(
  threads: Thread[],
  threadId: string,
  runId: string,
  update: (state: AgentRunState) => AgentRunState
): Thread[] {
  return threads.map((thread) => {
    if (thread.id !== threadId) return thread;
    let changed = false;
    const messages = thread.messages.map((message) => {
      const current = message.meta?.agentRun;
      if (!isAgentRunState(current) || current.id !== runId) return message;
      changed = true;
      return {
        ...message,
        meta: { ...message.meta, agentRun: update(current) }
      };
    });
    return changed ? { ...thread, messages } : thread;
  });
}

function mergeAgentRunUpdate(events: AgentRunUpdate[], incoming: AgentRunUpdate): AgentRunUpdate[] {
  const key = agentRunUpdateKey(incoming);
  if (!key) return selectVisibleAgentRunUpdates([...events, incoming]);
  const index = events.findIndex((event) => agentRunUpdateKey(event) === key);
  if (index < 0) return selectVisibleAgentRunUpdates([...events, normalizeDelta(incoming)]);

  const previous = events[index];
  const next = [...events];
  next[index] = {
    ...previous,
    ...withoutEmptyDisplayFields(incoming),
    output: boundedTail(`${previous.output || ""}${incoming.outputDelta || ""}`, 12_000)
      || incoming.output
      || previous.output,
    summary: boundedTail(`${previous.summary || ""}${incoming.summaryDelta || ""}`, 8_000)
      || incoming.summary
      || previous.summary
  };
  delete next[index].outputDelta;
  delete next[index].summaryDelta;
  return selectVisibleAgentRunUpdates(next);
}

function selectVisibleAgentRunUpdates(events: AgentRunUpdate[], limit = 120): AgentRunUpdate[] {
  if (events.length <= limit) return events;
  const featured = events.filter((event) => isFeaturedAgentRunUpdate(event)).slice(-limit);
  const selected = new Set(featured);
  for (let index = events.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    selected.add(events[index]);
  }
  return events.filter((event) => selected.has(event));
}

function isFeaturedAgentRunUpdate(update: AgentRunUpdate): boolean {
  return update.type === "plan" || update.type === "diff" || update.type === "subagent";
}

export function agentRunUpdateKey(update: AgentRunUpdate): string | null {
  return update.itemId
    ? `${update.scope || "main"}:${update.agentThreadId || "main"}:${update.type}:${update.itemId}`
    : null;
}

function normalizeDelta(update: AgentRunUpdate): AgentRunUpdate {
  const normalized = {
    ...update,
    output: update.output || update.outputDelta,
    summary: update.summary || update.summaryDelta
  };
  delete normalized.outputDelta;
  delete normalized.summaryDelta;
  return normalized;
}

function withoutEmptyDisplayFields(update: AgentRunUpdate): AgentRunUpdate {
  return Object.fromEntries(Object.entries(update).filter(([key, value]) => (
    value !== undefined && value !== null && value !== "" && key !== "outputDelta" && key !== "summaryDelta"
  ))) as AgentRunUpdate;
}

function isAgentRunState(value: unknown): value is AgentRunState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AgentRunState>;
  return typeof state.id === "string" && typeof state.status === "string" && Array.isArray(state.events);
}

function isAgentRunUpdate(value: unknown): value is AgentRunUpdate {
  return Boolean(value && typeof value === "object" && typeof (value as AgentRunUpdate).type === "string");
}

function boundedTail(value: string, limit: number): string {
  return value.length > limit ? `…${value.slice(-(limit - 1))}` : value;
}
