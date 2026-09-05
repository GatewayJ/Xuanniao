import type { ReferenceAvailability } from "./discussion-references";
import type { DocumentPayload, OutcomeRecord, ReferenceSnapshot, Thread } from "./types";

export type ProjectDocument = {
  path: string;
  title: string;
  available: boolean;
  external: boolean;
  threads: Thread[];
  records: OutcomeRecord[];
  unavailableReason?: string;
  errors?: string[];
};

export type ProjectPayload = { root: string; checkedAt: string; documents: ProjectDocument[] };
export type ProjectPreview = { document: DocumentPayload; threads: Thread[]; records: OutcomeRecord[]; external: boolean };
export type IncomingCitation = { reference: ReferenceSnapshot; documentPath: string; targetThreadId: string; targetMessageId: string; title: string; targetContent: string; available: boolean };
export type ReferenceCheck = ReferenceAvailability & { id: string; checkedAt: string };

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload as T;
}

export const projectApi = {
  incoming: () => request<IncomingCitation[]>("/api/references/incoming"),
  register: (path: string, relink = false) => request<ProjectPayload & { registeredPath: string }>("/api/project/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, relink }) }),
  list: (signal?: AbortSignal) => request<ProjectPayload>("/api/project", { signal }),
  preview: (path: string, signal?: AbortSignal) => request<ProjectPreview>(`/api/project/preview?path=${encodeURIComponent(path)}`, { signal }),
  checkReferences: (references: ReferenceSnapshot[], signal?: AbortSignal) => request<ReferenceCheck[]>("/api/references/check", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ references }), signal
  })
};
