import { findPreviewBlockForThread } from "./thread-spatial";
import type { Thread } from "./types";

export function decoratePreviewThreadAnchors(root: HTMLElement, threads: Thread[], content: string) {
  for (const thread of threads) {
    const block = findPreviewBlockForThread(root, thread, content);
    if (!block) continue;
    const threadIds = new Set((block.dataset.previewThreadId || "").split(" ").filter(Boolean));
    threadIds.add(thread.id);
    block.dataset.previewThreadId = [...threadIds].join(" ");
    block.classList.add("threadBlockMark");
  }
}

export function clearPreviewThreadAnchors(root: HTMLElement) {
  for (const marker of root.querySelectorAll<HTMLElement>("[data-preview-thread-id]")) {
    delete marker.dataset.previewThreadId;
    marker.classList.remove("threadBlockMark", "active");
  }
}

export function updatePreviewActiveThread(root: HTMLElement, activeThreadId: string | null) {
  for (const marker of root.querySelectorAll<HTMLElement>("[data-preview-thread-id]")) {
    const threadIds = (marker.dataset.previewThreadId || "").split(" ");
    marker.classList.toggle("active", Boolean(activeThreadId && threadIds.includes(activeThreadId)));
  }
}
