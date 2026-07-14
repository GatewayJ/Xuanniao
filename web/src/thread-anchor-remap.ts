import type { ChangeSet } from "@codemirror/state";
import { anchorContextForRange, normalizeSearchText, resolveThreadAnchor } from "./thread-anchors.ts";
import type { Thread } from "./types.ts";

export type ThreadAnchorRemap = {
  threads: Thread[];
  deletedThreadIds: string[];
};

export function remapThreadsForChange(
  threads: Thread[],
  previousContent: string,
  content: string,
  changes: ChangeSet,
  preservedThreadId: string | null = null
): ThreadAnchorRemap {
  let changed = false;
  const deletedThreadIds: string[] = [];
  const nextThreads: Thread[] = [];

  for (const thread of threads) {
    const remapped = remapThreadForChange(thread, previousContent, content, changes, thread.id === preservedThreadId);
    if (remapped === null) {
      changed = true;
      deletedThreadIds.push(thread.id);
      continue;
    }
    if (remapped !== thread) changed = true;
    nextThreads.push(remapped);
  }

  return {
    threads: changed ? nextThreads : threads,
    deletedThreadIds
  };
}

function remapThreadForChange(thread: Thread, previousContent: string, content: string, changes: ChangeSet, preserveReplacement: boolean): Thread | null {
  const start = thread.anchor.start;
  const end = thread.anchor.end;
  if (
    start === null ||
    end === null ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > previousContent.length ||
    !matchesSelectedText(previousContent.slice(start, end), thread.selectedText)
  ) {
    return recoverThreadAnchor(thread, content);
  }

  const replacement = replacementCoveringRange(changes, start, end);
  if (replacement) {
    if (replacement.from === replacement.to || !preserveReplacement) return null;
    return threadAtRange(thread, content, replacement.from, replacement.to);
  }

  const mappedStart = clampPosition(changes.mapPos(start, 1), content.length);
  const mappedEnd = clampPosition(changes.mapPos(end, -1), content.length);
  const nextStart = Math.min(mappedStart, mappedEnd);
  const nextEnd = Math.max(mappedStart, mappedEnd);
  if (nextEnd <= nextStart) return null;

  return threadAtRange(thread, content, nextStart, nextEnd);
}

function recoverThreadAnchor(thread: Thread, content: string): Thread | null {
  const location = resolveThreadAnchor(content, thread);
  return location ? threadAtRange(thread, content, location.start, location.end) : null;
}

function replacementCoveringRange(changes: ChangeSet, start: number, end: number): { from: number; to: number } | null {
  let replacement: { from: number; to: number } | null = null;
  changes.iterChanges((fromA, toA, fromB, toB) => {
    if (fromA <= start && toA >= end) {
      replacement = { from: fromB, to: toB };
    }
  });
  return replacement;
}

function threadAtRange(thread: Thread, content: string, start: number, end: number): Thread {
  const lineStart = lineNumberAt(content, start);
  const lineEnd = lineNumberAt(content, end);
  const selectedText = content.slice(start, end);
  if (
    start === thread.anchor.start &&
    end === thread.anchor.end &&
    lineStart === thread.anchor.lineStart &&
    lineEnd === thread.anchor.lineEnd &&
    selectedText === thread.selectedText
  ) {
    return thread;
  }

  return {
    ...thread,
    selectedText,
    anchor: {
      ...thread.anchor,
      start,
      end,
      lineStart,
      lineEnd,
      ...anchorContextForRange(content, start, end)
    }
  };
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, Math.max(offset, 0)).split(/\r?\n/).length;
}

function matchesSelectedText(content: string, selectedText: string): boolean {
  const expected = normalizeSearchText(selectedText);
  return !expected || normalizeSearchText(content) === expected;
}

function clampPosition(position: number, documentLength: number): number {
  return Math.max(0, Math.min(position, documentLength));
}
