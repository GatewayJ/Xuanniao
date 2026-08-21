import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText } from "./atomic-file.js";
import { buildBlockIndex } from "./block-index.js";
import { reconcileThreadsForContent, remapThreadsForReplacement } from "./thread-anchor-remap.js";

const mutationLocks = new Map();
const agentTurnLocks = new Map();
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
        if (changed) this.recordControlledContent(content);
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

  async completeAgentTurnFromSnapshot({
    snapshot,
    threadId,
    userMessageId,
    message,
    agentSession,
    expectedBranchRevision
  }) {
    return this.withMutation(async () => {
      const current = await this.snapshot();
      const changed = current.revision !== snapshot.revision;
      if (changed && this.controlledState.mutationEpoch !== snapshot.mutationEpoch) {
        throw new AgentDocumentMutationError(
          this.filePath,
          payloadFor(this.filePath, current.content)
        );
      }
      const completedMessage = {
        ...message,
        meta: {
          ...(message.meta || {}),
          appliedEdit: changed
        }
      };

      if (!changed) {
        const assistantMessage = await this.threadStore.completeAgentTurn(
          threadId,
          userMessageId,
          completedMessage,
          agentSession,
          expectedBranchRevision
        );
        return {
          assistantMessage,
          document: null,
          threads: null,
          changed: false
        };
      }

      const edits = documentEditsBetween(snapshot.content, current.content);
      const reconcile = (currentThreads) => {
        const remapped = remapThreadsForDocumentEdits(
          currentThreads,
          snapshot.content,
          edits,
          threadId
        );
        return {
          patches: remapped.threads,
          deletedThreadIds: remapped.deletedThreadIds
        };
      };
      const committed = await this.threadStore.completeAgentTurnWithAnchorReconciliation({
        threadId,
        userMessageId,
        message: completedMessage,
        agentSession,
        expectedBranchRevision,
        reconcile
      });
      this.recordControlledContent(current.content);
      return {
        assistantMessage: committed.assistantMessage,
        document: payloadFor(this.filePath, current.content),
        threads: committed.threads,
        changed: true
      };
    });
  }

  async createAgentSnapshot() {
    return this.withMutation(async () => {
      const snapshot = await this.snapshot();
      return {
        document: payloadFor(this.filePath, snapshot.content),
        content: snapshot.content,
        revision: snapshot.revision,
        mutationEpoch: this.controlledState.mutationEpoch
      };
    });
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
    return runWithFileLock(mutationLocks, this.filePath, operation);
  }

  async withAgentTurn(operation) {
    return runWithFileLock(agentTurnLocks, this.filePath, operation);
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

async function runWithFileLock(locks, filePath, operation) {
  const previous = locks.get(filePath) || Promise.resolve();
  const run = previous.then(operation, operation);
  const barrier = run.catch(() => {});
  locks.set(filePath, barrier);
  try {
    return await run;
  } finally {
    if (locks.get(filePath) === barrier) locks.delete(filePath);
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

function remapThreadsForDocumentEdits(threads, content, edits, preservedThreadId) {
  let currentThreads = threads;
  let currentContent = content;
  const deletedThreadIds = [];

  for (const proposed of [...edits].reverse()) {
    const nextContent = `${currentContent.slice(0, proposed.start)}${proposed.newText}${currentContent.slice(proposed.end)}`;
    const remapped = remapThreadsForReplacement(
      currentThreads,
      currentContent,
      {
        start: proposed.start,
        end: proposed.end,
        replacement: proposed.newText,
        content: nextContent
      },
      preservedThreadId
    );
    currentThreads = remapped.threads;
    deletedThreadIds.push(...remapped.deletedThreadIds);
    currentContent = nextContent;
  }

  return {
    threads: currentThreads,
    deletedThreadIds: [...new Set(deletedThreadIds)]
  };
}

function documentEditsBetween(previousContent, currentContent) {
  if (previousContent === currentContent) return [];

  // Unique token anchors plus an increasing subsequence split distant edits
  // without a quadratic character-by-character diff over large documents.
  const previousTokens = tokenizeWithOffsets(previousContent);
  const currentTokens = tokenizeWithOffsets(currentContent);
  const anchors = orderedUniqueTokenAnchors(previousTokens, currentTokens);
  const edits = [];
  let previousOffset = 0;
  let currentOffset = 0;

  for (const anchor of anchors) {
    appendTrimmedEdit(
      edits,
      previousContent,
      currentContent,
      previousOffset,
      anchor.previous.start,
      currentOffset,
      anchor.current.start
    );
    previousOffset = anchor.previous.end;
    currentOffset = anchor.current.end;
  }

  appendTrimmedEdit(
    edits,
    previousContent,
    currentContent,
    previousOffset,
    previousContent.length,
    currentOffset,
    currentContent.length
  );
  return edits;
}

function tokenizeWithOffsets(content) {
  const tokens = [];
  const pattern = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (!match[0].trim()) continue;
    tokens.push({ text: match[0], start: match.index, end: pattern.lastIndex });
  }
  return tokens;
}

function orderedUniqueTokenAnchors(previousTokens, currentTokens) {
  const previousOccurrences = tokenOccurrences(previousTokens);
  const currentOccurrences = tokenOccurrences(currentTokens);
  const pairs = [];

  for (const [text, previousIndexes] of previousOccurrences) {
    const currentIndexes = currentOccurrences.get(text);
    if (previousIndexes.length !== 1 || currentIndexes?.length !== 1) continue;
    pairs.push({
      previousIndex: previousIndexes[0],
      currentIndex: currentIndexes[0]
    });
  }
  pairs.sort((left, right) => left.previousIndex - right.previousIndex);

  return longestIncreasingPairs(pairs).map((pair) => ({
    previous: previousTokens[pair.previousIndex],
    current: currentTokens[pair.currentIndex]
  }));
}

function tokenOccurrences(tokens) {
  const occurrences = new Map();
  tokens.forEach((token, index) => {
    const indexes = occurrences.get(token.text) || [];
    indexes.push(index);
    occurrences.set(token.text, indexes);
  });
  return occurrences;
}

function longestIncreasingPairs(pairs) {
  if (pairs.length === 0) return [];
  const tails = [];
  const predecessors = new Array(pairs.length).fill(-1);

  for (let index = 0; index < pairs.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pairs[tails[middle]].currentIndex < pairs[index].currentIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors[index] = tails[low - 1];
    tails[low] = index;
  }

  const result = [];
  let cursor = tails[tails.length - 1];
  while (cursor >= 0) {
    result.push(pairs[cursor]);
    cursor = predecessors[cursor];
  }
  return result.reverse();
}

function appendTrimmedEdit(
  edits,
  previousContent,
  currentContent,
  previousStart,
  previousEnd,
  currentStart,
  currentEnd
) {
  const previous = previousContent.slice(previousStart, previousEnd);
  const current = currentContent.slice(currentStart, currentEnd);
  if (previous === current) return;

  let prefixLength = 0;
  const sharedLength = Math.min(previous.length, current.length);
  while (prefixLength < sharedLength && previous[prefixLength] === current[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength &&
    previous[previous.length - suffixLength - 1] === current[current.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  edits.push({
    start: previousStart + prefixLength,
    end: previousEnd - suffixLength,
    newText: current.slice(prefixLength, current.length - suffixLength)
  });
}
