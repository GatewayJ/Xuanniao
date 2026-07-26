export function threadNodeDraftKey(threadId: string, nodeId: string | null): string {
  return `thread:${threadId}:node:${nodeId || "root"}`;
}
