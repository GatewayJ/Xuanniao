import { ConversationConflictError, planConversationQuestion } from "./conversation-model.js";
import { branchThreadForQuestion } from "./thread-tree.js";

export class ConversationService {
  constructor({
    threadStore,
    document,
    agent,
    controlledReplacement = false,
    onAgentError = () => {}
  }) {
    this.threadStore = threadStore;
    this.document = document;
    this.agent = agent;
    this.controlledReplacement = controlledReplacement;
    this.onAgentError = onAgentError;
    this.activeReplies = new Map();
  }

  async addQuestion(threadId, command) {
    const thread = await this.threadStore.get(threadId);
    const planned = planConversationQuestion(thread, command);
    const userMessage = planned.placement.kind === "append"
      ? await this.threadStore.addMessage(threadId, planned.message)
      : await this.threadStore.insertNodeAfter(
          threadId,
          planned.message.parentId,
          planned.message,
          planned.placement.insertBeforeNodeId
        );

    if (!planned.askAgent) {
      return {
        userMessage,
        assistantMessage: null,
        agentOutcome: "not-requested",
        threads: await this.threadStore.list(),
        document: null
      };
    }

    const reply = await this.createAssistantReply(threadId, planned.message.content, userMessage.id);
    return {
      userMessage,
      ...reply,
      threads: await this.threadStore.list()
    };
  }

  async updateQuestion(threadId, messageId, { content, rerunAgent = false }) {
    const normalizedContent = String(content || "").trim();
    if (!normalizedContent) {
      const error = new Error("message content is required");
      error.statusCode = 400;
      throw error;
    }

    const replyKey = activeReplyKey(threadId, messageId);
    const activeReply = this.activeReplies.get(replyKey);
    if (activeReply) {
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
    const message = await this.threadStore.updateMessage(threadId, messageId, {
      content: normalizedContent
    });
    let reply = {
      assistantMessage: null,
      agentOutcome: "not-requested",
      document: null
    };
    if (shouldRerunAgent) {
      await this.threadStore.removeAssistantAfter(threadId, messageId);
      reply = await this.createAssistantReply(threadId, normalizedContent, messageId);
    }
    return {
      message,
      ...reply,
      threads: await this.threadStore.list()
    };
  }

  createAssistantReply(threadId, content, questionMessageId) {
    const key = activeReplyKey(threadId, questionMessageId);
    const activeReply = this.activeReplies.get(key);
    if (activeReply?.content === content) return activeReply.promise;

    const task = activeReply
      ? activeReply.promise.catch(() => {}).then(() => this.runAssistantReply(threadId, content, questionMessageId))
      : this.runAssistantReply(threadId, content, questionMessageId);
    const trackedTask = task.finally(() => {
      if (this.activeReplies.get(key)?.promise === trackedTask) {
        this.activeReplies.delete(key);
      }
    });
    this.activeReplies.set(key, { content, promise: trackedTask });
    return trackedTask;
  }

  async runAssistantReply(threadId, content, questionMessageId) {
    let updatedDocument = null;
    let assistantMessage;
    let agentOutcome = "completed";
    let agentSnapshot = null;
    let snapshotVerified = false;

    try {
      agentSnapshot = await this.document.createAgentSnapshot();
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
      const answer = await this.agent.runTurn({
        question: content,
        document: agentSnapshot.document,
        thread,
        mode: editRequested ? "replace-selection" : "chat"
      });

      updatedDocument = await this.document.verifyAgentSnapshot(agentSnapshot);
      snapshotVerified = true;

      if (editRequested) {
        const replacement = extractReplacement(answer.content);
        if (replacement === null) {
          throw new Error("Codex did not return a Xuanniao replacement block for the selected text.");
        }
        const applied = await this.document.applySelectionReplacement({
          expectedRevision: agentSnapshot.revision,
          thread: storedThread,
          replacement,
          threadId
        });
        updatedDocument = applied.document;
        answer.content = [
          "Applied this replacement to the document:",
          "",
          "```md",
          replacement,
          "```"
        ].join("\n");
        answer.appliedEdit = true;
      }

      assistantMessage = await this.threadStore.completeAgentTurn(
        threadId,
        questionMessageId,
        {
          role: "assistant",
          content: answer.content,
          meta: {
            stopReason: answer.stopReason,
            transport: answer.transport,
            appliedEdit: Boolean(answer.appliedEdit),
            updates: answer.updates
          }
        },
        answer.session,
        thread.revision
      );
    } catch (initialError) {
      if (initialError instanceof ConversationConflictError) throw initialError;
      let error = initialError;
      if (agentSnapshot && !snapshotVerified) {
        try {
          updatedDocument = await this.document.verifyAgentSnapshot(agentSnapshot);
        } catch (guardError) {
          error = guardError;
        }
      }
      agentOutcome = "failed";
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.onAgentError({
        threadId,
        questionMessageId,
        code: error?.code || null,
        message: errorMessage
      });
      assistantMessage = await this.threadStore.completeAgentTurn(
        threadId,
        questionMessageId,
        {
          role: "assistant",
          content: agentFailureContent(errorMessage),
          error: true
        },
        null
      );
    }

    return {
      assistantMessage,
      agentOutcome,
      document: updatedDocument
    };
  }
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
