import type { Anchor, DocumentPayload, MarkdownFile, Message, Thread } from "./types";

type JsonRequestInit = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(url: string, options: JsonRequestInit = {}): Promise<T> {
  const { body, headers, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    headers: {
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
  pickMarkdownFile: (startPath: string) => request<{ path: string | null; canceled: boolean }>("/api/files/pick", {
    method: "POST",
    body: { startPath }
  }),
  document: () => request<DocumentPayload>("/api/document"),
  openDocument: (path: string) => request<{ document: DocumentPayload; threads: Thread[]; files: MarkdownFile[] }>("/api/document/open", {
    method: "POST",
    body: { path }
  }),
  saveDocument: (content: string) => request<DocumentPayload>("/api/document", {
    method: "PUT",
    body: { content }
  }),
  threads: () => request<{ threads: Thread[] }>("/api/threads"),
  createThread: (body: { title: string; selectedText: string; anchor: unknown }) =>
    request<{ thread: Thread }>("/api/threads", {
      method: "POST",
      body
    }),
  saveThreadAnchors: (threads: Array<{ id: string; selectedText: string; anchor: Anchor }>) =>
    request<{ threads: Thread[] }>("/api/threads/anchors", {
      method: "PUT",
      body: { threads }
    }),
  deleteThread: (threadId: string) =>
    request<{ threads: Thread[] }>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE"
    }),
  sendMessage: (threadId: string, body: { content: string; askAgent: boolean }) =>
    request<{ userMessage: Message; assistantMessage: Message | null; threads: Thread[]; document?: DocumentPayload }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        body
      }
    ),
  updateMessage: (threadId: string, messageId: string, body: { content: string; rerunAgent?: boolean }) =>
    request<{ message: Message; assistantMessage: Message | null; threads: Thread[]; document?: DocumentPayload }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PUT",
        body
      }
    ),
  deleteMessage: (threadId: string, messageId: string) =>
    request<{ threads: Thread[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "DELETE"
      }
    )
};
