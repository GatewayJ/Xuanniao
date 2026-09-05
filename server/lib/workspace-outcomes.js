import { randomUUID } from "node:crypto";
import { captureReferences, referenceRevision } from "./discussion-context.js";
import { proposalTarget, ProposalService } from "./proposal-service.js";
import { OutcomeConflictError, outcomeRequestFingerprint, validateRequestKey } from "./outcome-store.js";

const unknownCodes = new Set(["AGENT_RUNTIME_LOST", "AGENT_STOP_TIMEOUT"]);

export class WorkspaceOutcomes {
  constructor({ document, store, agent, conversation, gate, resolveDocument, cwd, settings }) {
    Object.assign(this, { document, store, agent, conversation, gate, resolveDocument, cwd, settings });
    this.proposals = new ProposalService({ document, store, agent });
    this.pending = null;
    this.current = null;
    this.currentRecordId = null;
    this.recoveryOperation = null;
    this.recoveryRecords = new Map();
    this.starts = new Map();
    this.stops = new Map();
    this.gate.setBlocker(() => Boolean(this.recoveryOperation) || this.recoveryRecords.size > 0 || this.store.needsRecovery || this.store.hasPendingApplication || Boolean(this.agent.isBusy?.()));
  }

  async assertRecovered() {
    await this.persistRecoveryOperation();
    if ((await this.store.list()).some((record) => record.status === "unknown" && !record.recoveryAcknowledged)) {
      throw new OutcomeConflictError("存在结果未知的执行。请在成果记录中核对文件并确认原进程已结束，再继续。");
    }
  }

  async snapshot() {
    await this.persistRecoveryOperation();
    if (!this.current && !this.agent.isBusy?.() && this.store.hasPendingApplication) await this.proposals.recover({ runs: false });
    const records = await this.store.list();
    const activity = this.gate.active;
    return { records, activity: activity ? {
      id: activity.id, label: activity.label, stopping: activity.stopping, recoveryRequired: Boolean(activity.recoveryRequired || this.store.needsRecovery)
    } : null, cwd: this.cwd };
  }

  async start(kind, input) {
    if (!["proposal", "execution"].includes(kind)) throw new OutcomeConflictError("未知操作类型。");
    const command = structuredClone(input);
    validateRequestKey(command.requestKey);
    const fingerprint = outcomeRequestFingerprint(kind, command);
    const existing = this.starts.get(command.requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new OutcomeConflictError("提交标识已用于不同的操作。");
      return existing.promise;
    }
    const promise = this.prepare(kind, command, fingerprint);
    this.starts.set(command.requestKey, { fingerprint, promise });
    try { return await promise; }
    finally { if (this.starts.get(command.requestKey)?.promise === promise) this.starts.delete(command.requestKey); }
  }

  async runExternal(input, execute) {
    const command = structuredClone(input);
    if (command.origin !== "document-creation" || typeof execute !== "function") throw new OutcomeConflictError("未知外部执行类型。");
    validateRequestKey(command.requestKey);
    const fingerprint = outcomeRequestFingerprint("execution", command);
    const existing = this.starts.get(command.requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new OutcomeConflictError("提交标识已用于不同的操作。");
      return existing.promise;
    }
    const promise = this.prepareExternal(command, fingerprint, execute);
    this.starts.set(command.requestKey, { fingerprint, promise });
    try { return await promise; }
    finally { if (this.starts.get(command.requestKey)?.promise === promise) this.starts.delete(command.requestKey); }
  }

  async prepareExternal(command, fingerprint, execute) {
    const previous = await this.store.findRequest(command.requestKey, fingerprint);
    if (previous) {
      if (previous.status === "completed" && previous.creationResult) return structuredClone(previous.creationResult);
      throw Object.assign(new OutcomeConflictError("原操作已有记录，请核对结果后使用新提交标识明确重试。"), { code: "OUTCOME_RETRY_REQUIRED" });
    }
    const operation = this.begin("创建文档");
    try {
      await this.assertRecovered();
      if (command.retryOf) {
        const prior = await this.store.get(command.retryOf);
        if (prior.origin !== "document-creation" || ["running", "stopping"].includes(prior.status) || (prior.status === "unknown" && !prior.recoveryAcknowledged)) throw new OutcomeConflictError("请先核对原文档创建操作，再明确重试。");
      }
      const document = await this.document.payload();
      const instruction = String(command.instruction || "").trim();
      if (!instruction) throw new OutcomeConflictError("请填写本次操作的要求。");
      const attemptId = randomUUID();
      const record = await this.store.create({
        kind: "execution", origin: "document-creation", status: "running", requestKey: command.requestKey,
        requestFingerprint: fingerprint, attemptId, agentRunId: command.requestKey,
        instruction, title: instruction.slice(0, 80), creationRequest: command.creationRequest,
        retryOf: command.retryOf, beforeContent: document.content, cwd: this.cwd,
        permissionMode: this.settings().permissionMode, verification: "not-checked", references: [], events: [],
        source: { id: `${document.path}:${document.revision}`, kind: "document", documentPath: document.path,
          title: document.title, start: 0, end: document.content.length, revision: document.revision, content: document.content,
          ...(document.referenceIdentity ? { sourceIdentity: document.referenceIdentity } : {}) }
      });
      if (record.attemptId !== attemptId) {
        this.finish(operation);
        if (record.status === "completed" && record.creationResult) return structuredClone(record.creationResult);
        throw Object.assign(new OutcomeConflictError("原操作已有记录，请等待并核对原结果。"), { code: "OUTCOME_RETRY_REQUIRED" });
      }
      operation.recordId = record.id;
      operation.attemptId = record.attemptId;
      this.currentRecordId = record.id;
      this.launch(record, operation, execute);
    } catch (error) {
      this.finish(operation);
      throw error;
    }
    await operation.done;
    if (operation.error) throw operation.error;
    if (operation.unknown) throw Object.assign(new OutcomeConflictError("文档创建结果未知，请先核对成果记录。"), { code: "AGENT_RUNTIME_LOST" });
    return operation.externalResult;
  }

  begin(label) {
    const { token, release } = this.gate.acquire(label);
    const operation = { token, release, events: [], eventWrites: Promise.resolve(), recordId: null, unknown: false, finished: false };
    operation.done = new Promise((resolve) => { operation.resolve = resolve; });
    this.current = operation;
    this.pending = operation.done;
    return operation;
  }

  async prepare(kind, command, fingerprint) {
    const existing = await this.store.findRequest(command.requestKey, fingerprint);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) throw new OutcomeConflictError("提交标识已用于不同的操作，请重新准备。");
      return existing;
    }
    const operation = this.begin(kind === "proposal" ? "生成文档提案" : "直接执行");
    try {
      await this.assertRecovered();
      const document = await this.document.payload();
      if (document.revision !== command.documentRevision) throw new OutcomeConflictError("文档已经变化，请保存后重新确认。");
      if (command.references !== undefined && !Array.isArray(command.references)) throw new OutcomeConflictError("参考资料格式不正确。");
      let origin = "outcome";
      if (command.retryOf) {
        const prior = await this.store.get(command.retryOf);
        const priorOrigin = prior.origin || (prior.messageId && prior.source?.messageId === prior.messageId ? "discussion" : "outcome");
        if (priorOrigin === "document-creation") throw Object.assign(new OutcomeConflictError("请恢复原文档创建要求，从创建入口明确重试。"), { code: "OUTCOME_RETRY_ORIGIN", origin: priorOrigin });
        if (kind !== "execution" || prior.kind !== "execution" || !["completed", "failed", "interrupted", "unknown"].includes(prior.status)
          || (prior.status === "unknown" && !prior.recoveryAcknowledged)) throw new OutcomeConflictError("请先核对前次执行，再准备一次新执行。");
        if (priorOrigin === "discussion") {
          if (command.source?.kind !== "message" || command.source.documentPath !== prior.source.documentPath
            || command.source.threadId !== prior.source.threadId || command.source.messageId !== prior.source.messageId) {
            throw Object.assign(new OutcomeConflictError("再次执行的来源必须是前次记录中的原问题，请重新核对来源。"), { code: "OUTCOME_RETRY_SOURCE" });
          }
          origin = "discussion";
        }
      }
      let sources;
      try {
        sources = await captureReferences([command.source, ...(command.references || [])], {
          document, threadStore: this.document.threadStore, resolveDocument: this.resolveDocument
        });
      } catch (error) {
        if (command.retryOf) throw sourceUnavailable(error);
        throw error;
      }
      const source = sources[0];
      if (!source || source.kind !== "message" || source.documentPath !== document.path) throw new OutcomeConflictError("请选择当前文档的已完成回答作为来源。");
      await this.sourceAnswer({ source, origin });
      const instruction = String(command.instruction || "").trim();
      if (!instruction) throw new OutcomeConflictError("请填写本次操作的要求。");
      if (operation.token.stopping) throw interrupted();
      const attemptId = randomUUID();
      const record = await this.store.create({
        kind, origin, status: kind === "proposal" ? "generating" : "running", requestKey: command.requestKey,
        requestFingerprint: fingerprint, attemptId, agentRunId: attemptId,
        title: instruction.slice(0, 80), source, references: sources, instruction,
        ...(kind === "proposal" ? { target: proposalTarget(document, command.target), baseContent: document.content, baseRevision: document.revision } : {
          cwd: this.cwd, permissionMode: this.settings().permissionMode, restrictions: String(command.restrictions || ""),
          acceptance: String(command.acceptance || ""), verification: "not-checked", retryOf: command.retryOf || undefined,
          beforeContent: document.content, threadId: source.threadId
        }), events: []
      });
      // A different owner may have persisted the same request while we prepared it.
      if (record.attemptId !== attemptId) { this.finish(operation); return record; }
      operation.recordId = record.id;
      operation.attemptId = record.attemptId;
      this.currentRecordId = record.id;
      this.launch(record, operation);
      return record;
    } catch (error) {
      this.finish(operation);
      throw error;
    }
  }

  async sourceAnswer(record) {
    let thread;
    try { thread = await this.document.threadStore.get(record.source.threadId); }
    catch (error) { throw sourceUnavailable(error); }
    const answer = thread.messages.find((message) => message.id === record.source.messageId);
    const role = record.origin === "discussion" ? "user" : "assistant";
    if (!answer || answer.role !== role || answer.error || referenceRevision(answer.content) !== record.source.revision) throw sourceUnavailable();
    return answer;
  }

  captureEvent(operation, update) {
    if (operation.finished) return;
    const event = structuredClone({ ...update, at: update.at || new Date().toISOString() });
    operation.events.push(event);
    if (operation.events.length > 240) operation.events.splice(0, operation.events.length - 240);
    if (event.type === "run") {
      operation.runtime = runtimeMetadata(event, operation.runtime);
      if (event.terminal) operation.nativeTerminal = event.status;
      if (event.status === "unknown") {
        operation.unknown = true;
        this.gate.retain(operation.token);
      }
    }
    // Capture now: deferred I/O must not turn every queued write into the final snapshot.
    const patch = structuredClone({ events: operation.events, ...(operation.runtime ? { runtime: operation.runtime, process: operation.runtime.process } : {}) });
    operation.eventWrites = operation.eventWrites.catch(() => {}).then(() => this.store.update(operation.recordId, (latest) => (
      latest.attemptId !== operation.attemptId ? null : {
        ...patch, ...(operation.unknown ? { status: "unknown", recoveryAcknowledged: false } : {})
      }
    )));
    void operation.eventWrites.catch((error) => {
      operation.persistenceError = error;
      if (operation.unknown) this.rememberRecovery(operation, error);
    });
  }

  launch(record, operation, execute = null) {
    const onUpdate = (update) => this.captureEvent(operation, update);
    operation.task = Promise.resolve().then(async () => {
      if (operation.token.stopping) throw interrupted();
      if (execute) {
        const result = await execute({ record, operationToken: operation.token, onUpdate, isStopping: () => Boolean(operation.token.stopping || operation.unknown) });
        operation.completedWork = true;
        operation.externalResult = structuredClone(result);
        operation.result = typeof result?.content === "string" ? result.content : "";
        await operation.eventWrites.catch(() => {});
        await this.store.update(record.id, (latest) => ({
          status: operation.unknown || latest.status === "unknown" ? "unknown" : operation.token.stopping ? "interrupted" : "completed",
          creationResult: operation.externalResult, newDocumentPath: result?.path,
          result: operation.result, events: structuredClone(operation.events),
          ...(operation.unknown ? { recoveryAcknowledged: false } : {})
        }));
        if (operation.token.stopping) throw interrupted();
      } else if (record.kind === "proposal") {
        await this.proposals.generate(record, onUpdate, {
          isStopping: () => operation.token.stopping,
          beforeCommit: () => operation.eventWrites.catch(() => {})
        });
      } else {
        const answer = await this.sourceAnswer(record);
        if (operation.token.stopping) throw interrupted();
        const instruction = [
          "直接执行以下要求。开始任何修改前，先检查当前文件和已有结果，避免重复执行。",
          record.retryOf ? "这是一次新的执行；前次执行可能已有部分文件修改，请先核对。" : "",
          "目标：" + record.instruction, "限制：" + (record.restrictions || "无额外限制"),
          "验收条件：" + (record.acceptance || "未提供；不要声称已经验收"),
          "完成后逐项说明检查命令、实际证据及通过、失败或未验证的部分。"
        ].filter(Boolean).join("\n\n");
        const result = await this.conversation.addQuestion(record.source.threadId, {
          content: instruction, askAgent: true, parentMessageId: answer.role === "user" ? answer.id : answer.nodeId || answer.parentId,
          agentRunId: record.agentRunId, references: record.references,
          operationToken: operation.token, onUpdate, executionId: record.id,
          onQuestion: async (message) => this.store.update(record.id, { messageId: message.id })
        });
        operation.completedWork = true;
        const meta = result.assistantMessage?.meta || {};
        operation.result = result.assistantMessage?.content || "";
        const status = operation.unknown || meta.outcomeUnknown ? "unknown"
          : meta.interrupted ? "interrupted"
          : operation.nativeTerminal || (result.agentOutcome === "failed" ? "failed" : operation.token.stopping ? "interrupted" : "completed");
        if (status === "unknown") {
          operation.unknown = true;
          this.gate.retain(operation.token);
        }
        await operation.eventWrites.catch(() => {});
        await this.store.update(record.id, (latest) => ({
          status: latest.status === "unknown" ? "unknown" : status,
          result: result.assistantMessage?.content || "",
          error: result.agentOutcome === "failed" ? result.assistantMessage?.content : undefined,
          ...(status === "unknown" ? { recoveryAcknowledged: false } : {}),
          events: structuredClone(operation.events)
        }));
      }
    }).catch(async (error) => {
      operation.error = error;
      await operation.eventWrites.catch(() => {});
      const unknown = operation.unknown || unknownCodes.has(error.code) || error.result?.terminal === false
        || (operation.completedWork && error.code !== "AGENT_INTERRUPTED");
      if (unknown) { operation.unknown = true; this.gate.retain(operation.token); }
      if (error.result) operation.runtime = runtimeMetadata(error.result, operation.runtime);
      const partial = error.content ?? error.partialContent;
      if (typeof partial === "string") operation.result = partial;
      await this.store.update(record.id, (latest) => ({
        status: unknown || latest.status === "unknown" ? "unknown" : error.code === "AGENT_INTERRUPTED" || operation.token.stopping ? "interrupted" : "failed",
        error: error.message, errorCode: error.code,
        ...(operation.result !== undefined ? { result: operation.result } : {}),
        ...(operation.externalResult ? { creationResult: operation.externalResult, newDocumentPath: operation.externalResult.path } : {}),
        ...(unknown ? { recoveryAcknowledged: false } : {}),
        ...(operation.runtime ? { runtime: operation.runtime, process: operation.runtime.process } : {}),
        events: structuredClone(operation.events.length ? operation.events : error.updates || [])
      }));
    }).then(async () => {
      await operation.eventWrites.catch(() => {});
      const after = await this.afterContent();
      await this.store.update(record.id, {
        ...after, ...(operation.persistenceError ? { eventsIncomplete: true, persistenceError: operation.persistenceError.message } : {})
      });
    }).catch((error) => {
      operation.error ||= error;
      this.rememberRecovery(operation, error);
      console.error("Outcome persistence failed:", record.id, error.message);
    }).finally(() => this.finish(operation));
    void operation.task.catch(() => {});
  }

  async afterContent() {
    try { return { afterContent: (await this.document.payload()).content }; }
    catch (error) { return { afterContentUnavailable: true, afterContentError: error.message }; }
  }

  rememberRecovery(operation, error) {
    operation.unknown = true;
    operation.persistenceError = error;
    this.recoveryOperation = operation;
    this.gate.retain(operation.token);
  }

  async persistRecoveryOperation() {
    const operation = this.recoveryOperation;
    if (operation) {
      operation.recoveryWrite ||= Promise.resolve().then(async () => {
        await this.store.update(operation.recordId, {
          status: "unknown", recoveryAcknowledged: false, eventsIncomplete: true,
          error: "成果保存未完成，请核对当前文件和运行结果后确认。",
          persistenceError: operation.persistenceError.message,
          ...(operation.result !== undefined ? { result: operation.result } : {}),
          ...(operation.externalResult ? { creationResult: operation.externalResult, newDocumentPath: operation.externalResult.path } : {}),
          ...(operation.runtime ? { runtime: operation.runtime, process: operation.runtime.process } : {}),
          events: structuredClone(operation.events), ...await this.afterContent()
        });
        if (this.recoveryOperation === operation) this.recoveryOperation = null;
      }).finally(() => {
        operation.recoveryWrite = null;
      });
      await operation.recoveryWrite;
    }
    for (const recovery of this.recoveryRecords.values()) await this.#persistRecoveryRecord(recovery);
  }

  finish(operation) {
    operation.finished = true;
    if (this.current === operation) {
      this.current = null;
      this.currentRecordId = null;
      this.pending = null;
    }
    operation.release();
    operation.resolve();
  }

  async stop(command = {}) {
    const active = this.gate.active;
    const operationId = command.operationId;
    if (operationId !== undefined) {
      if (typeof operationId !== "string" || !operationId) throw staleStop();
      if (this.stops.has(operationId)) return this.stops.get(operationId);
      if (operationId !== active?.id) throw staleStop();
    }
    if (!active) return this.snapshot();
    if (active.stopPromise) return active.stopPromise;
    active.stopping = true;
    const operation = this.current;
    active.stopPromise = Promise.resolve().then(async () => {
      const nativeStop = Promise.resolve().then(() => this.agent.stop());
      // Register a rejection handler immediately while the stopping journal is saved.
      void nativeStop.catch(() => {});
      if (operation?.recordId) {
        try {
          await this.store.update(operation.recordId, (record) => (
            ["running", "generating"].includes(record.status) ? { status: "stopping" } : null
          ));
        } catch (error) { operation.persistenceError = error; }
      }
      try {
        const result = await nativeStop;
        if (result?.terminal === false) throw Object.assign(new Error("停止未确认，请核对原生运行。"), { code: "AGENT_STOP_TIMEOUT", result });
        if (operation && result?.terminal && result.status !== "idle") operation.nativeTerminal = result.status;
      } catch (error) {
        if (!unknownCodes.has(error.code) && !this.agent.isBusy?.()) throw error;
        this.gate.retain(active);
        if (operation?.recordId) {
          operation.unknown = true;
          operation.runtime = runtimeMetadata(error.result || this.agent.status?.().runs?.[0] || {}, operation.runtime);
          await operation.eventWrites.catch(() => {});
          try {
            await this.store.update(operation.recordId, {
              status: "unknown", error: error.message, errorCode: error.code, recoveryAcknowledged: false,
              runtime: operation.runtime, process: operation.runtime.process
            });
          } catch (persistenceError) {
            this.rememberRecovery(operation, persistenceError);
            throw persistenceError;
          }
        } else {
          await this.recordUnownedFailure(error);
        }
        return this.snapshot();
      }
      await (operation?.done || active.done);
      return this.snapshot();
    });
    const stopPromise = active.stopPromise;
    this.stops.set(active.id, stopPromise);
    // A failed journal write is retryable; only successful stop results are replayed.
    void stopPromise.catch(() => {
      if (this.stops.get(active.id) === stopPromise) this.stops.delete(active.id);
      if (active.stopPromise === stopPromise) delete active.stopPromise;
    });
    if (this.stops.size > 120) this.stops.delete(this.stops.keys().next().value);
    return active.stopPromise;
  }

  async recordUnownedFailure(error, { threadId, questionMessageId, events, agentSnapshot } = {}) {
    // launch() already owns the journal and recovery for an outcome execution.
    if (this.current?.recordId) return;
    const runtime = runtimeMetadata(error.result || this.agent.status?.().runs?.[0] || {});
    const owner = this.gate.active;
    const key = runtime.runId || (questionMessageId ? `${threadId}:${questionMessageId}` : owner?.id) || randomUUID();
    let recovery = this.recoveryRecords.get(key);
    if (!recovery) {
      // Freeze the failure before any journal I/O. A late native terminal result
      // must not erase the evidence needed to retry a failed recovery write.
      recovery = {
        key, owner, runtime, threadId: threadId || runtime.threadId, questionMessageId,
        fallbackRequestKey: runtime.runId || `recovery:${owner?.id || randomUUID()}`,
        document: structuredClone(agentSnapshot?.document), sourceIdentity: this.document.referenceIdentity,
        result: error.content || error.partialContent || "", events: structuredClone(events || error.updates || []),
        error: error.message, errorCode: error.code, fields: null, write: null
      };
      this.recoveryRecords.set(key, recovery);
    }
    return this.#persistRecoveryRecord(recovery);
  }

  async #recoveryRecordFields(recovery) {
    const thread = (await this.document.threadStore.list()).find((item) => item.id === recovery.threadId);
    const question = recovery.questionMessageId
      ? thread?.messages.find((message) => message.id === recovery.questionMessageId && message.role === "user")
      : thread?.messages.filter((message) => message.role === "user").at(-1);
    // Ordinary recovery needs the saved question, not the still-existing Markdown.
    // A source snapshot is optional context when the question itself is unavailable.
    const document = question ? null : recovery.document || await this.document.payload().catch(() => null);
    const documentPath = this.document.filePath;
    const source = question ? {
      id: question.id, kind: "message", documentPath, title: thread.title,
      threadId: thread.id, messageId: question.id, start: 0, end: question.content.length,
      revision: referenceRevision(question.content), content: question.content
    } : {
      id: documentPath, kind: "document", documentPath, title: document?.title || documentPath,
      start: 0, end: document?.content.length || 0, revision: document?.revision || referenceRevision(""), content: document?.content || ""
    };
    if (recovery.sourceIdentity) source.sourceIdentity = recovery.sourceIdentity;
    return structuredClone({
      kind: "execution", origin: "discussion", status: "unknown", requestKey: question?.meta?.agentRunId || recovery.fallbackRequestKey,
      title: question?.content.slice(0, 80) || "原生运行状态核对", instruction: question?.content || "原始请求不可用，请核对当前文件和原进程。",
      source, references: question?.meta?.references || [], threadId: thread?.id, messageId: question?.id,
      result: recovery.result, events: recovery.events,
      runtime: recovery.runtime, process: recovery.runtime.process, error: recovery.error, errorCode: recovery.errorCode,
      verification: "not-checked", recoveryAcknowledged: false
    });
  }

  async #persistRecoveryRecord(recovery) {
    recovery.write ||= Promise.resolve().then(async () => {
      recovery.fields ||= await this.#recoveryRecordFields(recovery);
      // The normal execution owner may already have journaled this run. Also
      // respect deletion tombstones so a late callback cannot resurrect it.
      if (await this.store.hasRun(recovery.fields.requestKey)) {
        this.recoveryRecords.delete(recovery.key);
        return;
      }
      const record = await this.store.create(recovery.fields);
      this.gate.retain(recovery.owner);
      this.recoveryRecords.delete(recovery.key);
      return record;
    }).catch((error) => {
      this.gate.retain(recovery.owner);
      throw error;
    }).finally(() => { recovery.write = null; });
    return recovery.write;
  }

  async acknowledge(id, command) {
    await this.persistRecoveryOperation();
    const initial = await this.store.get(id);
    if (initial.status !== "unknown" || command.confirmed !== true) throw new OutcomeConflictError("请确认原执行已结束且不会继续写入。");
    if (initial.recoveryAcknowledged) return { record: initial };
    return this.gate.recover(async (previous) => {
      if (typeof this.agent.resetRecovery !== "function") throw new OutcomeConflictError("当前运行时不支持可靠重置，请重启服务后再核对。");
      const operation = this.current;
      await this.agent.resetRecovery({ confirmed: true });
      await (operation?.done || previous?.done);
      await this.persistRecoveryOperation();
      if (this.agent.isBusy?.()) throw new OutcomeConflictError("旧运行尚未结束，不能解除保护。");
      const record = await this.store.update(id, (latest) => {
        if (latest.status !== "unknown") throw new OutcomeConflictError();
        return { recoveryAcknowledged: true, recoveryAcknowledgedAt: new Date().toISOString() };
      });
      return { record };
    });
  }

  async refine(id, command) {
    const operation = this.begin("继续调整提案");
    try {
      await this.assertRecovered();
      const record = await this.store.get(id);
      if (record.kind !== "proposal" || !["review", "conflict", "failed", "interrupted"].includes(record.status) || !String(command.instruction || "").trim()) throw new OutcomeConflictError();
      if (!Number.isSafeInteger(command.expectedRevision)) throw new OutcomeConflictError("缺少成果版本。");
      const attemptId = randomUUID();
      const updated = await this.store.update(id, {
        status: "generating", instruction: String(command.instruction).trim(), attemptId, agentRunId: attemptId,
        events: [], error: undefined
      }, command.expectedRevision);
      operation.recordId = id;
      operation.attemptId = attemptId;
      this.currentRecordId = id;
      this.launch(updated, operation);
      return { record: updated };
    } catch (error) {
      this.finish(operation);
      throw error;
    }
  }

  async change(id, action, command = {}) {
    if (action === "acknowledge") return this.acknowledge(id, command);
    if (!this.current && !this.agent.isBusy?.() && this.store.hasPendingApplication) await this.proposals.recover({ runs: false });
    if (action === "refine") return this.refine(id, command);
    return this.gate.run("处理成果记录", async () => {
      const record = await this.store.get(id);
      await this.assertRecovered();
      if (action === "delete") return this.store.delete(id);
      if (action === "verify") {
        if (record.kind !== "execution" || (!["completed", "failed", "interrupted"].includes(record.status) && !(record.status === "unknown" && record.recoveryAcknowledged)) || !["passed", "failed", "not-checked"].includes(command.verification)) throw new OutcomeConflictError();
        if (!Number.isSafeInteger(command.expectedRevision)) throw new OutcomeConflictError("缺少成果版本。");
        if (command.verification !== "not-checked" && !String(command.verificationNote || "").trim()) throw new OutcomeConflictError("请填写验证证据或未通过原因。");
        return { record: await this.store.update(id, { verification: command.verification, verificationNote: String(command.verificationNote || "") }, command.expectedRevision) };
      }
      if (record.kind !== "proposal") throw new OutcomeConflictError();
      if (action === "edit") return { record: await this.proposals.edit(id, command) };
      if (action === "rebase") return { record: await this.proposals.rebase(id, command) };
      if (action === "apply") return this.proposals.apply(id, command.expectedRevision);
      if (action === "undo") return this.proposals.undo(id);
      if (action === "discard") {
        if (!["review", "conflict", "failed", "interrupted"].includes(record.status)) throw new OutcomeConflictError();
        if (!Number.isSafeInteger(command.expectedRevision)) throw new OutcomeConflictError("缺少成果版本。");
        return { record: await this.store.update(id, { status: "discarded" }, command.expectedRevision) };
      }
      throw new OutcomeConflictError("未知成果操作。");
    });
  }
}

function runtimeMetadata(value, previous = {}) {
  const metadata = Object.fromEntries(["runId", "threadId", "sessionKey", "sessionId", "turnId", "mode", "status", "terminal", "process"].filter((key) => value[key] !== undefined).map((key) => [key, structuredClone(value[key])]));
  return { ...previous, ...metadata, ...(previous.process || metadata.process ? { process: { ...previous.process, ...metadata.process } } : {}) };
}

function interrupted() { return Object.assign(new Error("操作已中断，已有结果保留。"), { code: "AGENT_INTERRUPTED" }); }
function sourceUnavailable(cause) {
  return Object.assign(new OutcomeConflictError("来源消息已改变或删除，请重新选择来源并准备执行；前次执行快照仍保留。"), { code: "OUTCOME_SOURCE_UNAVAILABLE", cause });
}
function staleStop() {
  return Object.assign(new OutcomeConflictError("停止请求属于旧操作，请刷新当前执行状态。"), { code: "OUTCOME_STOP_STALE" });
}
