import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defaultThreadPaneWidths, promptForNodeQuickAction, threadDetailEscapeTarget, ThreadDetailModal } from "./ThreadRail";
import type { Thread } from "../types";

const at = "2026-08-27T00:00:00.000Z";

test("thread detail opens with the root conversation node selected", () => {
  const thread: Thread = {
    id: "thread-1",
    title: "Test thread",
    selectedText: "Selected source",
    anchor: {
      start: 0,
      end: 15,
      lineStart: 1,
      lineEnd: 1,
      blockId: null
    },
    messages: [
      { id: "root", role: "user", content: "Root question", nodeId: "root", parentId: null, meta: { nodeKind: "task" }, createdAt: at },
      { id: "answer", role: "assistant", content: "Root answer", nodeId: "root", parentId: "root", createdAt: at },
      { id: "child", role: "user", content: "Child question", nodeId: "child", parentId: "root", createdAt: at }
    ],
    createdAt: at,
    updatedAt: at
  };

  const html = renderToStaticMarkup(
    <ThreadDetailModal
      documentData={{
        path: "/workspace/README.md",
        title: "README.md",
        content: "# Readme\n",
        revision: "revision-1",
        blocks: []
      }}
      agentSettings={null}
      thread={thread}
      permissionRequests={[]}
      resolvingPermissionIds={new Set()}
      editingMessage={null}
      editText=""
      messageDrafts={{}}
      onClose={() => {}}
      onRevealSource={() => {}}
      onEdit={() => {}}
      onCancelEdit={() => {}}
      onSaveEdit={() => {}}
      onUpdateMessageMeta={() => {}}
      onRetryAssistant={() => {}}
      onRequestAssistant={() => {}}
      onDeleteMessage={() => {}}
      onResolvePermission={() => {}}
      setEditText={() => {}}
      setMessageDraft={() => {}}
      onSend={async () => true}
    />
  );

  assert.match(html, /class="threadCanvasNode root active kind-task status-answered"/);
  assert.match(html, /class="threadNodeKindPill kind-task">任<\/span>/);
  assert.match(html, />任务 · 1 个子节点</);
  assert.match(html, />README\.md</);
  assert.doesNotMatch(html, />文章上下文</);
  assert.doesNotMatch(html, />讨论锚点</);
  assert.doesNotMatch(html, />讨论结构</);
  assert.doesNotMatch(html, />当前节点</);
  assert.doesNotMatch(html, /从右侧 tree 选择一个节点/);
});

test("thread detail defaults its three panes to a 3:5:2 ratio", () => {
  const widths = defaultThreadPaneWidths(1012, true);

  assert.deepEqual(widths, { document: 300, content: 500 });
  assert.equal(1012 - 12 - widths.document - widths.content, 200);
});

test("Escape closes the thread detail directly when no selection popover is open", () => {
  assert.equal(threadDetailEscapeTarget(false), "modal");
  assert.equal(threadDetailEscapeTarget(true), "selection");
});

test("custom node quick action uses only its configured prompt", () => {
  const prompt = promptForNodeQuickAction("  请执行我的自定义操作。\n");

  assert.equal(prompt, "请执行我的自定义操作。");
});
