import {
  ConversationConflictError,
  ConversationRuleError,
  planConversationQuestion,
  planConversationRevision
} from "./conversation-model.js";
import { branchThreadForQuestion } from "./thread-tree.js";
import { normalizeAgentRunId } from "./agent-run-broker.js";

export class ConversationService {
  constructor({
    threadStore,
    document,
    agent,
    agentRuns = null,
    onAgentError = () => {}
  }) {
    this.threadStore = threadStore;
    this.document = document;
    this.agent = agent;
    this.agentRuns = agentRuns;
    this.onAgentError = onAgentError;
    this.activeReplies = new Map();
    this.activeThreadOperations = new Map();
  }

  addQuestion(threadId, command) {
    return this.withThreadOperation(
      threadId,
      () => this.addQuestionWithinOperation(threadId, command)
    );
  }

  async addQuestionWithinOperation(threadId, command) {
    const agentRunId = normalizeAgentRunId(command.agentRunId);
    const thread = await this.threadStore.get(threadId);
    const planned = planConversationQuestion(thread, command);
    const userMessage = await this.threadStore.addMessage(threadId, {
      ...planned.message,
      meta: {
        ...(planned.message.meta || {}),
        ...(planned.askAgent && agentRunId ? { agentRunId } : {})
      }
    });

    if (!planned.askAgent) {
      return {
        userMessage,
        assistantMessage: null,
        agentOutcome: "not-requested",
        threads: await this.threadStore.list(),
        document: null
      };
    }

    const reply = await this.createAssistantReply(
      threadId,
      planned.message.content,
      userMessage.id,
      agentRunId
    );
    return {
      userMessage,
      ...reply,
      threads: await this.threadStore.list()
    };
  }

  reviseQuestion(threadId, messageId, command) {
    return this.withThreadOperation(
      threadId,
      () => this.reviseQuestionWithinOperation(threadId, messageId, command)
    );
  }

  async reviseQuestionWithinOperation(threadId, messageId, command) {
    const agentRunId = normalizeAgentRunId(command.agentRunId);
    const thread = await this.threadStore.get(threadId);
    const planned = planConversationRevision(thread, messageId, command);
    const message = await this.threadStore.addMessage(threadId, {
      ...planned.message,
      meta: {
        ...(planned.message.meta || {}),
        ...(planned.askAgent && agentRunId ? { agentRunId } : {})
      }
    });

    if (!planned.askAgent) {
      return {
        message,
        assistantMessage: null,
        agentOutcome: "not-requested",
        threads: await this.threadStore.list(),
        document: null
      };
    }

    const reply = await this.createAssistantReply(
      threadId,
      planned.message.content,
      message.id,
      agentRunId
    );
    return {
      message,
      ...reply,
      threads: await this.threadStore.list()
    };
  }

  updateQuestion(threadId, messageId, options) {
    return this.withThreadOperation(
      threadId,
      () => this.updateQuestionWithinOperation(threadId, messageId, options)
    );
  }

  async updateQuestionWithinOperation(
    threadId,
    messageId,
    { content, rerunAgent = false, agentRunId = null }
  ) {
    const normalizedAgentRunId = normalizeAgentRunId(agentRunId);
    const normalizedContent = String(content || "").trim();
    if (!normalizedContent) {
      const error = new Error("message content is required");
      error.statusCode = 400;
      throw error;
    }

    const storedThread = await this.threadStore.get(threadId);
    const storedMessage = storedThread.messages.find(
      (message) => message.id === messageId && message.role === "user"
    );
    if (!storedMessage) throw new Error(`question message not found: ${messageId}`);
    if (storedMessage.content.trim() !== normalizedContent) {
      throw new ConversationRuleError(
        "message content changes must create a revision branch"
      );
    }

    const replyKey = activeReplyKey(threadId, messageId);
    const activeReply = this.activeReplies.get(replyKey);
    if (activeReply) {
      if (rerunAgent && activeReply.content === normalizedContent) {
        if (normalizedAgentRunId) {
          await this.threadStore.setAgentRunId(threadId, messageId, normalizedAgentRunId);
          this.attachAgentRun(activeReply.progress, normalizedAgentRunId, threadId, messageId);
        }
      }
      const reply = await activeReply.promise;
      if (rerunAgent && activeReply.content === normalizedContent) {
        const thread = await this.threadStore.get(threadId);
        const message = thread.messages.find((item) => item.id === messageId && item.role === "user");
        if (!message) throw new Error(`question message not found: ${messageId}`);
        return {
          message,
          ...reply,
          threads: await this.threadStore.list()
        };
      }
    }

    const shouldRerunAgent = rerunAgent || (await this.threadStore.hasAssistantAfter(threadId, messageId));
    const patch = {
      content: normalizedContent,
      ...(shouldRerunAgent ? { agentRunId: normalizedAgentRunId } : {})
    };
    const message = shouldRerunAgent
      ? (await this.threadStore.prepareQuestionRerun(threadId, messageId, patch)).message
      : await this.threadStore.updateMessage(threadId, messageId, patch);
    let reply = {
      assistantMessage: null,
      agentOutcome: "not-requested",
      document: null
    };
    if (shouldRerunAgent) {
      reply = await this.createAssistantReply(
        threadId,
        normalizedContent,
        messageId,
        normalizedAgentRunId
      );
    }
    return {
      message,
      ...reply,
      threads: await this.threadStore.list()
    };
  }

  async deleteThread(threadId) {
    this.assertThreadIdle(threadId, "delete this thread");
    await this.threadStore.delete(threadId);
  }

  async deleteMessage(threadId, messageId) {
    this.assertThreadIdle(threadId, "delete a message");
    return this.threadStore.deleteMessage(threadId, messageId);
  }

  assertThreadIdle(threadId, action) {
    const prefix = `${threadId}:`;
    if (
      (this.activeThreadOperations.get(threadId) || 0) > 0 ||
      [...this.activeReplies.keys()].some((key) => key.startsWith(prefix))
    ) {
      throw new ConversationConflictError(
        `Cannot ${action} while this thread is being updated; wait for the operation to finish and retry.`
      );
    }
  }

  async withThreadOperation(threadId, operation) {
    this.activeThreadOperations.set(
      threadId,
      (this.activeThreadOperations.get(threadId) || 0) + 1
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.activeThreadOperations.get(threadId) || 1) - 1;
      if (remaining === 0) {
        this.activeThreadOperations.delete(threadId);
      } else {
        this.activeThreadOperations.set(threadId, remaining);
      }
    }
  }

  createAssistantReply(threadId, content, questionMessageId, agentRunId = null) {
    const key = activeReplyKey(threadId, questionMessageId);
    const activeReply = this.activeReplies.get(key);
    if (activeReply?.content === content) {
      this.attachAgentRun(activeReply.progress, agentRunId, threadId, questionMessageId);
      return activeReply.promise;
    }

    const progress = {
      runIds: new Set(),
      events: [],
      error: null,
      startedAt: Date.now()
    };
    this.attachAgentRun(progress, agentRunId, threadId, questionMessageId);

    const work = activeReply
      ? activeReply.promise.catch(() => {}).then(() => this.runAssistantReply(threadId, content, questionMessageId, progress))
      : this.runAssistantReply(threadId, content, questionMessageId, progress);
    const task = work.then(
      (reply) => {
        this.completeAgentRuns(
          progress,
          reply.agentOutcome === "failed" ? "failed" : "completed",
          progress.error
        );
        return reply;
      },
      (error) => {
        this.completeAgentRuns(progress, "failed", error);
        throw error;
      }
    );
    const trackedTask = task.finally(() => {
      if (this.activeReplies.get(key)?.promise === trackedTask) {
        this.activeReplies.delete(key);
      }
    });
    this.activeReplies.set(key, { content, promise: trackedTask, progress });
    return trackedTask;
  }

  async runAssistantReply(threadId, content, questionMessageId, progress) {
    return this.document.withAgentTurn(() => (
      this.runAssistantReplyWithinDocumentTurn(
        threadId,
        content,
        questionMessageId,
        progress
      )
    ));
  }

  async runAssistantReplyWithinDocumentTurn(threadId, content, questionMessageId, progress) {
    const agentSnapshot = await this.document.createAgentSnapshot();
    const storedThread = await this.threadStore.prepareAgentTurn(threadId, questionMessageId);
    const question = storedThread.messages.find(
      (message) => message.id === questionMessageId && message.role === "user"
    );
    if (!question) throw new Error(`question message not found: ${questionMessageId}`);
    const thread = branchThreadForQuestion(storedThread, questionMessageId);
    let answer;

    try {
      answer = await this.agent.runTurn({
        question: content,
        document: agentSnapshot.document,
        thread,
        mode: "chat",
        onUpdate: (update) => this.publishAgentUpdate(progress, update)
      });
    } catch (initialError) {
      if (initialError instanceof ConversationConflictError) throw initialError;
      return this.persistAgentFailure(
        threadId,
        questionMessageId,
        initialError,
        agentSnapshot,
        thread.revision,
        { progress }
      );
    }

    const completed = await this.document.completeAgentTurnFromSnapshot({
      snapshot: agentSnapshot,
      threadId,
      userMessageId: questionMessageId,
      message: assistantMessageForAnswer(answer),
      agentSession: answer.session,
      expectedBranchRevision: thread.revision
    });

    return {
      assistantMessage: completed.assistantMessage,
      agentOutcome: "completed",
      document: completed.document
    };
  }

  attachAgentRun(progress, agentRunId, threadId, questionMessageId) {
    if (!agentRunId || !this.agentRuns || progress.runIds.has(agentRunId)) return;
    progress.runIds.add(agentRunId);
    this.agentRuns.start(agentRunId, { threadId, questionMessageId });
    for (const event of progress.events) this.agentRuns.publish(agentRunId, event);
  }

  publishAgentUpdate(progress, update) {
    progress.events.push(update);
    if (progress.events.length > 120) progress.events = selectProgressEvents(progress.events, 120);
    for (const runId of progress.runIds) this.agentRuns?.publish(runId, update);
  }

  completeAgentRuns(progress, status, error = null) {
    const durationMs = Date.now() - progress.startedAt;
    for (const runId of progress.runIds) {
      this.agentRuns?.complete(runId, status, {
        durationMs,
        error: error instanceof Error ? error.message : null
      });
    }
  }

  async persistAgentFailure(
    threadId,
    questionMessageId,
    error,
    agentSnapshot,
    expectedBranchRevision,
    { progress = null } = {}
  ) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (progress) progress.error = error instanceof Error ? error : new Error(errorMessage);
    this.onAgentError({
      threadId,
      questionMessageId,
      code: error?.code || null,
      message: errorMessage
    });
    const completed = await this.document.completeAgentTurnFromSnapshot({
      snapshot: agentSnapshot,
      threadId,
      userMessageId: questionMessageId,
      message: {
        role: "assistant",
        content: agentFailureContent(errorMessage),
        error: true,
        meta: {
          durationMs: Number.isFinite(error?.durationMs) ? error.durationMs : null,
          updates: Array.isArray(error?.updates) ? error.updates : [],
          model: typeof error?.model === "string" ? error.model : null,
          reasoningEffort: typeof error?.reasoningEffort === "string" ? error.reasoningEffort : null
        }
      },
      agentSession: null,
      expectedBranchRevision
    });
    return {
      assistantMessage: completed.assistantMessage,
      agentOutcome: "failed",
      document: completed.document
    };
  }
}

function selectProgressEvents(events, limit) {
  const latestFeatured = new Map();
  for (const event of events) {
    if (!["plan", "diff", "subagent"].includes(event?.type)) continue;
    const key = [event.scope || "main", event.agentThreadId || "main", event.type, event.itemId || event.agentThreadId || event.type].join(":");
    latestFeatured.set(key, event);
  }
  const selected = new Set(latestFeatured.values());
  for (let index = events.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    selected.add(events[index]);
  }
  return events.filter((event) => selected.has(event));
}

function assistantMessageForAnswer(answer) {
  return {
    role: "assistant",
    content: answer.content,
    meta: {
      stopReason: answer.stopReason,
      transport: answer.transport,
      appliedEdit: Boolean(answer.appliedEdit),
      updates: answer.updates,
      durationMs: Number.isFinite(answer.durationMs) ? answer.durationMs : null,
      model: typeof answer.model === "string" ? answer.model : null,
      reasoningEffort: typeof answer.reasoningEffort === "string" ? answer.reasoningEffort : null
    }
  };
}

function activeReplyKey(threadId, questionMessageId) {
  return `${threadId}:${questionMessageId}`;
}

function agentFailureContent(errorMessage) {
  const nativeStartupFailure = /Failed to start Codex app-server command|XUANNIAO_CODEX_CMD is empty/.test(errorMessage);
  const lines = ["Codex request failed.", "", errorMessage];
  if (nativeStartupFailure) {
    lines.push(
      "",
      "Install and authenticate the Codex CLI, or set XUANNIAO_CODEX_CMD to a compatible Codex app-server command:",
      "",
      "```bash",
      "codex login",
      'XUANNIAO_CODEX_CMD="codex app-server" npm start -- prd.md',
      "```"
    );
  } else {
    lines.push("", "Retry the request or inspect the agent runtime status and server log for details.");
  }
  return lines.join("\n");
}
