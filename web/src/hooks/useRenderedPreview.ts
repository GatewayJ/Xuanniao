import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { renderMarkdown, renderMermaidBlocks } from "../markdown";
import type { Thread } from "../types";

type UseRenderedPreviewOptions = {
  previewRef: RefObject<HTMLElement | null>;
  content: string | null;
  threads: Thread[];
  activeThreadId: string | null;
  onActivateThread: (threadId: string | null) => void;
  onOpenDiagram: (diagram: { title: string; svg: string }) => void;
};

export function useRenderedPreview({
  previewRef,
  content,
  threads,
  activeThreadId,
  onActivateThread,
  onOpenDiagram
}: UseRenderedPreviewOptions) {
  const onActivateThreadRef = useRef(onActivateThread);
  const onOpenDiagramRef = useRef(onOpenDiagram);

  useEffect(() => {
    onActivateThreadRef.current = onActivateThread;
  }, [onActivateThread]);

  useEffect(() => {
    onOpenDiagramRef.current = onOpenDiagram;
  }, [onOpenDiagram]);

  useEffect(() => {
    const root = previewRef.current;
    if (!root || content === null) return;

    root.innerHTML = renderMarkdown(content, threads, activeThreadId);
    decoratePreviewThreadAnchors(root, threads, activeThreadId);
    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const diagramButton = target?.closest<HTMLElement>("[data-diagram-action='open']");
      if (diagramButton) {
        event.preventDefault();
        event.stopPropagation();
        const block = diagramButton.closest<HTMLElement>(".mermaidBlock");
        const svg = block?.querySelector<SVGSVGElement>("svg");
        if (svg) {
          onOpenDiagramRef.current({
            title: `Mermaid diagram${block?.dataset.sourceLine ? ` · line ${block.dataset.sourceLine}` : ""}`,
            svg: svg.outerHTML
          });
        }
        return;
      }
      const marker = target?.closest<HTMLElement>("[data-preview-thread-id]");
      if (marker) onActivateThreadRef.current(marker.dataset.previewThreadId || null);
    };

    root.addEventListener("click", handleClick);
    void renderMermaidBlocks(root);
    return () => root.removeEventListener("click", handleClick);
  }, [previewRef, content, threads, activeThreadId]);
}

function decoratePreviewThreadAnchors(root: HTMLElement, threads: Thread[], activeThreadId: string | null) {
  for (const thread of threads) {
    const block = findPreviewBlockForThread(root, thread);
    if (!block) continue;
    if (block.dataset.previewThreadId && block.dataset.previewThreadId !== thread.id) continue;
    block.dataset.previewThreadId = thread.id;
    block.classList.add("threadBlockMark");
    if (thread.id === activeThreadId) block.classList.add("active");
  }
}

function findPreviewBlockForThread(root: HTMLElement, thread: Thread): HTMLElement | null {
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
