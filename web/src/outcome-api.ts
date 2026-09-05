import type { DocumentPayload, OutcomeRecord, Thread } from "./types";

export type OutcomeSnapshot = { records: OutcomeRecord[]; activity: { id?: string; label: string; stopping: boolean; recoveryRequired?: boolean } | null; cwd: string };
export type OutcomeChange = { record?: OutcomeRecord; document?: DocumentPayload; threads?: Thread[] };

async function request<T>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, body === undefined ? { cache: "no-store" } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

export const outcomeApi = {
  list: () => request<OutcomeSnapshot>("/api/outcomes"),
  start: (body: unknown) => request<{ record: OutcomeRecord }>("/api/outcomes", body),
  change: (id: string, action: string, body: unknown) => request<OutcomeChange>(`/api/outcomes/${encodeURIComponent(id)}/${action}`, body),
  stop: (body: { documentPath?: string; operationId?: string } = {}) => request<OutcomeSnapshot>("/api/agent/stop", body),
  reanchor: (id: string, body: unknown) => request<{ threads: Thread[] }>(`/api/threads/${encodeURIComponent(id)}/anchor`, body, "PUT")
};
