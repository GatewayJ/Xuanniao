import assert from "node:assert/strict";
import test from "node:test";

import {
  THREAD_CANVAS_NODE_HEIGHT,
  THREAD_CANVAS_VERTICAL_GAP,
  layoutConversationTree
} from "./thread-canvas.ts";
import type { ConversationNode } from "./thread-tree.ts";

const at = "2026-07-22T00:00:00.000Z";

function node(id: string, children: ConversationNode[] = []): ConversationNode {
  const question = { id, role: "user" as const, content: id, createdAt: at };
  return { id, parentId: null, question, messages: [question], children };
}

test("centers a single root at the canvas origin", () => {
  const layout = layoutConversationTree([node("root")]);
  assert.deepEqual(layout.nodes.map(({ node: item, x, y }) => ({ id: item.id, x, y })), [
    { id: "root", x: 0, y: 0 }
  ]);
});

test("lays out siblings as a multi-way tree without overlap", () => {
  const layout = layoutConversationTree([
    node("root", [node("left"), node("middle", [node("leaf")]), node("right")])
  ]);
  const positions = new Map(layout.nodes.map((item) => [item.node.id, item]));
  const root = positions.get("root")!;
  const left = positions.get("left")!;
  const middle = positions.get("middle")!;
  const right = positions.get("right")!;
  const leaf = positions.get("leaf")!;

  assert.equal(root.x, 0);
  assert.ok(left.x < middle.x && middle.x < right.x);
  assert.equal(left.y, THREAD_CANVAS_NODE_HEIGHT + THREAD_CANVAS_VERTICAL_GAP);
  assert.equal(leaf.y, 2 * (THREAD_CANVAS_NODE_HEIGHT + THREAD_CANVAS_VERTICAL_GAP));
  assert.equal(layout.connectors.length, 4);
  assert.deepEqual(
    layout.connectors.map(({ fromNodeId, toNodeId }) => `${fromNodeId}:${toNodeId}`),
    ["root:left", "root:middle", "root:right", "middle:leaf"]
  );
  assert.ok(layout.bounds.left < 0 && layout.bounds.right > 0);
});
