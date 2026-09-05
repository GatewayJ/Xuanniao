import type { DocumentPayload, Message, ReferenceSnapshot, Thread } from "./types";

export type ReferenceSource = {
  key: string;
  kind: "document" | "message";
  title: string;
  content: string;
  offset: number;
  fullContent: string;
  documentPath: string;
  sourceIdentity?: string;
  sourceIdentityRequired?: boolean;
  threadId?: string;
  messageId?: string;
};

export const REFERENCE_DRAG_TYPE = "application/x-xuanniao-reference";

export function selectedReferenceRange(source: ReferenceSource, text?: string): { start: number; end: number } {
  if (!text) return { start: 0, end: source.content.length };
  const start = source.content.indexOf(text);
  if (start < 0 || source.content.indexOf(text, start + 1) >= 0) {
    throw new Error("该选区无法唯一对应到 Markdown 原文，请通过‘添加引用’打开来源并选择片段。");
  }
  return { start, end: start + text.length };
}

export function discussionSources(document: DocumentPayload, threads: Thread[]): ReferenceSource[] {
  const sources: ReferenceSource[] = [{
    key: "document", kind: "document", title: `${document.title} · 全文`,
    content: document.content, fullContent: document.content, offset: 0, documentPath: document.path,
    sourceIdentity: document.referenceIdentity, sourceIdentityRequired: document.referenceIdentityRequired
  }];
  const headings = document.blocks.filter((block) => block.type === "heading");
  const lines = document.content.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  headings.forEach((heading, index) => {
    const start = offsets[Math.max(0, heading.lineStart - 1)];
    const depth = heading.depth || heading.content.match(/^#+/)?.[0].length || 1;
    const next = headings.slice(index + 1).find((item) => (item.depth || item.content.match(/^#+/)?.[0].length || 1) <= depth);
    const end = next ? offsets[next.lineStart - 1] : document.content.length;
    sources.push({ ...sources[0], key: `heading:${heading.id}`, title: heading.content, offset: start, content: document.content.slice(start, end) });
  });
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (!message.content || message.id.startsWith("pending-")) continue;
      sources.push({
        key: `${thread.id}:${message.id}`, kind: "message",
        title: messageReferenceTitle(message, thread.messages),
        content: message.content, fullContent: message.content, offset: 0,
        documentPath: document.path, threadId: thread.id, messageId: message.id,
        sourceIdentity: document.referenceIdentity, sourceIdentityRequired: document.referenceIdentityRequired
      });
    }
  }
  return sources;
}

// Keep source labels aligned with captureReferences; the complete message stays in content.
function messageReferenceTitle(message: Message, messages: Message[]): string {
  const questionId = message.parentId || message.nodeId;
  const question = message.role === "user" ? message : questionId
    ? messages.find((item) => item.role === "user" && item.id === questionId)
    : messages.slice(0, messages.indexOf(message)).reverse().find((item) => item.role === "user");
  const text = question?.content.replace(/\s+/g, " ").trim() || (question ? "未命名问题" : "原问题不可用");
  const characters = Array.from(text);
  const summary = characters.length > 48 ? characters.slice(0, 48).join("") + "…" : text;
  return `${summary} · ${message.role === "assistant" ? "回答" : "问题"}`;
}

export async function snapshotReference(source: ReferenceSource, start = 0, end = source.content.length): Promise<ReferenceSnapshot> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.content.length) {
    throw new Error("引用范围无效，请重新选择。");
  }
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source.fullContent));
  const revision = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    id: `${source.documentPath}:${source.key}:${start + source.offset}:${end + source.offset}:${revision}${source.sourceIdentity ? `:${source.sourceIdentity}` : ""}`,
    kind: source.kind, documentPath: source.documentPath, title: source.title,
    ...(source.sourceIdentity ? { sourceIdentity: source.sourceIdentity } : {}),
    ...(source.threadId ? { threadId: source.threadId, messageId: source.messageId } : {}),
    start: start + source.offset, end: end + source.offset, revision,
    content: source.content.slice(start, end), sourceLength: source.fullContent.length,
    sourceScope: start + source.offset === 0 && end + source.offset === source.fullContent.length ? "full" : "range",
    contextBefore: source.fullContent.slice(Math.max(0, start + source.offset - 48), start + source.offset),
    contextAfter: source.fullContent.slice(end + source.offset, end + source.offset + 48)
  };
}

export function appendReference(current: ReferenceSnapshot[], reference: ReferenceSnapshot): ReferenceSnapshot[] {
  if (current.some((item) => item.documentPath === reference.documentPath && item.kind === reference.kind && item.threadId === reference.threadId
    && item.messageId === reference.messageId && item.start === reference.start && item.end === reference.end
    && item.revision === reference.revision && item.sourceIdentity === reference.sourceIdentity)) return current;
  return [...current, reference];
}

export type ReferenceAvailability = {
  state: "current" | "changed" | "missing";
  latest?: ReferenceSnapshot;
  checkedAt?: string;
  sourceRevision?: string;
  relocated?: boolean;
  reason?: string;
  latestUnavailableReason?: "reference_too_large";
};

export async function referenceAvailability(reference: ReferenceSnapshot, sources: ReferenceSource[]): Promise<ReferenceAvailability> {
  const source = sources.find((item) => item.documentPath === reference.documentPath && item.offset === 0
    && item.kind === reference.kind && item.threadId === reference.threadId && item.messageId === reference.messageId);
  const checkedAt = new Date().toISOString();
  if (!source) return { state: "missing", checkedAt };
  if ((reference.sourceIdentity || source.sourceIdentityRequired) && reference.sourceIdentity !== source.sourceIdentity) {
    return { state: "missing", checkedAt, reason: "document_identity_changed" };
  }
  const { start, end, ...status } = locateReferenceRange(reference, source.fullContent);
  const tooLarge = start !== undefined && end !== undefined && end - start > 160_000;
  const latest = start !== undefined && end !== undefined && end > start && !tooLarge ? await snapshotReference(source, start, end) : undefined;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source.fullContent));
  const sourceRevision = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { ...status, latest, checkedAt, sourceRevision, ...(tooLarge ? { latestUnavailableReason: "reference_too_large" as const } : {}) };
}

// Kept in sync with the server's authoritative locator; parity is covered by tests.
export function locateReferenceRange(reference: ReferenceSnapshot, source: string): Omit<ReferenceAvailability, "latest"> & { start?: number; end?: number } {
  const { start, end, content } = reference;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || typeof content !== "string" || !content) {
    return { state: "missing", reason: "invalid_reference" };
  }
  if ([reference.contextBefore, reference.contextAfter].some((value) => value !== undefined && typeof value !== "string")) {
    return { state: "missing", reason: "invalid_reference" };
  }
  if (reference.sourceScope === "full" || (!reference.sourceScope && start === 0 && end === reference.sourceLength)) {
    return { state: content === source ? "current" : "changed", start: 0, end: source.length, reason: content === source ? "unchanged" : "content_changed" };
  }
  const boundariesMatch = (reference.contextBefore === undefined || source.slice(Math.max(0, start - reference.contextBefore.length), start) === reference.contextBefore)
    && (reference.contextAfter === undefined || source.slice(end, end + reference.contextAfter.length) === reference.contextAfter);
  if (source.slice(start, end) === content && boundariesMatch) return { state: "current", start, end, reason: "unchanged" };
  const offset = source.indexOf(content);
  if (offset >= 0) {
    if (source.indexOf(content, offset + 1) >= 0) return { state: "changed", reason: "ambiguous_range" };
    return { state: "current", start: offset, end: offset + content.length, ...(offset !== start ? { relocated: true } : {}), reason: offset !== start ? "relocated" : "unchanged" };
  }
  const before = reference.contextBefore;
  const after = reference.contextAfter;
  if (typeof before === "string" && typeof after === "string" && (before || after)) {
    const left = before ? uniqueOffset(source, before) : start === 0 ? 0 : -1;
    const right = after ? uniqueOffset(source, after) : end === reference.sourceLength ? source.length : -1;
    if (left >= 0 && right >= left + before.length) {
      return { state: "changed", start: left + before.length, end: right, reason: "content_changed" };
    }
  }
  return { state: "changed", reason: "range_unresolved" };
}

function uniqueOffset(source: string, text: string) {
  const offset = source.indexOf(text);
  return offset >= 0 && source.indexOf(text, offset + 1) < 0 ? offset : -1;
}

export function referenceAcknowledgementKey(reference: ReferenceSnapshot): string {
  return `xuanniao:reference-ack:${encodeURIComponent(reference.documentPath)}:${encodeURIComponent(reference.id)}`;
}

export function referenceAcknowledgementVersion(check: ReferenceAvailability): string | undefined {
  return check.state === "changed" ? check.sourceRevision || check.latest?.revision : undefined;
}

export function isReferenceAcknowledged(check: ReferenceAvailability, acknowledged?: string): boolean {
  const version = referenceAcknowledgementVersion(check);
  return !!version && version === acknowledged;
}

export function messageReferences(meta: Record<string, unknown> | undefined): ReferenceSnapshot[] {
  if (!Array.isArray(meta?.references)) return [];
  return meta.references.filter((item): item is ReferenceSnapshot => item && typeof item.content === "string" && typeof item.title === "string");
}
