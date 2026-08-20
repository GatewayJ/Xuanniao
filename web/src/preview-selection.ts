import {
  anchorContextForRange,
  canonicalizeSelection,
  lineNumberAt,
  locateUniqueTextInMarkdown,
  normalizeSearchText
} from "./thread-anchors";
import type { SelectionContext } from "./types";

type SourceElement = HTMLElement & {
  dataset: DOMStringMap & {
    sourceStart?: string;
    sourceEnd?: string;
  };
};

export function selectionContextForPreview(
  root: HTMLElement,
  range: Range,
  content: string
): SelectionContext | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const renderedSelection = normalizeSearchText(range.toString());
  if (!renderedSelection) return null;

  const mapped = mapPreviewRangeToSource(root, range, content);
  if (mapped) {
    return canonicalizeSelection(content, selectionAtRange(content, mapped.start, mapped.end));
  }

  const lineHint = sourceLineForNode(range.startContainer);
  const located = locateUniqueTextInMarkdown(content, renderedSelection, lineHint);
  return located ? selectionAtRange(content, located.start, located.end) : null;
}

export function alignRenderedTextToSource(renderedText: string, sourceText: string): Array<number | null> | null {
  const boundaries: Array<number | null> = Array(renderedText.length + 1).fill(null);
  let sourceCursor = sourceContentStart(sourceText);
  boundaries[0] = sourceCursor;

  for (let renderedIndex = 0; renderedIndex < renderedText.length; renderedIndex += 1) {
    const match = nextSourceMatch(sourceText, sourceCursor, renderedText[renderedIndex]);
    if (!match) return null;
    boundaries[renderedIndex] = match.start;
    boundaries[renderedIndex + 1] = match.end;
    sourceCursor = match.end;
  }

  return boundaries;
}

function mapPreviewRangeToSource(
  root: HTMLElement,
  range: Range,
  content: string
): { start: number; end: number } | null {
  const start = mapPreviewBoundary(root, range.startContainer, range.startOffset, content);
  const end = mapPreviewBoundary(root, range.endContainer, range.endOffset, content);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

function mapPreviewBoundary(
  root: HTMLElement,
  node: Node,
  offset: number,
  content: string
): number | null {
  const element = sourceElementForNode(root, node);
  if (!element) return null;
  const start = sourceStart(element);
  const end = sourceEnd(element);
  if (start === null || end === null || end <= start || end > content.length) return null;

  const renderedOffset = renderedOffsetWithin(element, node, offset);
  if (renderedOffset === null) return null;
  const boundaries = alignRenderedTextToSource(element.textContent || "", content.slice(start, end));
  const sourceOffset = boundaries?.[renderedOffset];
  return typeof sourceOffset === "number" ? start + sourceOffset : null;
}

function sourceElementForNode(root: HTMLElement, node: Node): SourceElement | null {
  const element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
  const sourceElement = element?.closest<SourceElement>("[data-source-start][data-source-end]") || null;
  return sourceElement && root.contains(sourceElement) ? sourceElement : null;
}

function renderedOffsetWithin(element: HTMLElement, node: Node, offset: number): number | null {
  try {
    const prefix = element.ownerDocument.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(node, offset);
    return prefix.toString().length;
  } catch {
    return null;
  }
}

function nextSourceMatch(
  source: string,
  cursor: number,
  renderedCharacter: string
): { start: number; end: number } | null {
  const candidates = sourceCandidates(renderedCharacter);
  let best: { start: number; end: number } | null = null;
  for (const candidate of candidates) {
    const start = source.indexOf(candidate, cursor);
    if (start < 0 || (best && start >= best.start)) continue;
    best = { start, end: start + candidate.length };
  }
  return best;
}

function sourceCandidates(renderedCharacter: string): string[] {
  const transformed: Record<string, string[]> = {
    "“": ["\"", "“"],
    "”": ["\"", "”"],
    "‘": ["'", "‘"],
    "’": ["'", "’"],
    "…": ["...", "…"],
    "–": ["--", "–"],
    "—": ["---", "—"],
    "©": ["(c)", "(C)", "©"],
    "®": ["(r)", "(R)", "®"],
    "™": ["(tm)", "(TM)", "™"],
    "±": ["+-", "±"],
    "&": ["&amp;", "&"],
    "<": ["&lt;", "<"],
    ">": ["&gt;", ">"],
    "\"": ["&quot;", "\""]
  };
  return transformed[renderedCharacter] || [renderedCharacter];
}

function sourceContentStart(source: string): number {
  const marker = source.match(/^(?: {0,3}(?:>{1,3}|#{1,6}|[-+*]|\d+[.)])\s+)+/);
  return marker?.[0].length || 0;
}

function sourceStart(element: SourceElement): number | null {
  const value = Number(element.dataset.sourceStart);
  return Number.isInteger(value) ? value : null;
}

function sourceEnd(element: SourceElement): number | null {
  const value = Number(element.dataset.sourceEnd);
  return Number.isInteger(value) ? value : null;
}

function sourceLineForNode(node: Node): number | null {
  const element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
  const line = Number(element?.closest<HTMLElement>("[data-source-line]")?.dataset.sourceLine);
  return Number.isInteger(line) ? line : null;
}

function selectionAtRange(content: string, start: number, end: number): SelectionContext {
  return {
    selectedText: content.slice(start, end),
    anchor: {
      start,
      end,
      lineStart: lineNumberAt(content, start),
      lineEnd: lineNumberAt(content, end),
      blockId: null,
      ...anchorContextForRange(content, start, end)
    }
  };
}
