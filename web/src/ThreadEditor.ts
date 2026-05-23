import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SelectionContext, Thread, ThreadSpatialLayout } from "./types";

type ChangeListener = (update: ViewUpdate) => void;
type ScrollListener = (view: EditorView) => void;
type ThreadActivateListener = (thread: Thread) => void;

const updateThreadsEffect = StateEffect.define<Thread[]>();
const activeThreadEffect = StateEffect.define<string | null>();

const threadDecorationField = StateField.define<{ threads: Thread[]; activeId: string | null; decorations: DecorationSet }>({
  create() {
    return { threads: [], activeId: null, decorations: Decoration.none };
  },
  update(value, transaction) {
    let threads = value.threads;
    let activeId = value.activeId;
    for (const effect of transaction.effects) {
      if (effect.is(updateThreadsEffect)) threads = effect.value;
      if (effect.is(activeThreadEffect)) activeId = effect.value;
    }
    if (transaction.docChanged || threads !== value.threads || activeId !== value.activeId) {
      return { threads, activeId, decorations: buildDecorations(transaction.state, threads, activeId) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

export class MarkdownThreadEditor {
  private view: EditorView;
  private readonly scrollListener: () => void;
  private suppressNextChange = false;
  private threads: Thread[] = [];

  constructor(parent: HTMLElement, content: string, onChange: ChangeListener, onScroll: ScrollListener, onThreadActivate?: ThreadActivateListener) {
    const owner = this;
    const changePlugin = ViewPlugin.fromClass(class {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (owner.suppressNextChange) {
          owner.suppressNextChange = false;
          return;
        }
        onChange(update);
      }
    });
    const threadClickPlugin = EditorView.domEventHandlers({
      click: (event) => {
        const thread = this.threadAtPointer(event);
        if (!thread) return false;
        onThreadActivate?.(thread);
        return true;
      }
    });
    this.scrollListener = () => onScroll(this.view);

    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          threadDecorationField,
          changePlugin,
          threadClickPlugin,
          EditorView.lineWrapping,
          editorTheme
        ]
      })
    });
    this.view.scrollDOM.addEventListener("scroll", this.scrollListener);
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.scrollListener);
    this.view.destroy();
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  setContent(content: string) {
    if (this.getContent() === content) return;
    this.suppressNextChange = true;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: content } });
  }

  getSelection(): SelectionContext {
    const range = this.view.state.selection.main;
    const selectedText = this.view.state.doc.sliceString(range.from, range.to);
    return {
      selectedText,
      anchor: {
        start: range.from,
        end: range.to,
        lineStart: this.view.state.doc.lineAt(range.from).number,
        lineEnd: this.view.state.doc.lineAt(range.to).number,
        blockId: null
      }
    };
  }

  focusThread(thread: Thread) {
    const start = thread.anchor.start ?? 0;
    const end = thread.anchor.end ?? start;
    this.view.dispatch({
      selection: EditorSelection.range(start, end),
      effects: activeThreadEffect.of(thread.id),
      scrollIntoView: true
    });
    this.view.focus();
  }

  focusLine(lineNumber: number) {
    const line = this.view.state.doc.line(Math.max(1, Math.min(lineNumber, this.view.state.doc.lines)));
    this.view.dispatch({
      selection: EditorSelection.cursor(line.from),
      scrollIntoView: true
    });
    this.view.focus();
  }

  setScrollTop(scrollTop: number) {
    this.view.scrollDOM.scrollTop = Math.max(0, scrollTop);
  }

  setThreads(threads: Thread[], activeId: string | null) {
    this.threads = threads;
    this.view.dispatch({ effects: [updateThreadsEffect.of(threads), activeThreadEffect.of(activeId)] });
  }

  threadSpatialLayout(threads: Thread[]): ThreadSpatialLayout {
    const positions: ThreadSpatialLayout["positions"] = {};
    for (const thread of threads) {
      const top = this.topForThread(thread);
      if (top === null) continue;
      positions[thread.id] = {
        threadId: thread.id,
        line: thread.anchor.lineStart,
        top
      };
    }

    return {
      contentHeight: Math.max(this.view.scrollDOM.scrollHeight, this.view.scrollDOM.clientHeight),
      viewportHeight: this.view.scrollDOM.clientHeight,
      scrollTop: this.view.scrollDOM.scrollTop,
      positions
    };
  }

  nearestThreadForViewport(threads: Thread[]): Thread | null {
    const pos = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop + this.view.scrollDOM.clientHeight * 0.28).from;
    const line = this.view.state.doc.lineAt(pos).number;
    return nearestThreadForLine(threads, line);
  }

  private topForThread(thread: Thread): number | null {
    const pos = Number.isInteger(thread.anchor.start) && thread.anchor.start !== null
      ? thread.anchor.start
      : this.positionForLine(thread.anchor.lineStart);
    if (pos === null) return null;
    return Math.max(0, this.view.lineBlockAt(pos).top);
  }

  private positionForLine(lineNumber: number | null): number | null {
    if (!Number.isInteger(lineNumber) || lineNumber === null) return null;
    const line = this.view.state.doc.line(Math.max(1, Math.min(lineNumber, this.view.state.doc.lines)));
    return line.from;
  }

  private threadAtPointer(event: MouseEvent): Thread | null {
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return null;
    return threadAtPosition(this.threads, pos);
  }
}

export function nearestThreadForLine(threads: Thread[], line: number): Thread | null {
  const ordered = [...threads]
    .filter((thread) => Number.isInteger(thread.anchor.lineStart))
    .sort((left, right) => (left.anchor.lineStart || 0) - (right.anchor.lineStart || 0));
  if (ordered.length === 0) return null;
  let candidate = ordered[0];
  for (const thread of ordered) {
    if ((thread.anchor.lineStart || 0) <= line) candidate = thread;
    else break;
  }
  return candidate;
}

function buildDecorations(state: EditorState, threads: Thread[], activeId: string | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const thread of [...threads].sort((a, b) => (a.anchor.start || 0) - (b.anchor.start || 0))) {
    const from = thread.anchor.start;
    const to = thread.anchor.end;
    if (from === null || to === null || !Number.isInteger(from) || !Number.isInteger(to) || to <= from || from < 0 || to > state.doc.length) continue;
    builder.add(from, to, Decoration.mark({
      class: thread.id === activeId ? "cm-threadMark cm-threadMark-active" : "cm-threadMark"
    }));
  }
  return builder.finish();
}

function threadAtPosition(threads: Thread[], pos: number): Thread | null {
  return threads
    .filter((thread) => {
      const from = thread.anchor.start;
      const to = thread.anchor.end;
      return Number.isInteger(from) && Number.isInteger(to) && from !== null && to !== null && pos >= from && pos <= to;
    })
    .sort((left, right) => {
      const leftSpan = (left.anchor.end || 0) - (left.anchor.start || 0);
      const rightSpan = (right.anchor.end || 0) - (right.anchor.start || 0);
      return leftSpan - rightSpan;
    })[0] || null;
}

const editorTheme: Extension = EditorView.theme({
  "&": { height: "100%", fontSize: "14px" },
  ".cm-scroller": {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    lineHeight: "1.55",
    overscrollBehavior: "contain",
    overflow: "auto"
  },
  ".cm-content": { padding: "18px 20px 80px" },
  ".cm-focused": { outline: "none" },
  ".cm-threadMark": {
    backgroundColor: "#fff8df",
    borderBottom: "2px solid #f6c343",
    borderRadius: "3px",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
    cursor: "pointer",
    padding: "0 2px"
  },
  ".cm-threadMark-active": {
    backgroundColor: "#ffe9a6",
    boxShadow: "0 0 0 1px #f6c343"
  }
});
