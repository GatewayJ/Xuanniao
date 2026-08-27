import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadDetailModal } from "./ThreadRail";
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
      { id: "root", role: "user", content: "Root question", nodeId: "root", parentId: null, createdAt: at },
      { id: "answer", role: "assistant", content: "Root answer", nodeId: "root", parentId: "root", createdAt: at },
      { id: "child", role: "user", content: "Child question", nodeId: "child", parentId: "root", createdAt: at }
    ],
    createdAt: at,
    updatedAt: at
  };

  const html = renderToStaticMarkup(
    <ThreadDetailModal
      documentData={null}
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

  assert.match(html, /class="threadCanvasNode root active kind-question status-answered"/);
  assert.doesNotMatch(html, /从右侧 tree 选择一个节点/);
});
