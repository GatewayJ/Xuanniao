import { ConversationConflictError, planConversationQuestion } from "./conversation-model.js";
import { branchThreadForQuestion } from "./thread-tree.js";
import { normalizeAgentRunId } from "./agent-run-broker.js";

export class ConversationService {
  constructor({
    threadStore,
    document,
    agent,
    agentRuns = null,
    controlledReplacement = false,
    onAgentError = () => {}
  }) {
    this.threadStore = threadStore;
    this.document = document;
    this.agent = agent;
    this.agentRuns = agentRuns;
    this.controlledReplacement = controlledReplacement;
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
      startedAt: Date.now()
    };
    this.attachAgentRun(progress, agentRunId, threadId, questionMessageId);

    const work = activeReply
      ? activeReply.promise.catch(() => {}).then(() => this.runAssistantReply(threadId, content, questionMessageId, progress))
      : this.runAssistantReply(threadId, content, questionMessageId, progress);
    const task = work.then(
      (reply) => {
        this.completeAgentRuns(progress, reply.agentOutcome === "failed" ? "failed" : "completed");
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
    let updatedDocument = null;
    const agentSnapshot = await this.document.createAgentSnapshot();
    let snapshotVerified = false;
    const storedThread = await this.threadStore.get(threadId);
    const question = storedThread.messages.find(
      (message) => message.id === questionMessageId && message.role === "user"
    );
    if (!question) throw new Error(`question message not found: ${questionMessageId}`);
    const thread = branchThreadForQuestion(storedThread, questionMessageId);
    const editRequested =
      this.controlledReplacement &&
      wantsDocumentEdit(content) &&
      canReplaceSelection(storedThread);
    let answer;

    try {
      answer = await this.agent.runTurn({
        question: content,
        document: agentSnapshot.document,
        thread,
        mode: editRequested ? "replace-selection" : "chat",
        onUpdate: (update) => this.publishAgentUpdate(progress, update)
      });

      updatedDocument = await this.document.verifyAgentSnapshot(agentSnapshot);
      snapshotVerified = true;
    } catch (initialError) {
      if (initialError instanceof ConversationConflictError) throw initialError;
      let error = initialError;
      if (!snapshotVerified) {
        try {
          updatedDocument = await this.document.verifyAgentSnapshot(agentSnapshot);
        } catch (guardError) {
          if (guardError?.document) updatedDocument = guardError.document;
          error = guardError;
        }
      }
      return this.persistAgentFailure(
        threadId,
        questionMessageId,
        error,
        updatedDocument,
        thread.revision
      );
    }

    if (editRequested) {
      const replacement = extractReplacement(answer.content);
      if (replacement === null) {
        return this.persistAgentFailure(
          threadId,
          questionMessageId,
          new Error("Codex did not return a Xuanniao replacement block for the selected text."),
          updatedDocument,
          thread.revision
        );
      }
      const message = assistantMessageForAnswer({
        ...answer,
        content: [
          "Applied this replacement to the document:",
          "",
          "```md",
          replacement,
          "```"
        ].join("\n"),
        appliedEdit: true
      });
      const applied = await this.document.applySelectionReplacement({
        expectedRevision: agentSnapshot.revision,
        thread: storedThread,
        replacement,
        threadId,
        agentTurn: {
          userMessageId: questionMessageId,
          message,
          agentSession: answer.session,
          expectedBranchRevision: thread.revision
        }
      });
      updatedDocument = applied.document;
      return {
        assistantMessage: applied.assistantMessage,
        agentOutcome: "completed",
        document: updatedDocument
      };
    }

    const assistantMessage = await this.threadStore.completeAgentTurn(
      threadId,
      questionMessageId,
      assistantMessageForAnswer(answer),
      answer.session,
      thread.revision
    );

    return {
      assistantMessage,
      agentOutcome: "completed",
      document: updatedDocument
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
    if (progress.events.length > 120) progress.events.shift();
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
    updatedDocument,
    expectedBranchRevision
  ) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.onAgentError({
      threadId,
      questionMessageId,
      code: error?.code || null,
      message: errorMessage
    });
    const assistantMessage = await this.threadStore.completeAgentTurn(
      threadId,
      questionMessageId,
      {
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
      null,
      expectedBranchRevision
    );
    return {
      assistantMessage,
      agentOutcome: "failed",
      document: updatedDocument
    };
  }
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
  const acpStartupFailure = /Failed to start ACP command|XUANNIAO_ACP_CMD is empty/.test(errorMessage);
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
  } else if (acpStartupFailure) {
    lines.push(
      "",
      "Install codex-acp or set XUANNIAO_ACP_CMD to an ACP-compatible Codex adapter:",
      "",
      "```bash",
      "npm install -g @agentclientprotocol/codex-acp",
      'XUANNIAO_ACP_CMD="/path/to/codex-acp" npm start -- prd.md',
      "```"
    );
  } else {
    lines.push("", "Retry the request or inspect the agent runtime status and server log for details.");
  }
  return lines.join("\n");
}

function wantsDocumentEdit(text) {
  return /修改|改成|改为|替换|翻译|英文|translate|rewrite|replace|change|edit|update/i.test(text);
}

function canReplaceSelection(thread) {
  const anchor = thread?.anchor || {};
  return Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.end > anchor.start;
}

function extractReplacement(content) {
  const tagged = /<XUANNIAO_REPLACEMENT>\s*([\s\S]*?)\s*<\/XUANNIAO_REPLACEMENT>/i.exec(content);
  if (tagged) return tagged[1].replace(/\n$/, "");

  const fenced = /```(?:xuanniao-replacement|md|markdown)?\s*([\s\S]*?)```/i.exec(content);
  if (fenced && !/^[+-]/m.test(fenced[1])) return fenced[1].replace(/\n$/, "");

  const trimmed = content.trim();
  return trimmed && !trimmed.includes("```") && trimmed.length < 20_000 ? trimmed : null;
}
