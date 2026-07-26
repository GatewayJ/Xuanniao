import type { ConversationNode } from "./thread-tree";

export const THREAD_CANVAS_NODE_WIDTH = 238;
export const THREAD_CANVAS_NODE_HEIGHT = 96;
export const THREAD_CANVAS_HORIZONTAL_GAP = 56;
export const THREAD_CANVAS_VERTICAL_GAP = 112;

export type ThreadCanvasNodeLayout = {
  node: ConversationNode;
  x: number;
  y: number;
  depth: number;
};

export type ThreadCanvasConnector = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

export type ThreadCanvasLayout = {
  nodes: ThreadCanvasNodeLayout[];
  connectors: ThreadCanvasConnector[];
  bounds: { left: number; top: number; right: number; bottom: number };
};

export function layoutConversationTree(roots: ConversationNode[]): ThreadCanvasLayout {
  if (roots.length === 0) {
    return { nodes: [], connectors: [], bounds: { left: 0, top: 0, right: 0, bottom: 0 } };
  }

  const subtreeWidths = new Map<string, number>();
  const measure = (node: ConversationNode): number => {
    const childrenWidth = node.children.reduce((total, child, index) => (
      total + measure(child) + (index === 0 ? 0 : THREAD_CANVAS_HORIZONTAL_GAP)
    ), 0);
    const width = Math.max(THREAD_CANVAS_NODE_WIDTH, childrenWidth);
    subtreeWidths.set(node.id, width);
    return width;
  };
  roots.forEach(measure);

  const forestWidth = roots.reduce((total, root, index) => (
    total + (subtreeWidths.get(root.id) || THREAD_CANVAS_NODE_WIDTH)
      + (index === 0 ? 0 : THREAD_CANVAS_HORIZONTAL_GAP)
  ), 0);
  const nodes: ThreadCanvasNodeLayout[] = [];
  let rootCursor = -forestWidth / 2;

  const place = (node: ConversationNode, x: number, depth: number) => {
    nodes.push({
      node,
      x,
      y: depth * (THREAD_CANVAS_NODE_HEIGHT + THREAD_CANVAS_VERTICAL_GAP),
      depth
    });
    if (node.children.length === 0) return;

    const childSpan = node.children.reduce((total, child, index) => (
      total + (subtreeWidths.get(child.id) || THREAD_CANVAS_NODE_WIDTH)
        + (index === 0 ? 0 : THREAD_CANVAS_HORIZONTAL_GAP)
    ), 0);
    let childCursor = x - childSpan / 2;
    for (const child of node.children) {
      const width = subtreeWidths.get(child.id) || THREAD_CANVAS_NODE_WIDTH;
      place(child, childCursor + width / 2, depth + 1);
      childCursor += width + THREAD_CANVAS_HORIZONTAL_GAP;
    }
  };

  for (const root of roots) {
    const width = subtreeWidths.get(root.id) || THREAD_CANVAS_NODE_WIDTH;
    place(root, rootCursor + width / 2, 0);
    rootCursor += width + THREAD_CANVAS_HORIZONTAL_GAP;
  }

  const positions = new Map(nodes.map((item) => [item.node.id, item]));
  const connectors = nodes.flatMap((item) => item.node.children.map((child) => {
    const childLayout = positions.get(child.id);
    return childLayout ? {
      id: `${item.node.id}:${child.id}`,
      fromNodeId: item.node.id,
      toNodeId: child.id,
      fromX: item.x,
      fromY: item.y + THREAD_CANVAS_NODE_HEIGHT / 2,
      toX: childLayout.x,
      toY: childLayout.y - THREAD_CANVAS_NODE_HEIGHT / 2
    } : [];
  })).flat();

  return {
    nodes,
    connectors,
    bounds: {
      left: Math.min(...nodes.map((item) => item.x - THREAD_CANVAS_NODE_WIDTH / 2)),
      top: Math.min(...nodes.map((item) => item.y - THREAD_CANVAS_NODE_HEIGHT / 2)),
      right: Math.max(...nodes.map((item) => item.x + THREAD_CANVAS_NODE_WIDTH / 2)),
      bottom: Math.max(...nodes.map((item) => item.y + THREAD_CANVAS_NODE_HEIGHT / 2))
    }
  };
}
