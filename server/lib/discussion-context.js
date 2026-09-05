import { createHash } from "node:crypto";
import path from "node:path";

const MAX_REFERENCES = 24;
export const MAX_REFERENCE_CHARS = 160_000;

export class ReferenceConflictError extends Error {
  constructor(message) {
    super(message);
    this.code = "REFERENCE_CHANGED";
    this.statusCode = 409;
  }
}

export function referenceRevision(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Resolve a user's selection from the saved source, never from client-supplied prose. */
export async function captureReferences(inputs, { document, threadStore, resolveDocument }) {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs) || inputs.length > 512) {
    throw invalidReference("参考资料输入格式无效或数量过多");
  }
  const result = [];
  const seen = new Set();
  const documents = new Map([[path.resolve(document.path), { document, threadStore }]]);
  const threadLists = new Map();
  let total = 0;
  for (const input of inputs) {
    if (!input || typeof input !== "object") throw invalidReference("参考资料格式不正确");
    if (input.documentPath !== undefined && (typeof input.documentPath !== "string" || !input.documentPath.trim())) {
      throw invalidReference("来源文档路径无效");
    }
    const documentPath = input.documentPath ? path.resolve(input.documentPath) : path.resolve(document.path);
    if (!documents.has(documentPath)) {
      if (!resolveDocument) throw invalidReference("跨文档引用需要来源解析器");
      let resolved;
      try { resolved = await resolveDocument(documentPath); }
      catch (error) {
        if (error.statusCode === 404 || ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) {
          throw new ReferenceConflictError("来源文档不可用，请重新选择参考资料");
        }
        throw error;
      }
      if (!resolved?.document || path.resolve(resolved.document.path) !== documentPath) {
        throw new ReferenceConflictError("来源文档无法确定，请重新关联参考资料");
      }
      documents.set(documentPath, resolved);
    }
    const origin = documents.get(documentPath);
    const sourceDocument = origin.document;
    if ((input.sourceIdentity || sourceDocument.referenceIdentityRequired) && input.sourceIdentity !== sourceDocument.referenceIdentity) {
      throw new ReferenceConflictError("来源文档身份已变化，请重新选择参考资料");
    }
    let source;
    let title;
    let sourceId;
    let threadId;
    let messageId;
    if (input.kind === "document") {
      source = sourceDocument.content;
      title = sourceDocument.title;
      sourceId = documentPath;
    } else if (input.kind === "message") {
      if (typeof input.threadId !== "string" || typeof input.messageId !== "string") {
        throw invalidReference("讨论来源缺少标识");
      }
      if (!threadLists.has(documentPath)) threadLists.set(documentPath, await origin.threadStore.list());
      const thread = threadLists.get(documentPath).find((item) => item.id === input.threadId);
      if (!thread) throw new ReferenceConflictError("来源讨论已删除，请重新选择参考资料");
      const message = thread.messages.find((item) => item.id === input.messageId);
      if (!message) throw new ReferenceConflictError("来源回答已删除，请重新选择参考资料");
      source = message.content;
      title = messageReferenceTitle(message, thread.messages);
      threadId = thread.id;
      messageId = message.id;
      sourceId = `${documentPath}:${thread.id}:${message.id}`;
    } else {
      throw invalidReference("不支持的参考资料类型");
    }
    const revision = referenceRevision(source);
    if (input.revision !== revision) {
      throw new ReferenceConflictError(`「${title}」已变化，请重新选择或更新参考资料后发送`);
    }
    const { start, end } = input;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) {
      throw invalidReference("引用范围无效，请重新选择");
    }
    if (input.kind === "document") {
      const line = source.slice(0, start).split("\n").length;
      const heading = sourceDocument.blocks?.filter((block) => block.type === "heading" && block.lineStart <= line).at(-1);
      if (heading && (start !== 0 || end !== source.length)) title = `${sourceDocument.title} / ${heading.sectionTitle || heading.content}`;
    }
    const sourceIdentity = sourceDocument.referenceIdentity;
    const id = `${input.kind}:${sourceId}:${start}:${end}:${revision}${sourceIdentity ? `:${sourceIdentity}` : ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > MAX_REFERENCES) throw invalidReference(`最多可添加 ${MAX_REFERENCES} 项不同的参考资料（包含来源回答）`);
    const content = source.slice(start, end);
    total += content.length;
    if (total > MAX_REFERENCE_CHARS) throw invalidReference("参考资料超过 160,000 字符，请缩小选区");
    result.push({
      id, kind: input.kind, documentPath, title,
      ...(sourceIdentity ? { sourceIdentity } : {}),
      ...(threadId ? { threadId, messageId } : {}),
      start, end, revision, content, sourceLength: source.length, capturedAt: new Date().toISOString(),
      sourceScope: start === 0 && end === source.length ? "full" : "range",
      contextBefore: source.slice(Math.max(0, start - 48), start), contextAfter: source.slice(end, end + 48)
    });
  }
  return result;
}

// Keep source labels aligned with discussionSources; snapshots retain their full bodies.
function messageReferenceTitle(message, messages) {
  const questionId = message.parentId || message.nodeId;
  const question = message.role === "user" ? message : questionId
    ? messages.find((item) => item.role === "user" && item.id === questionId)
    : messages.slice(0, messages.indexOf(message)).reverse().find((item) => item.role === "user");
  const text = question?.content.replace(/\s+/g, " ").trim() || (question ? "未命名问题" : "原问题不可用");
  const characters = Array.from(text);
  const summary = characters.length > 48 ? characters.slice(0, 48).join("") + "…" : text;
  return `${summary} · ${message.role === "assistant" ? "回答" : "问题"}`;
}

/** Compare quoted text, not the whole-source revision used for send-time concurrency. */
export function locateReferenceRange(reference, source) {
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
  // Only offer a new excerpt when both surrounding boundaries can be identified.
  // Old full-source snapshots without boundary context remain readable and checkable.
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

function uniqueOffset(source, text) {
  const offset = source.indexOf(text);
  return offset >= 0 && source.indexOf(text, offset + 1) < 0 ? offset : -1;
}

function invalidReference(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
