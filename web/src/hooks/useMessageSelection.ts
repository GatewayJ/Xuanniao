import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";

import type { BranchSelection } from "../types";

export type MessageSelectionPopover = BranchSelection & {
  left: number;
  top: number;
  highlightRects: Array<{ left: number; top: number; width: number; height: number }>;
  prompt: string;
};

type MessageSelectionOptions = {
  inspectorRef: { current: HTMLElement | null };
  canvasScaleRef: { current: { scale: number } };
  selectedNodeId: string | null;
};

export function useMessageSelection({
  inspectorRef,
  canvasScaleRef,
  selectedNodeId
}: MessageSelectionOptions) {
  const selectionComposerRef = useRef<HTMLInputElement | null>(null);
  const selectingMessageRef = useRef<HTMLElement | null>(null);
  const lastValidSelectionRangeRef = useRef<Range | null>(null);
  const capturedSelectionRangeRef = useRef<Range | null>(null);
  const selectionCaptureFrameRef = useRef<number | null>(null);
  const captureSelectionRef = useRef<() => void>(() => undefined);
  const selectionActiveRef = useRef(false);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const [selectionPopover, setSelectionPopover] = useState<MessageSelectionPopover | null>(null);
  selectedNodeIdRef.current = selectedNodeId;

  useEffect(() => {
    function keepSelectionInsideMessage(event: PointerEvent) {
      if (!selectionActiveRef.current || !(event.buttons & 1)) return;
      const selection = window.getSelection();
      const messageContent = selectingMessageRef.current;
      if (!selection || selection.rangeCount === 0 || !messageContent) return;

      if (!selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        const startContent = selectionElement(range.startContainer)?.closest(".messageContent");
        const endContent = selectionElement(range.endContainer)?.closest(".messageContent");
        if (startContent === messageContent && endContent === messageContent) {
          lastValidSelectionRangeRef.current = range.cloneRange();
        }
      }

      const rect = messageContent.getBoundingClientRect();
      const insideMessage =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (insideMessage) return;

      event.preventDefault();
      const lastValidRange = lastValidSelectionRangeRef.current;
      if (lastValidRange) {
        selection.removeAllRanges();
        selection.addRange(lastValidRange);
      }
    }

    function finishSelection() {
      if (!selectionActiveRef.current) return;
      selectionActiveRef.current = false;
      captureSelectionRef.current();
      selectingMessageRef.current = null;
      lastValidSelectionRangeRef.current = null;
    }

    function cancelSelection() {
      selectionActiveRef.current = false;
      selectingMessageRef.current = null;
      lastValidSelectionRangeRef.current = null;
    }

    window.addEventListener("pointermove", keepSelectionInsideMessage, { passive: false });
    window.addEventListener("pointerup", finishSelection);
    window.addEventListener("pointercancel", cancelSelection);
    window.addEventListener("blur", finishSelection);
    return () => {
      window.removeEventListener("pointermove", keepSelectionInsideMessage);
      window.removeEventListener("pointerup", finishSelection);
      window.removeEventListener("pointercancel", cancelSelection);
      window.removeEventListener("blur", finishSelection);
      cancelPendingCapture();
    };
  }, []);

  useLayoutEffect(() => {
    const range = capturedSelectionRangeRef.current;
    if (
      !selectionPopover ||
      !range ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected
    ) return;
    if (selectionComposerRef.current?.contains(document.activeElement)) return;

    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }, [selectionPopover?.sourceMessageId, selectionPopover?.text]);

  function captureSelection() {
    const selection = window.getSelection();
    const inspector = inspectorRef.current;
    const nodeId = selectedNodeIdRef.current;
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !inspector ||
      !nodeId
    ) {
      clearSelection();
      return;
    }

    const range = selection.getRangeAt(0).cloneRange();
    const startContent = selectionElement(range.startContainer)?.closest(".messageContent");
    const endContent = selectionElement(range.endContainer)?.closest(".messageContent");
    const messageElement = startContent?.closest<HTMLElement>("[data-thread-message-id]");
    if (
      !startContent ||
      startContent !== endContent ||
      !messageElement ||
      !inspector.contains(messageElement)
    ) {
      clearSelection();
      return;
    }

    const text = normalizeSelectedText(range.toString());
    const sourceMessageId = messageElement.dataset.threadMessageId || "";
    if (!text || !sourceMessageId) {
      clearSelection();
      return;
    }

    cancelPendingCapture();
    capturedSelectionRangeRef.current = range;
    selectionCaptureFrameRef.current = window.requestAnimationFrame(() => {
      selectionCaptureFrameRef.current = null;
      const currentInspector = inspectorRef.current;
      if (
        capturedSelectionRangeRef.current !== range ||
        !currentInspector ||
        !range.startContainer.isConnected ||
        !range.endContainer.isConnected ||
        !currentInspector.contains(messageElement)
      ) return;

      const selectionRect = range.getBoundingClientRect();
      const inspectorRect = currentInspector.getBoundingClientRect();
      const focusScale = canvasScaleRef.current.scale;
      const inspectorWidth = inspectorRect.width / focusScale;
      const inspectorHeight = inspectorRect.height / focusScale;
      const preferredTop = (selectionRect.bottom - inspectorRect.top) / focusScale + 8;
      const highlightRects = Array.from(range.getClientRects()).flatMap((rect) => {
        const left = clamp((rect.left - inspectorRect.left) / focusScale, 0, inspectorWidth);
        const right = clamp((rect.right - inspectorRect.left) / focusScale, 0, inspectorWidth);
        const top = clamp((rect.top - inspectorRect.top) / focusScale, 0, inspectorHeight);
        const bottom = clamp((rect.bottom - inspectorRect.top) / focusScale, 0, inspectorHeight);
        return right > left && bottom > top
          ? [{ left, top, width: right - left, height: bottom - top }]
          : [];
      });
      setSelectionPopover({
        sourceMessageId,
        text,
        left: clamp(
          (selectionRect.left - inspectorRect.left + selectionRect.width / 2) / focusScale,
          190,
          inspectorWidth - 190
        ),
        top: clamp(preferredTop, 58, inspectorHeight - 112),
        highlightRects,
        prompt: ""
      });
    });
  }

  captureSelectionRef.current = captureSelection;

  function beginSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const messageContent = (event.target as HTMLElement).closest<HTMLElement>(".messageContent");
    if (!messageContent) return;
    selectionActiveRef.current = true;
    selectingMessageRef.current = messageContent;
    lastValidSelectionRangeRef.current = null;
    clearSelection();
  }

  function clearSelection() {
    cancelPendingCapture();
    capturedSelectionRangeRef.current = null;
    setSelectionPopover(null);
  }

  function cancelPendingCapture() {
    if (selectionCaptureFrameRef.current === null) return;
    window.cancelAnimationFrame(selectionCaptureFrameRef.current);
    selectionCaptureFrameRef.current = null;
  }

  return {
    selectionPopover,
    setSelectionPopover,
    selectionComposerRef,
    beginMessageSelection: beginSelection,
    captureMessageSelection: captureSelection,
    clearCapturedMessageSelection: clearSelection
  };
}

export function normalizeSelectedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2000);
}

function selectionElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
