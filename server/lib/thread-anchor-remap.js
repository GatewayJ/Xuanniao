export function remapThreadsForReplacement(threads, previousContent, edit, preservedThreadId = null) {
  const nextThreads = [];
  const deletedThreadIds = [];

  for (const thread of threads) {
    const range = threadRangeInContent(thread, previousContent);
    if (!range) {
      nextThreads.push(orphanThread(thread));
      continue;
    }

    const nextRange = mapRangeThroughReplacement(range, edit, thread.id === preservedThreadId);
    if (!nextRange) {
      nextThreads.push(orphanThread(thread));
      continue;
    }

    nextThreads.push(threadAtRange(thread, edit.content, nextRange.start, nextRange.end));
  }

  return { threads: nextThreads, deletedThreadIds };
}

export function reconcileThreadsForContent(threads, content) {
  const nextThreads = [];
  const deletedThreadIds = [];

  for (const thread of threads) {
    const range = threadRangeInContent(thread, content);
    if (!range) {
      nextThreads.push(orphanThread(thread));
      continue;
    }
    nextThreads.push(threadAtRange(thread, content, range.start, range.end));
  }

  return { threads: nextThreads, deletedThreadIds };
}

export function orphanThread(thread) {
  return { ...thread, orphaned: true, anchor: { ...thread.anchor, start: null, end: null, lineStart: null, lineEnd: null, blockId: null } };
}

function mapRangeThroughReplacement(range, edit, preserveReplacement) {
  const { start, end } = range;
  const replacementStart = edit.start;
  const replacementEnd = edit.end;
  const replacementLength = edit.replacement.length;
  const delta = replacementLength - (replacementEnd - replacementStart);

  if (replacementStart <= start && replacementEnd >= end) {
    return replacementLength === 0 || !preserveReplacement
      ? null
      : { start: replacementStart, end: replacementStart + replacementLength };
  }

  // Match the editor's inclusive start / exclusive end insertion associations.
  const mapPosition = (position, association) => {
    if (position < replacementStart) return position;
    if (position > replacementEnd) return position + delta;
    if (replacementStart === replacementEnd) return association < 0 ? replacementStart : replacementStart + replacementLength;
    if (position === replacementStart) return replacementStart;
    if (position === replacementEnd) return replacementStart + replacementLength;
    return association < 0 ? replacementStart : replacementStart + replacementLength;
  };
  const nextStart = mapPosition(start, 1);
  const nextEnd = mapPosition(end, -1);

  return nextEnd > nextStart ? { start: nextStart, end: nextEnd } : null;
}

function threadRangeInContent(thread, content) {
  if (thread.orphaned) return null;
  const anchor = thread.anchor || {};
  const selectedText = String(thread.selectedText || "");
  const start = anchor.start;
  const end = anchor.end;

  if (isValidRange(start, end, content.length) && contextMatches(content, start, end, anchor) && matchesSelectedText(content.slice(start, end), selectedText)) {
    return { start, end };
  }

  return locateTextInContent(content, selectedText, anchor.lineStart, anchor);
}

function locateTextInContent(content, selectedText, lineHint, anchor) {
  const needle = normalizeSearchText(selectedText);
  if (!needle) return null;

  const haystack = normalizeWithOffsets(content);
  const matches = [];
  let index = haystack.text.indexOf(needle);
  while (index >= 0) {
    matches.push({
      start: haystack.offsets[index],
      end: haystack.offsets[index + needle.length - 1] + 1
    });
    index = haystack.text.indexOf(needle, index + 1);
  }

  if (matches.length === 0) return null;
  return matches.sort((left, right) => {
    const leftLineDistance = lineHint === null || !Number.isInteger(lineHint) ? 0 : Math.abs(lineNumberAt(content, left.start) - lineHint);
    const rightLineDistance = lineHint === null || !Number.isInteger(lineHint) ? 0 : Math.abs(lineNumberAt(content, right.start) - lineHint);
    return leftLineDistance - rightLineDistance ||
      contextScore(content, right, anchor) - contextScore(content, left, anchor) ||
      Math.abs(left.start - (anchor?.start ?? 0)) - Math.abs(right.start - (anchor?.start ?? 0));
  })[0];
}

function threadAtRange(thread, content, start, end) {
  return {
    ...thread,
    orphaned: false,
    selectedText: content.slice(start, end),
    anchor: {
      ...thread.anchor,
      start,
      end,
      lineStart: lineNumberAt(content, start),
      lineEnd: lineNumberAt(content, end),
      ...anchorContextForRange(content, start, end)
    }
  };
}

function isValidRange(start, end, length) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= length;
}

function matchesSelectedText(content, selectedText) {
  const expected = normalizeSearchText(selectedText);
  return !expected || normalizeSearchText(content) === expected;
}

function anchorContextForRange(content, start, end) {
  return {
    contextBefore: content.slice(Math.max(0, start - 32), start),
    contextAfter: content.slice(end, end + 32)
  };
}

function contextMatches(content, start, end, anchor) {
  if (anchor.contextBefore !== undefined && anchor.contextBefore !== null) {
    if (content.slice(Math.max(0, start - anchor.contextBefore.length), start) !== anchor.contextBefore) return false;
  }
  if (anchor.contextAfter !== undefined && anchor.contextAfter !== null) {
    if (content.slice(end, end + anchor.contextAfter.length) !== anchor.contextAfter) return false;
  }
  return true;
}

function contextScore(content, range, anchor) {
  let score = 0;
  if (anchor?.contextBefore !== undefined && anchor.contextBefore !== null && content.slice(Math.max(0, range.start - anchor.contextBefore.length), range.start) === anchor.contextBefore) {
    score += anchor.contextBefore.length + 1;
  }
  if (anchor?.contextAfter !== undefined && anchor.contextAfter !== null && content.slice(range.end, range.end + anchor.contextAfter.length) === anchor.contextAfter) {
    score += anchor.contextAfter.length + 1;
  }
  return score;
}

function normalizeSearchText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeWithOffsets(value) {
  const text = [];
  const offsets = [];
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

function lineNumberAt(content, offset) {
  return content.slice(0, Math.max(offset, 0)).split(/\r?\n/).length;
}
