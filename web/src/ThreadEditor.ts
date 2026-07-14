import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { anchorContextForRange, compareThreadsByAnchor, resolveThreadAnchor } from "./thread-anchors";
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
        blockId: null,
        ...anchorContextForRange(this.view.state.doc.toString(), range.from, range.to)
      }
    };
  }

  focusThread(thread: Thread) {
    const location = resolveThreadAnchor(this.view.state.doc.toString(), thread);
    const start = location?.start ?? this.positionForLine(thread.anchor.lineStart) ?? 0;
    const end = location?.end ?? start;
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
    const content = this.view.state.doc.toString();
    for (const thread of threads) {
      const location = resolveThreadAnchor(content, thread);
      const top = this.topForThread(thread);
      if (top === null) continue;
      positions[thread.id] = {
        threadId: thread.id,
        line: location?.lineStart ?? thread.anchor.lineStart,
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
    return nearestThreadForLine(threads, line, this.view.state.doc.toString());
  }

  private topForThread(thread: Thread): number | null {
    const location = resolveThreadAnchor(this.view.state.doc.toString(), thread);
    const pos = location?.start ?? this.positionForLine(thread.anchor.lineStart);
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
    return threadAtPosition(this.threads, pos, this.view.state.doc.toString());
  }
}

export function nearestThreadForLine(threads: Thread[], line: number, content?: string | null): Thread | null {
  const ordered = [...threads]
    .map((thread) => ({ thread, lineStart: content ? resolveThreadAnchor(content, thread)?.lineStart ?? thread.anchor.lineStart : thread.anchor.lineStart }))
    .filter((item): item is { thread: Thread; lineStart: number } => Number.isInteger(item.lineStart))
    .sort((left, right) => compareThreadsByAnchor(left.thread, right.thread, content));
  if (ordered.length === 0) return null;
  let candidate = ordered[0].thread;
  for (const item of ordered) {
    if (item.lineStart <= line) candidate = item.thread;
    else break;
  }
  return candidate;
}

function buildDecorations(state: EditorState, threads: Thread[], activeId: string | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const content = state.doc.toString();
  const ranges = threads
    .map((thread) => ({ thread, location: resolveThreadAnchor(content, thread) }))
    .filter((item): item is { thread: Thread; location: NonNullable<ReturnType<typeof resolveThreadAnchor>> } => item.location !== null)
    .sort((left, right) => left.location.start - right.location.start || left.location.end - right.location.end);

  for (const { thread, location } of ranges) {
    builder.add(location.start, location.end, Decoration.mark({
      class: thread.id === activeId ? "cm-threadMark cm-threadMark-active" : "cm-threadMark"
    }));
  }
  return builder.finish();
}

function threadAtPosition(threads: Thread[], pos: number, content: string): Thread | null {
  return threads
    .map((thread) => ({ thread, location: resolveThreadAnchor(content, thread) }))
    .filter((item): item is { thread: Thread; location: NonNullable<ReturnType<typeof resolveThreadAnchor>> } => (
      item.location !== null && pos >= item.location.start && pos <= item.location.end
    ))
    .sort((left, right) => {
      const leftSpan = left.location.end - left.location.start;
      const rightSpan = right.location.end - right.location.start;
      return leftSpan - rightSpan;
    })[0]?.thread || null;
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
