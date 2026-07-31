import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText } from "./atomic-file.js";
import { buildBlockIndex } from "./block-index.js";
import { reconcileThreadsForContent, remapThreadsForReplacement } from "./thread-anchor-remap.js";

const mutationLocks = new Map();
const controlledDocumentStates = new Map();

export class DocumentConflictError extends Error {
  constructor(message, currentRevision) {
    super(message);
    this.name = "DocumentConflictError";
    this.code = "DOCUMENT_CONFLICT";
    this.statusCode = 409;
    this.currentRevision = currentRevision;
  }
}

export class AgentDocumentMutationError extends Error {
  constructor(filePath, document) {
    super(
      `The active document changed outside a Xuanniao-controlled save while Codex was working. ` +
      `The current file was preserved; review it before retrying: ${filePath}`
    );
    this.name = "AgentDocumentMutationError";
    this.code = "AGENT_DOCUMENT_MUTATION";
    this.statusCode = 409;
    this.document = document;
  }
}

export class DocumentWorkspace {
  constructor(filePath, threadStore) {
    this.filePath = path.resolve(filePath);
    this.threadStore = threadStore;
    if (!controlledDocumentStates.has(this.filePath)) {
      controlledDocumentStates.set(this.filePath, {
        mutationEpoch: 0,
        snapshot: null
      });
    }
    this.controlledState = controlledDocumentStates.get(this.filePath);
  }

  async payload() {
    await this.waitForMutations();
    return payloadFor(this.filePath, await readFile(this.filePath, "utf8"));
  }

  async createThread({ title, selectedText, anchor, expectedRevision }) {
    return this.withMutation(async () => {
      const current = await this.snapshot();
      assertRevision(current, expectedRevision);
      const start = anchor?.start;
      const end = anchor?.end;
      const canonicalSelectedText = Number.isInteger(start) && Number.isInteger(end)
        ? current.content.slice(start, end)
        : "";
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        normalizeSelectedText(canonicalSelectedText) !== normalizeSelectedText(selectedText)
      ) {
        throw new DocumentConflictError(
          "Selected text no longer matches the current document. Re-select it before creating a thread.",
          current.revision
        );
      }
      return this.threadStore.create({ title, selectedText: canonicalSelectedText, anchor });
    });
  }

  async save({ content, expectedRevision, anchorPatches = null, deletedThreadIds = [] }) {
    return this.withMutation(async () => {
      const before = await this.snapshot();
      assertRevision(before, expectedRevision);
      const changed = before.content !== content;
      if (changed) await atomicWriteText(this.filePath, content);

      try {
        const threads = await this.reconcileThreads(content, anchorPatches, deletedThreadIds);
        this.recordControlledContent(content);
        return {
          document: payloadFor(this.filePath, content),
          threads
        };
      } catch (error) {
        if (changed) await atomicWriteText(this.filePath, before.content);
        throw error;
      }
    });
  }

  async applySelectionReplacement({
    expectedRevision,
    thread,
    replacement,
    threadId,
    agentTurn = null
  }) {
    return this.withMutation(async () => {
      const before = await this.snapshot();
      assertRevision(before, expectedRevision);
      const edit = selectionReplacement(before.content, thread, replacement);
      await atomicWriteText(this.filePath, edit.content);

      try {
        const reconcile = (currentThreads) => {
          const remapped = remapThreadsForReplacement(
            currentThreads,
            before.content,
            edit,
            threadId
          );
          return {
            patches: remapped.threads,
            deletedThreadIds: remapped.deletedThreadIds
          };
        };
        const committed = agentTurn
          ? await this.threadStore.completeAgentTurnWithAnchorReconciliation({
              ...agentTurn,
              threadId,
              reconcile
            })
          : {
              assistantMessage: null,
              threads: await this.threadStore.reconcileAnchors(reconcile)
            };
        this.recordControlledContent(edit.content);
        return {
          document: payloadFor(this.filePath, edit.content),
          edit,
          threads: committed.threads,
          assistantMessage: committed.assistantMessage
        };
      } catch (error) {
        await atomicWriteText(this.filePath, before.content);
        throw error;
      }
    });
  }

  async createAgentSnapshot() {
    await this.waitForMutations();
    const snapshot = await this.snapshot();
    return {
      document: payloadFor(this.filePath, snapshot.content),
      content: snapshot.content,
      revision: snapshot.revision,
      mutationEpoch: this.controlledState.mutationEpoch
    };
  }

  async verifyAgentSnapshot(snapshot) {
    return this.withMutation(async () => {
      const current = await this.snapshot();
      if (current.revision === snapshot.revision) return null;

      if (this.controlledState.mutationEpoch !== snapshot.mutationEpoch) {
        const controlled = this.controlledState.snapshot;
        if (controlled?.revision === current.revision) {
          return payloadFor(this.filePath, current.content);
        }
        throw new AgentDocumentMutationError(
          this.filePath,
          payloadFor(this.filePath, current.content)
        );
      }

      throw new AgentDocumentMutationError(
        this.filePath,
        payloadFor(this.filePath, current.content)
      );
    });
  }

  async withMutation(operation) {
    const previous = mutationLocks.get(this.filePath) || Promise.resolve();
    const run = previous.then(operation, operation);
    const barrier = run.catch(() => {});
    mutationLocks.set(this.filePath, barrier);
    try {
      return await run;
    } finally {
      if (mutationLocks.get(this.filePath) === barrier) {
        mutationLocks.delete(this.filePath);
      }
    }
  }

  async waitForMutations() {
    await (mutationLocks.get(this.filePath) || Promise.resolve());
  }

  async snapshot() {
    const content = await readFile(this.filePath, "utf8");
    return {
      content,
      revision: documentRevision(content)
    };
  }

  async reconcileThreads(content, anchorProposals = null, deletedThreadIds = []) {
    const deletedIds = new Set(deletedThreadIds);
    return this.threadStore.reconcileAnchors((storedThreads) => {
      const currentThreads = storedThreads.filter((thread) => !deletedIds.has(thread.id));
      const candidates = anchorProposals
        ? applyValidAnchorProposals(currentThreads, anchorProposals, content)
        : currentThreads;
      const reconciled = reconcileThreadsForContent(candidates, content);
      return {
        patches: reconciled.threads,
        deletedThreadIds: [...new Set([...deletedIds, ...reconciled.deletedThreadIds])]
      };
    });
  }

  recordControlledContent(content) {
    this.controlledState.mutationEpoch += 1;
    this.controlledState.snapshot = {
      content,
      revision: documentRevision(content),
      mutationEpoch: this.controlledState.mutationEpoch
    };
  }
}

export function documentRevision(content) {
  return createHash("sha256").update(String(content ?? "")).digest("hex");
}

function payloadFor(filePath, content) {
  return {
    path: filePath,
    title: path.basename(filePath),
    content,
    revision: documentRevision(content),
    blocks: buildBlockIndex(content)
  };
}

function normalizeSelectedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function applyValidAnchorProposals(threads, proposals, content) {
  const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  return threads.map((thread) => {
    const proposal = proposalById.get(thread.id);
    const start = proposal?.anchor?.start;
    const end = proposal?.anchor?.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) {
      return thread;
    }
    return {
      ...thread,
      selectedText: content.slice(start, end),
      anchor: {
        ...thread.anchor,
        start,
        end,
        lineStart: Number.isInteger(proposal.anchor.lineStart) ? proposal.anchor.lineStart : null,
        lineEnd: Number.isInteger(proposal.anchor.lineEnd) ? proposal.anchor.lineEnd : null,
        blockId: typeof proposal.anchor.blockId === "string" ? proposal.anchor.blockId : null,
        contextBefore: null,
        contextAfter: null
      }
    };
  });
}

function assertRevision(snapshot, expectedRevision) {
  if (typeof expectedRevision !== "string" || !expectedRevision) {
    throw new DocumentConflictError("Document revision is required. Reload the document before saving.", snapshot.revision);
  }
  if (snapshot.revision !== expectedRevision) {
    throw new DocumentConflictError("Document changed after it was loaded. Reload it before applying this update.", snapshot.revision);
  }
}

function selectionReplacement(content, thread, replacement) {
  const anchor = thread.anchor || {};
  let start = anchor.start;
  let end = anchor.end;
  const selectedText = String(thread.selectedText || "");

  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || content.slice(start, end) !== selectedText) {
    const first = selectedText ? content.indexOf(selectedText) : -1;
    const last = selectedText ? content.lastIndexOf(selectedText) : -1;
    if (first < 0 || first !== last) {
      throw new DocumentConflictError("Selected text no longer matches the document. Re-select the text and create a new comment thread.", documentRevision(content));
    }
    start = first;
    end = first + selectedText.length;
  }

  return {
    start,
    end,
    replacement,
    content: `${content.slice(0, start)}${replacement}${content.slice(end)}`
  };
}
