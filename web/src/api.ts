import type { AgentOutcome, Anchor, BranchSelection, ConversationNodeKind, DocumentPayload, FileBrowserPayload, MarkdownFile, Message, PermissionRequest, Thread } from "./types";

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
  document: () => request<DocumentPayload>("/api/document"),
  openDocument: (path: string) => request<{ document: DocumentPayload; threads: Thread[]; files: MarkdownFile[] }>("/api/document/open", {
    method: "POST",
    body: { path }
  }),
  saveDocument: (content: string, expectedRevision: string, threads?: Array<{ id: string; selectedText: string; anchor: Anchor }>, deletedThreadIds: string[] = []) => request<{ document: DocumentPayload; threads: Thread[] }>("/api/document", {
    method: "PUT",
    body: { content, expectedRevision, threads, deletedThreadIds }
  }),
  threads: () => request<{ threads: Thread[] }>("/api/threads"),
  createThread: (body: { title: string; selectedText: string; anchor: unknown }) =>
    request<{ thread: Thread }>("/api/threads", {
      method: "POST",
      body
    }),
  deleteThread: (threadId: string) =>
    request<{ threads: Thread[] }>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE"
    }),
  sendMessage: (threadId: string, body: { content: string; askAgent: boolean; nodeId?: string | null; parentMessageId?: string | null; branchSelection?: BranchSelection | null; adoptExistingChildren?: boolean; insertBeforeNodeId?: string | null }) =>
    request<{ userMessage: Message; assistantMessage: Message | null; agentOutcome: AgentOutcome; threads: Thread[]; document?: DocumentPayload | null }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        body
      }
    ),
  updateMessage: (threadId: string, messageId: string, body: { content: string; rerunAgent?: boolean }) =>
    request<{ message: Message; assistantMessage: Message | null; agentOutcome: AgentOutcome; threads: Thread[]; document?: DocumentPayload | null }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PUT",
        body
      }
    ),
  updateMessageMeta: (threadId: string, messageId: string, body: { nodeKind: ConversationNodeKind }) =>
    request<{ message: Message; threads: Thread[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/meta`,
      {
        method: "PATCH",
        body
      }
    ),
  deleteMessage: (threadId: string, messageId: string) =>
    request<{ threads: Thread[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "DELETE"
      }
    ),
  permissions: () => request<{ requests: PermissionRequest[] }>("/api/permissions"),
  resolvePermission: (requestId: string, body: { optionId?: string; cancelled?: boolean }) =>
    request<{ requests: PermissionRequest[] }>(`/api/permissions/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      body
    })
};
