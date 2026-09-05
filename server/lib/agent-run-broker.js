const DEFAULT_MAX_EVENTS = 120;
const DEFAULT_MAX_RUNS = 256;
const DEFAULT_RETENTION_MS = 5 * 60_000;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export function normalizeAgentRunId(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    const error = new Error("agentRunId must contain 8-100 letters, numbers, underscores, or hyphens");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

export function interruptedAgentRunSnapshot(id, threads, now = () => Date.now()) {
  for (const thread of Array.isArray(threads) ? threads : []) {
    const question = (thread.messages || []).find((message) => (
      message.role === "user" && message.meta?.agentRunId === id
    ));
    if (!question) continue;
    const answered = (thread.messages || []).some((message) => (
      message.role === "assistant" && message.parentId === question.id
    ));
    if (answered) return null;
    const completedAt = new Date(now()).toISOString();
    const startedAt = question.updatedAt || question.createdAt || null;
    const message = "执行状态无法确认，结果需核对；过程记录可能不完整。请在成果记录中检查当前文件并确认原进程已经结束。";
    return {
      id,
      status: "unknown",
      startedAt,
      completedAt,
      durationMs: elapsedMs(startedAt, completedAt),
      error: message,
      context: { threadId: thread.id, questionMessageId: question.id, outcomeUnknown: true },
      events: [{ type: "error", status: "failed", message, seq: 1, at: completedAt }]
    };
  }
  return null;
}

export class AgentRunBroker {
  constructor({
    maxEvents = DEFAULT_MAX_EVENTS,
    maxRuns = DEFAULT_MAX_RUNS,
    retentionMs = DEFAULT_RETENTION_MS,
    now = () => Date.now()
  } = {}) {
    this.maxEvents = maxEvents;
    this.maxRuns = maxRuns;
    this.retentionMs = retentionMs;
    this.now = now;
    this.runs = new Map();
  }

  reserve(id, context = {}) {
    if (!id) return null;
    const run = this.ensure(id);
    run.context = { ...run.context, ...context };
    return this.snapshot(id);
  }

  start(id, context = {}) {
    if (!id) return null;
    const run = this.ensure(id);
    if (run.status === "waiting") {
      run.status = "running";
      run.startedAt = new Date(this.now()).toISOString();
    }
    run.context = { ...run.context, ...context };
    this.broadcast(run, "snapshot", this.snapshot(id));
    return this.snapshot(id);
  }

  publish(id, update) {
    if (!id || !update || typeof update !== "object") return null;
    const run = this.ensure(id);
    if (run.status === "waiting") this.start(id);
    if (["completed", "failed", "interrupted", "unknown"].includes(run.status)) return null;
    const event = {
      ...update,
      seq: run.nextSeq,
      at: new Date(this.now()).toISOString()
    };
    run.nextSeq += 1;
    run.events.push(event);
    const featuredKey = featuredEventKey(event);
    if (featuredKey) {
      run.featuredEvents.set(featuredKey, event);
      while (run.featuredEvents.size > this.maxEvents) {
        run.featuredEvents.delete(run.featuredEvents.keys().next().value);
      }
    }
    if (run.events.length > this.maxEvents) {
      run.events.splice(0, run.events.length - this.maxEvents);
    }
    this.broadcast(run, "update", event);
    return event;
  }

  complete(id, status = "completed", details = {}) {
    if (!id) return null;
    const run = this.ensure(id);
    if (run.status === "waiting") run.startedAt = new Date(this.now()).toISOString();
    run.status = ["failed", "interrupted", "unknown"].includes(status) ? status : "completed";
    run.completedAt = new Date(this.now()).toISOString();
    run.durationMs = Number.isFinite(details.durationMs)
      ? Math.max(0, Math.round(details.durationMs))
      : elapsedMs(run.startedAt, run.completedAt);
    run.error = typeof details.error === "string" ? details.error : null;
    const snapshot = this.snapshot(id);
    this.broadcast(run, "complete", snapshot);
    this.scheduleExpiry(run);
    return snapshot;
  }

  snapshot(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      error: run.error,
      context: { ...run.context },
      events: snapshotEvents(run, this.maxEvents).map((event) => ({ ...event }))
    };
  }

  subscribe(id, listener) {
    const run = this.runs.get(id);
    if (!run) {
      const error = new Error(`agent run not found: ${id}`);
      error.statusCode = 404;
      error.code = "AGENT_RUN_NOT_FOUND";
      throw error;
    }
    run.subscribers.add(listener);
    const snapshot = this.snapshot(id);
    listener({ type: "snapshot", data: snapshot });
    if (["completed", "failed", "interrupted", "unknown"].includes(run.status)) {
      listener({ type: "complete", data: snapshot });
    }
    return () => run.subscribers.delete(listener);
  }

  dispose() {
    for (const run of this.runs.values()) {
      clearTimeout(run.expiryTimer);
      this.broadcast(run, "shutdown", null);
      run.subscribers.clear();
    }
    this.runs.clear();
  }

  ensure(id) {
    let run = this.runs.get(id);
    if (run) return run;
    if (!this.evictIfNeeded()) {
      const error = new Error("too many active agent runs; wait for an existing run to finish");
      error.statusCode = 503;
      error.code = "AGENT_RUN_CAPACITY_EXCEEDED";
      throw error;
    }
    run = {
      id,
      status: "waiting",
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
      context: {},
      events: [],
      featuredEvents: new Map(),
      nextSeq: 1,
      subscribers: new Set(),
      expiryTimer: null
    };
    this.runs.set(id, run);
    return run;
  }

  broadcast(run, type, data) {
    for (const listener of run.subscribers) {
      try {
        listener({ type, data });
      } catch {
        // A disconnected stream must not affect the agent run.
      }
    }
  }

  scheduleExpiry(run) {
    clearTimeout(run.expiryTimer);
    run.expiryTimer = setTimeout(() => {
      if (this.runs.get(run.id) === run) this.runs.delete(run.id);
    }, this.retentionMs);
    run.expiryTimer.unref?.();
  }

  evictIfNeeded() {
    if (this.runs.size < this.maxRuns) return true;
    const terminal = [...this.runs.values()].find((run) => (
      ["completed", "failed", "interrupted", "unknown"].includes(run.status)
    ));
    const waiting = [...this.runs.values()].find((run) => (
      run.status === "waiting" && run.subscribers.size === 0
    ));
    const oldest = terminal || waiting;
    if (!oldest) return false;
    clearTimeout(oldest.expiryTimer);
    this.runs.delete(oldest.id);
    return true;
  }
}

function elapsedMs(startedAt, completedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(completedAt || "");
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function featuredEventKey(event) {
  if (!event || !["plan", "diff", "subagent"].includes(event.type)) return null;
  return [event.scope || "main", event.agentThreadId || "main", event.type, event.itemId || event.agentThreadId || event.type].join(":");
}

function snapshotEvents(run, limit) {
  const featured = [...run.featuredEvents.values()];
  const featuredSeqs = new Set(featured.map((event) => event.seq));
  const recent = run.events.filter((event) => !featuredSeqs.has(event.seq));
  const selected = [
    ...featured,
    ...recent.slice(-Math.max(0, limit - featured.length))
  ];
  return selected.sort((left, right) => (left.seq || 0) - (right.seq || 0));
}
