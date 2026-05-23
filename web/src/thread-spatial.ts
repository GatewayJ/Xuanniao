import type { Thread, ThreadSpatialLayout } from "./types";

export function buildPreviewThreadLayout(root: HTMLElement | null, threads: Thread[]): ThreadSpatialLayout | null {
  if (!root) return null;

  const positions: ThreadSpatialLayout["positions"] = {};
  for (const thread of threads) {
    const block = findPreviewBlockForThread(root, thread);
    if (!block) continue;
    positions[thread.id] = {
      threadId: thread.id,
      line: thread.anchor.lineStart,
      top: Math.max(0, block.offsetTop)
    };
  }

  return {
    contentHeight: Math.max(root.scrollHeight, root.clientHeight),
    viewportHeight: root.clientHeight,
    scrollTop: root.scrollTop,
    positions
  };
}

export function findPreviewBlockForThread(root: HTMLElement, thread: Thread): HTMLElement | null {
  const lineStart = thread.anchor.lineStart;
  if (!Number.isInteger(lineStart)) return null;

  const blocks = [...root.querySelectorAll<HTMLElement>("[data-source-line]")]
    .sort((left, right) => Number(left.dataset.sourceLine || 0) - Number(right.dataset.sourceLine || 0));

  let candidate: HTMLElement | null = null;
  for (const block of blocks) {
    const blockLine = Number(block.dataset.sourceLine || 0);
    if (blockLine === lineStart) return block;
    if (blockLine <= (lineStart || 0)) candidate = block;
    else break;
  }
  return candidate;
}
