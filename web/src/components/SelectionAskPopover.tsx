import { useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";

type ViewportRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type SelectionAskPopoverProps = {
  selectedText: string;
  anchorRect: ViewportRect | null;
  question: string;
  creating: boolean;
  onQuestionChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

const POPOVER_WIDTH = 430;
const POPOVER_ESTIMATED_HEIGHT = 245;
const VIEWPORT_MARGIN = 16;

export function SelectionAskPopover(props: SelectionAskPopoverProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
        return;
      }
      if (event.key !== "Tab" || !formRef.current) return;
      const focusable = [...formRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled)")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onCancel]);

  const style = popoverPosition(props.anchorRect);

  return createPortal(
    <div className="selectionAskLayer" role="presentation" onMouseDown={props.onCancel}>
      <form
        ref={formRef}
        className="selectionAskPopover"
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby="selection-ask-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <header>
          <div>
            <span>文档选区</span>
            <strong id="selection-ask-title">基于选中文字提问</strong>
          </div>
          <button type="button" className="ghostButton" aria-label="取消提问" onClick={props.onCancel}>×</button>
        </header>
        <blockquote title={props.selectedText}>{props.selectedText}</blockquote>
        <textarea
          ref={textareaRef}
          value={props.question}
          disabled={props.creating}
          placeholder="你想让 Codex 解释、审查或修改什么？"
          aria-label="关于选中文字的问题"
          onChange={(event) => props.onQuestionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              props.onCancel();
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <footer>
          <span>⌘/Ctrl + Enter 发送</span>
          <div>
            <button type="button" onClick={props.onCancel}>取消</button>
            <button type="submit" className="primaryButton" disabled={!props.question.trim() || props.creating}>
              {props.creating ? "正在提交…" : "询问 Codex"}
            </button>
          </div>
        </footer>
      </form>
    </div>,
    document.body
  );
}

function popoverPosition(anchorRect: ViewportRect | null): CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const halfWidth = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2) / 2;
  const anchorCenter = anchorRect ? anchorRect.left + anchorRect.width / 2 : viewportWidth / 2;
  const left = clamp(anchorCenter, VIEWPORT_MARGIN + halfWidth, viewportWidth - VIEWPORT_MARGIN - halfWidth);
  const below = anchorRect ? anchorRect.bottom + 12 : viewportHeight / 2 - POPOVER_ESTIMATED_HEIGHT / 2;
  const top = below + POPOVER_ESTIMATED_HEIGHT <= viewportHeight - VIEWPORT_MARGIN
    ? below
    : Math.max(VIEWPORT_MARGIN, (anchorRect?.top ?? viewportHeight / 2) - POPOVER_ESTIMATED_HEIGHT - 12);
  return { left, top };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
