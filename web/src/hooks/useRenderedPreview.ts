import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { renderMarkdown, renderMermaidBlocks } from "../markdown";
import {
  clearPreviewThreadAnchors,
  decoratePreviewThreadAnchors,
  updatePreviewActiveThread
} from "../thread-preview";
import type { Thread } from "../types";

type UseRenderedPreviewOptions = {
  previewRef: RefObject<HTMLElement | null>;
  content: string | null;
  threads: Thread[];
  activeThreadId: string | null;
  onActivateThread: (threadId: string | null) => void;
  onOpenDiagram: (diagram: { title: string; svg: string }) => void;
  onRendered?: () => void;
};

export function useRenderedPreview({
  previewRef,
  content,
  threads,
  activeThreadId,
  onActivateThread,
  onOpenDiagram,
  onRendered
}: UseRenderedPreviewOptions) {
  const onActivateThreadRef = useRef(onActivateThread);
  const onOpenDiagramRef = useRef(onOpenDiagram);
  const onRenderedRef = useRef(onRendered);

  useEffect(() => {
    onActivateThreadRef.current = onActivateThread;
  }, [onActivateThread]);

  useEffect(() => {
    onOpenDiagramRef.current = onOpenDiagram;
  }, [onOpenDiagram]);

  useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  useEffect(() => {
    const root = previewRef.current;
    if (!root || content === null) return;

    root.innerHTML = renderMarkdown(content);
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
      if (marker) onActivateThreadRef.current(marker.dataset.previewThreadId?.split(" ")[0] || null);
    };

    root.addEventListener("click", handleClick);
    void renderMermaidBlocks(root).finally(() => onRenderedRef.current?.());
    onRenderedRef.current?.();
    return () => root.removeEventListener("click", handleClick);
  }, [previewRef, content]);

  useEffect(() => {
    const root = previewRef.current;
    if (!root || content === null) return;
    clearPreviewThreadAnchors(root);
    decoratePreviewThreadAnchors(root, threads, content);
    updatePreviewActiveThread(root, activeThreadId);
    onRenderedRef.current?.();
  }, [previewRef, content, threads]);

  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    updatePreviewActiveThread(root, activeThreadId);
  }, [previewRef, activeThreadId]);
}
