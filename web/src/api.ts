import type { AgentOutcome, AgentPermissionMode, AgentRunSnapshot, AgentRunUpdate, AgentSettingsPayload, Anchor, BranchSelection, ConversationNodeKind, DocumentPayload, FileBrowserPayload, MarkdownFile, Message, PermissionRequest, Thread } from "./types";

type JsonRequestInit = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(url: string, options: JsonRequestInit = {}): Promise<T> {
  const { body, headers, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    headers: body === undefined
      ? headers
      : {
          "content-type": "application/json",
          ...(headers || {})
        },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload as T;
}

export const api = {
  files: () => request<{ root: string; currentPath: string; files: MarkdownFile[] }>("/api/files"),
  browseFiles: (targetPath: string) => request<FileBrowserPayload>(`/api/files/browse?path=${encodeURIComponent(targetPath)}`),
  document: (signal?: AbortSignal) => request<DocumentPayload>("/api/document", { signal }),
  openDocument: (path: string, signal?: AbortSignal) => request<{ document: DocumentPayload; threads: Thread[]; files: MarkdownFile[] }>("/api/document/open", {
    method: "POST",
    body: { path },
    signal
  }),
  createDocument: (
    command: { instruction: string; directory: string | null; fileName: string | null },
    agentRunId: string,
    signal?: AbortSignal
  ) =>
    request<{ document: DocumentPayload; threads: Thread[]; files: MarkdownFile[] }>("/api/document/create", {
      method: "POST",
      body: { ...command, agentRunId },
      signal
    }),
  saveDocument: (
    documentPath: string,
    content: string,
    expectedRevision: string,
    threads?: Array<{ id: string; selectedText: string; anchor: Anchor }>,
    deletedThreadIds: string[] = [],
    signal?: AbortSignal
  ) => request<{ document: DocumentPayload; threads: Thread[] }>("/api/document", {
    method: "PUT",
    body: { documentPath, content, expectedRevision, threads, deletedThreadIds },
    signal
  }),
  threads: (signal?: AbortSignal) => request<{ threads: Thread[] }>("/api/threads", { signal }),
  reserveAgentRun: (runId: string, signal?: AbortSignal) =>
    request<AgentRunSnapshot>(`/api/agent-runs/${encodeURIComponent(runId)}`, {
      method: "POST",
      body: {},
      signal
    }),
  agentRun: (runId: string, signal?: AbortSignal) =>
    request<AgentRunSnapshot>(`/api/agent-runs/${encodeURIComponent(runId)}`, { signal }),
  createThread: (body: { documentPath: string; title: string; selectedText: string; anchor: unknown; expectedRevision: string }, signal?: AbortSignal) =>
    request<{ thread: Thread }>("/api/threads", {
      method: "POST",
      body,
      signal
    }),
  deleteThread: (threadId: string, signal?: AbortSignal) =>
    request<{ threads: Thread[] }>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      signal
    }),
  sendMessage: (threadId: string, body: { content: string; askAgent: boolean; nodeId?: string | null; parentMessageId?: string | null; branchSelection?: BranchSelection | null; agentRunId?: string | null }, signal?: AbortSignal) =>
    request<{ userMessage: Message; assistantMessage: Message | null; agentOutcome: AgentOutcome; threads: Thread[]; document?: DocumentPayload | null }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        body,
        signal
      }
    ),
  updateMessage: (threadId: string, messageId: string, body: { content: string; rerunAgent?: boolean; agentRunId?: string | null }, signal?: AbortSignal) =>
    request<{ message: Message; assistantMessage: Message | null; agentOutcome: AgentOutcome; threads: Thread[]; document?: DocumentPayload | null }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PUT",
        body,
        signal
      }
    ),
  reviseMessage: (threadId: string, messageId: string, body: { content: string; askAgent?: boolean; agentRunId?: string | null }, signal?: AbortSignal) =>
    request<{ message: Message; assistantMessage: Message | null; agentOutcome: AgentOutcome; threads: Thread[]; document?: DocumentPayload | null }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/revisions`,
      {
        method: "POST",
        body,
        signal
      }
    ),
  updateMessageMeta: (threadId: string, messageId: string, body: { nodeKind: ConversationNodeKind }, signal?: AbortSignal) =>
    request<{ message: Message; threads: Thread[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/meta`,
      {
        method: "PATCH",
        body,
        signal
      }
    ),
  deleteMessage: (threadId: string, messageId: string, signal?: AbortSignal) =>
    request<{ threads: Thread[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "DELETE",
        signal
      }
    ),
  permissions: (signal?: AbortSignal) =>
    request<{ requests: PermissionRequest[] }>("/api/permissions", { signal }),
  settings: (signal?: AbortSignal) =>
    request<AgentSettingsPayload>("/api/settings", { signal }),
  updateSettings: (
    body: { model: string | null; reasoningEffort: string | null; permissionMode: AgentPermissionMode },
    signal?: AbortSignal
  ) =>
    request<AgentSettingsPayload>("/api/settings", {
      method: "PUT",
      body,
      signal
    }),
  resolvePermission: (
    requestId: string,
    body: { optionId?: string; cancelled?: boolean },
    signal?: AbortSignal
  ) =>
    request<{ requests: PermissionRequest[] }>(`/api/permissions/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      body,
      signal
    }),
  subscribeAgentRun: (
    runId: string,
    handlers: {
      onSnapshot: (snapshot: AgentRunSnapshot) => void;
      onUpdate: (update: AgentRunUpdate) => void;
      onComplete: (snapshot: AgentRunSnapshot) => void;
    },
    signal?: AbortSignal
  ) => {
    const source = new EventSource(`/api/agent-runs/${encodeURIComponent(runId)}/events`);
    const parse = <T>(event: Event): T | null => {
      try {
        return JSON.parse((event as MessageEvent<string>).data) as T;
      } catch {
        return null;
      }
    };
    const onSnapshot = (event: Event) => {
      const snapshot = parse<AgentRunSnapshot>(event);
      if (snapshot) handlers.onSnapshot(snapshot);
    };
    const onUpdate = (event: Event) => {
      const update = parse<AgentRunUpdate>(event);
      if (update) handlers.onUpdate(update);
    };
    const onComplete = (event: Event) => {
      const snapshot = parse<AgentRunSnapshot>(event);
      if (snapshot) handlers.onComplete(snapshot);
      close();
    };
    const onShutdown = () => close();
    source.addEventListener("snapshot", onSnapshot);
    source.addEventListener("update", onUpdate);
    source.addEventListener("complete", onComplete);
    source.addEventListener("shutdown", onShutdown);

    function close() {
      source.removeEventListener("snapshot", onSnapshot);
      source.removeEventListener("update", onUpdate);
      source.removeEventListener("complete", onComplete);
      source.removeEventListener("shutdown", onShutdown);
      source.close();
      signal?.removeEventListener("abort", close);
    }
    signal?.addEventListener("abort", close, { once: true });
    return close;
  }
};
