import type { Thread } from "./types";

export type MarkdownTextLocation = {
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
};

export type ResolvedThreadAnchor = MarkdownTextLocation & {
  recovered: boolean;
};

const MISSING_POSITION = Number.MAX_SAFE_INTEGER;

export function resolveThreadAnchor(content: string, thread: Thread): ResolvedThreadAnchor | null {
  const explicit = explicitAnchorLocation(content, thread);
  const selectedText = normalizeSearchText(thread.selectedText);
  if (explicit && contextMatches(content, explicit, thread) && (!selectedText || normalizeSearchText(content.slice(explicit.start, explicit.end)) === selectedText)) {
    return { ...explicit, recovered: false };
  }

  const located = locateTextInMarkdown(content, thread.selectedText, thread.anchor.lineStart, thread.anchor);
  if (located) {
    return { ...located, recovered: true };
  }

  return selectedText ? null : explicit ? { ...explicit, recovered: false } : null;
}

export function compareThreadsByAnchor(left: Thread, right: Thread, content?: string | null): number {
  const leftKey = threadSortKey(left, content);
  const rightKey = threadSortKey(right, content);
  return (
    leftKey.lineStart - rightKey.lineStart ||
    leftKey.start - rightKey.start ||
    leftKey.lineEnd - rightKey.lineEnd ||
    leftKey.end - rightKey.end ||
    leftKey.createdAt.localeCompare(rightKey.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export function locateTextInMarkdown(content: string, selectedText: string, lineHint: number | null, anchor?: Thread["anchor"]): MarkdownTextLocation | null {
  const needle = normalizeSearchText(selectedText);
  if (!needle) return null;

  const haystack = normalizeWithOffsets(content);
  const matches: Array<{ start: number; end: number }> = [];
  let index = haystack.text.indexOf(needle);
  while (index >= 0) {
    const start = haystack.offsets[index];
    const end = haystack.offsets[index + needle.length - 1] + 1;
    matches.push({ start, end });
    index = haystack.text.indexOf(needle, index + 1);
  }

  if (matches.length === 0) {
    return null;
  }

  const best = matches.sort((left, right) => {
    const leftLineDistance = lineHint === null ? 0 : Math.abs(lineNumberAt(content, left.start) - lineHint);
    const rightLineDistance = lineHint === null ? 0 : Math.abs(lineNumberAt(content, right.start) - lineHint);
    return leftLineDistance - rightLineDistance ||
      contextScore(content, right, anchor) - contextScore(content, left, anchor) ||
      Math.abs(left.start - (anchor?.start ?? 0)) - Math.abs(right.start - (anchor?.start ?? 0));
  })[0];

  return {
    ...best,
    lineStart: lineNumberAt(content, best.start),
    lineEnd: lineNumberAt(content, best.end)
  };
}

export function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, Math.max(offset, 0)).split(/\r?\n/).length;
}

export function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function anchorContextForRange(content: string, start: number, end: number): Pick<Thread["anchor"], "contextBefore" | "contextAfter"> {
  return {
    contextBefore: content.slice(Math.max(0, start - 32), start),
    contextAfter: content.slice(end, end + 32)
  };
}

function explicitAnchorLocation(content: string, thread: Thread): MarkdownTextLocation | null {
  const start = thread.anchor.start;
  const end = thread.anchor.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === null || end === null || end <= start || start < 0 || end > content.length) {
    return null;
  }

  return {
    start,
    end,
    lineStart: lineNumberAt(content, start),
    lineEnd: lineNumberAt(content, end)
  };
}

function contextMatches(content: string, location: Pick<MarkdownTextLocation, "start" | "end">, thread: Thread): boolean {
  const { contextBefore, contextAfter } = thread.anchor;
  if (contextBefore !== undefined && contextBefore !== null) {
    if (content.slice(Math.max(0, location.start - contextBefore.length), location.start) !== contextBefore) return false;
  }
  if (contextAfter !== undefined && contextAfter !== null) {
    if (content.slice(location.end, location.end + contextAfter.length) !== contextAfter) return false;
  }
  return true;
}

function contextScore(content: string, location: Pick<MarkdownTextLocation, "start" | "end">, anchor?: Thread["anchor"]): number {
  if (!anchor) return 0;
  let score = 0;
  if (anchor.contextBefore !== undefined && anchor.contextBefore !== null && content.slice(Math.max(0, location.start - anchor.contextBefore.length), location.start) === anchor.contextBefore) {
    score += anchor.contextBefore.length + 1;
  }
  if (anchor.contextAfter !== undefined && anchor.contextAfter !== null && content.slice(location.end, location.end + anchor.contextAfter.length) === anchor.contextAfter) {
    score += anchor.contextAfter.length + 1;
  }
  return score;
}

function threadSortKey(thread: Thread, content?: string | null) {
  const resolved = content ? resolveThreadAnchor(content, thread) : null;
  return {
    lineStart: resolved?.lineStart ?? integerOrMissing(thread.anchor.lineStart),
    start: resolved?.start ?? integerOrMissing(thread.anchor.start),
    lineEnd: resolved?.lineEnd ?? integerOrMissing(thread.anchor.lineEnd),
    end: resolved?.end ?? integerOrMissing(thread.anchor.end),
    createdAt: thread.createdAt || ""
  };
}

function integerOrMissing(value: number | null): number {
  return Number.isInteger(value) && value !== null ? value : MISSING_POSITION;
}

function normalizeWithOffsets(value: string): { text: string; offsets: number[] } {
  const text: string[] = [];
  const offsets: number[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      if (!previousWasSpace && text.length > 0) {
        text.push(" ");
        offsets.push(index);
        previousWasSpace = true;
      }
      continue;
    }
    text.push(character);
    offsets.push(index);
    previousWasSpace = false;
  }

  if (text[text.length - 1] === " ") {
    text.pop();
    offsets.pop();
  }

  return { text: text.join(""), offsets };
}
