import { documentRevision } from "./document-workspace.js";
import { OutcomeConflictError } from "./outcome-store.js";

const applicationLocks = new Map();

export function proposalTarget(document, target) {
  if (!target || !["replace", "insert", "document"].includes(target.mode)
    || !Number.isInteger(target.start) || !Number.isInteger(target.end)
    || target.start < 0 || target.end < target.start || target.end > document.content.length
    || (target.mode === "insert" && target.start !== target.end)
    || (target.mode === "replace" && target.start === target.end)
    || (target.mode === "document" && (target.start !== 0 || target.end !== document.content.length))) {
    throw new OutcomeConflictError("请选择有效的替换范围或插入位置。");
  }
  return { mode: target.mode, start: target.start, end: target.end, label: String(target.label || "文档正文") };
}

export function parseProposal(content) {
  const match = String(content).match(/^\s*<XUANNIAO_PROPOSAL>\r?\n?([\s\S]*?)\r?\n?<\/XUANNIAO_PROPOSAL>\s*$/);
  if (!match) throw new Error("AI 未返回完整的文档提案，原文未修改。请重新生成。");
  return match[1];
}

// The journal is persisted before changing Markdown; recovery compares exact pre/post images.
export class ProposalService {
  constructor({ document, store, agent }) { Object.assign(this, { document, store, agent }); }

  async generate(record, onUpdate, { isStopping = () => false, beforeCommit = async () => {} } = {}) {
    const document = await this.document.payload();
    if (isStopping()) throw interruptedProposal({ content: record.result });
    const answer = await this.agent.runTurn({
      runId: record.attemptId || record.id,
      mode: "proposal",
      question: record.instruction,
      document: { ...document, content: record.baseContent, revision: record.baseRevision },
      thread: { id: record.id, messages: [], selectedText: record.baseContent.slice(record.target.start, record.target.end), references: record.references, proposal: { target: record.target, source: record.source, previous: record.replacement || null } },
      onUpdate
    });
    await beforeCommit();
    if (isStopping() || answer.stopReason === "interrupted") throw interruptedProposal(answer);
    let replacement;
    try { replacement = parseProposal(answer.content); }
    catch (error) { error.content = answer.content; throw error; }
    const proposedContent = record.baseContent.slice(0, record.target.start) + replacement + record.baseContent.slice(record.target.end);
    const current = await this.document.payload();
    try {
      return await this.store.update(record.id, (latest) => {
        if (isStopping() || latest.status === "stopping") throw interruptedProposal(answer);
        if (latest.status !== "generating" || latest.attemptId !== record.attemptId || latest.baseRevision !== record.baseRevision) throw new OutcomeConflictError("本次生成已失效，未覆盖更新的提案。");
        return { replacement, proposedContent, result: answer.content, status: current.revision === record.baseRevision ? "review" : "conflict", error: undefined };
      });
    } catch (error) {
      error.content ??= answer.content;
      throw error;
    }
  }

  async edit(id, { replacement, expectedRevision }) {
    requireRevision(expectedRevision);
    const record = await this.store.get(id);
    if (!["review", "conflict", "failed", "interrupted"].includes(record.status) || typeof replacement !== "string") throw new OutcomeConflictError("当前提案不可编辑。");
    const proposedContent = record.baseContent.slice(0, record.target.start) + replacement + record.baseContent.slice(record.target.end);
    const current = await this.document.payload();
    return this.store.update(id, { replacement, proposedContent, status: current.revision === record.baseRevision ? "review" : "conflict", error: undefined }, expectedRevision);
  }

  async rebase(id, { expectedRevision, target, documentRevision: expectedDocumentRevision }) {
    requireRevision(expectedRevision);
    const record = await this.store.get(id);
    if (!["review", "conflict", "failed", "interrupted"].includes(record.status) || typeof record.replacement !== "string") throw new OutcomeConflictError("请先准备有效的替换内容。");
    const current = await this.document.payload();
    if (current.revision !== expectedDocumentRevision) throw new OutcomeConflictError("文档已变化，请重新选择目标。");
    const nextTarget = proposalTarget(current, target);
    return this.store.update(id, {
      baseContent: current.content, baseRevision: current.revision, target: nextTarget,
      proposedContent: current.content.slice(0, nextTarget.start) + (record.replacement || "") + current.content.slice(nextTarget.end),
      status: "review", error: undefined
    }, expectedRevision);
  }

  async apply(id, expectedRevision) {
    return this.withApplicationLock(() => this.applyWithinLock(id, expectedRevision));
  }

  async applyWithinLock(id, expectedRevision) {
    let record = await this.store.get(id);
    if (record.status === "applying") record = await this.recoverApplication(record);
    if (record.status === "applied" || (record.inverseOf && record.status === "undone")) return this.result(record);
    requireRevision(expectedRevision);
    if (record.status !== "review" || typeof record.proposedContent !== "string") throw new OutcomeConflictError("请先检查并确认提案。");
    if (record.inverseOf && record.proposedContent === record.baseContent) throw new OutcomeConflictError("撤回内容尚未调整，正文不会变化；请手动编辑撤回提案后再采纳。");
    record = await this.store.update(id, { status: "applying", appliedRevision: documentRevision(record.proposedContent) }, expectedRevision);
    let result;
    try {
      result = await this.document.save({ content: record.proposedContent, expectedRevision: record.baseRevision });
    } catch (error) {
      // A write can have reached disk before an I/O error. Keep the journal until
      // the observed pre/post image and document metadata have been reconciled.
      await this.recoverApplication(record).catch(() => {});
      throw error;
    }
    record = await this.completeApplication(id);
    return { ...result, record };
  }

  async undo(id) {
    return this.withApplicationLock(() => this.undoWithinLock(id));
  }

  async undoWithinLock(id) {
    const record = await this.store.get(id);
    const existing = (await this.store.list()).find((item) => item.inverseOf === id && !["discarded", "failed"].includes(item.status));
    if (existing) {
      if (existing.status === "applying" || (existing.status === "review" && existing.automaticUndo)) return this.applyWithinLock(existing.id, existing.revision);
      return this.result(existing);
    }
    if (record.status !== "applied" || record.inverseOf) throw new OutcomeConflictError("只有原始已采纳提案可以撤销。");
    const current = await this.document.payload();
    const exact = current.revision === record.appliedRevision;
    const inverse = await this.store.create({
      kind: "proposal", status: "review", title: `撤销：${record.title}`, source: record.source, references: record.references,
      instruction: "撤销原提案；保留此后修改。请检查差异后采纳。", inverseOf: id,
      automaticUndo: exact,
      baseContent: current.content, baseRevision: current.revision,
      target: { mode: "document", start: 0, end: current.content.length, label: "撤销提案" },
      replacement: exact ? record.baseContent : current.content,
      proposedContent: exact ? record.baseContent : current.content,
      error: exact ? undefined : "正文已有后续修改。请参考原提案，手动编辑下面的撤销内容；系统不会覆盖后续修改。"
    });
    if (exact) return this.applyWithinLock(inverse.id, inverse.revision);
    return this.result(inverse);
  }

  async recover({ runs = true } = {}) {
    return this.withApplicationLock(async () => {
      for (const record of await this.store.list()) {
        if (record.status === "applying") {
          await this.recoverApplication(record);
        } else if (record.inverseOf && record.status === "applied") {
          // Repair journals from versions that committed inverse and original separately.
          await this.completeApplication(record.id);
        } else if (runs && ["running", "stopping", "generating"].includes(record.status)) {
          await this.store.update(record.id, { status: "unknown", error: "服务曾中断，执行结果未知，过程记录可能不完整。请检查文件和原进程；确认原进程不再继续后才能再次执行。", recoveryAcknowledged: false });
        }
      }
    });
  }

  async recoverApplication(record) {
    if (record.inverseOf && record.proposedContent === record.baseContent) {
      return this.store.update(record.id, { status: "conflict", error: "撤回草稿没有实际修改，请重新审核。" }, record.revision);
    }
    const current = await this.document.payload();
    if (current.content === record.proposedContent && current.revision === record.appliedRevision) {
      await this.document.save({ content: current.content, expectedRevision: current.revision });
      return this.completeApplication(record.id);
    }
    return this.store.update(record.id, {
      status: current.content === record.baseContent && current.revision === record.baseRevision ? "review" : "conflict",
      error: "上次回写未确认完成，请核对当前正文后重新审核。"
    }, record.revision);
  }

  completeApplication(id) {
    return this.store.mutate((records) => {
      const record = records.find((item) => item.id === id);
      if (!record || !["applying", "applied", "undone"].includes(record.status)) throw new OutcomeConflictError();
      const now = new Date().toISOString();
      if (record.status !== (record.inverseOf ? "undone" : "applied")) {
        Object.assign(record, { status: record.inverseOf ? "undone" : "applied", appliedAt: record.appliedAt || now, error: undefined, revision: record.revision + 1, updatedAt: now });
      }
      const original = records.find((item) => item.id === record.inverseOf);
      if (original && (original.status !== "undone" || original.undoneBy !== id)) {
        Object.assign(original, { status: "undone", undoneBy: id, revision: original.revision + 1, updatedAt: now });
      }
      return record;
    });
  }

  async result(record) {
    return { record, document: await this.document.payload(), threads: await this.document.threadStore.list() };
  }

  async withApplicationLock(operation) {
    const key = this.store.filePath;
    const pending = (applicationLocks.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    applicationLocks.set(key, pending);
    try { return await pending; }
    finally { if (applicationLocks.get(key) === pending) applicationLocks.delete(key); }
  }
}

function requireRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new OutcomeConflictError("缺少成果版本，请刷新后重新审核。");
}

function interruptedProposal(answer) {
  return Object.assign(new Error("提案生成已中断，已收集内容保留；原文未修改。"), { code: "AGENT_INTERRUPTED", content: answer.content, updates: answer.updates, result: answer.result });
}
