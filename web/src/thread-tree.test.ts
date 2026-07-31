import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationTree,
  conversationBreadcrumb,
  conversationNavigation,
  conversationNodeCanBranch,
  conversationNodeKind,
  conversationNodeStatus,
  flattenConversationTree
} from "./thread-tree.ts";
import type { Message } from "./types.ts";

const at = "2026-07-22T00:00:00.000Z";

test("maps legacy linear messages into a single conversation chain", () => {
  const messages: Message[] = [
    { id: "q1", role: "user", content: "One", createdAt: at },
    { id: "a1", role: "assistant", content: "Answer one", createdAt: at },
    { id: "q2", role: "user", content: "Two", createdAt: at },
    { id: "a2", role: "assistant", content: "Answer two", createdAt: at }
  ];
  const roots = buildConversationTree(messages);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].messages.map((message) => message.id), ["q1", "a1"]);
  assert.equal(roots[0].children[0].id, "q2");
  assert.deepEqual(roots[0].children[0].messages.map((message) => message.id), ["q2", "a2"]);
});

test("groups multiple follow-up turns inside the same conversation node", () => {
  const messages: Message[] = [
    { id: "q1", role: "user", content: "Root", nodeId: "q1", parentId: null, createdAt: at },
    { id: "a1", role: "assistant", content: "Answer", nodeId: "q1", parentId: "q1", createdAt: at },
    { id: "q1-more", role: "user", content: "Continue", nodeId: "q1", parentId: null, createdAt: at },
    { id: "a1-more", role: "assistant", content: "More", nodeId: "q1", parentId: "q1-more", createdAt: at }
  ];
  const roots = buildConversationTree(messages);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].messages.map((message) => message.id), ["q1", "a1", "q1-more", "a1-more"]);
});

test("keeps sibling follow-up questions as separate child branches", () => {
  const messages: Message[] = [
    { id: "q1", role: "user", content: "Root", parentId: null, createdAt: at },
    { id: "a1", role: "assistant", content: "Answer", parentId: "q1", createdAt: at },
    { id: "q2", role: "user", content: "Left", parentId: "q1", createdAt: at },
    { id: "q3", role: "user", content: "Right", parentId: "q1", createdAt: at }
  ];
  const roots = buildConversationTree(messages);
  assert.deepEqual(roots[0].children.map((node) => node.id), ["q2", "q3"]);
  assert.deepEqual(flattenConversationTree(roots).map((node) => node.id), ["q1", "q2", "q3"]);
});

test("only nodes with an existing child path can create a separate branch", () => {
  const roots = buildConversationTree([
    { id: "root", role: "user", content: "Root", parentId: null, createdAt: at },
    { id: "leaf", role: "user", content: "Leaf", parentId: "root", createdAt: at }
  ]);

  assert.equal(conversationNodeCanBranch(roots[0]), true);
  assert.equal(conversationNodeCanBranch(roots[0].children[0]), false);
});

test("leaves existing children in place when creating a sibling child branch", () => {
  const messages: Message[] = [
    { id: "a", role: "user", content: "A", nodeId: "a", parentId: null, createdAt: at },
    { id: "b", role: "user", content: "B", nodeId: "b", parentId: "a", createdAt: at },
    { id: "c", role: "user", content: "C", nodeId: "c", parentId: "b", createdAt: at },
    { id: "d", role: "user", content: "D", nodeId: "d", parentId: "b", createdAt: at }
  ];

  assert.deepEqual(buildConversationTree(messages)[0].children[0].children.map((node) => node.id), ["c", "d"]);
});

test("maps four-way navigation to parent, first child, and adjacent siblings", () => {
  const messages: Message[] = [
    { id: "a", role: "user", content: "A", nodeId: "a", parentId: null, createdAt: at },
    { id: "b", role: "user", content: "B", nodeId: "b", parentId: "a", createdAt: at },
    { id: "c", role: "user", content: "C", nodeId: "c", parentId: "a", createdAt: at },
    { id: "d", role: "user", content: "D", nodeId: "d", parentId: "b", createdAt: at }
  ];
  const roots = buildConversationTree(messages);

  const fromB = conversationNavigation(roots, "b");
  assert.equal(fromB.left, null);
  assert.equal(fromB.right?.id, "c");
  assert.equal(fromB.up?.id, "a");
  assert.equal(fromB.down?.id, "d");

  const fromC = conversationNavigation(roots, "c");
  assert.equal(fromC.left?.id, "b");
  assert.equal(fromC.right, null);
  assert.equal(fromC.up?.id, "a");
  assert.equal(fromC.down, null);
});

test("builds a root-to-current breadcrumb without sibling nodes", () => {
  const messages: Message[] = [
    { id: "a", role: "user", content: "A", nodeId: "a", parentId: null, createdAt: at },
    { id: "b", role: "user", content: "B", nodeId: "b", parentId: "a", createdAt: at },
    { id: "c", role: "user", content: "C", nodeId: "c", parentId: "b", createdAt: at },
    { id: "sibling", role: "user", content: "Sibling", nodeId: "sibling", parentId: "a", createdAt: at }
  ];

  assert.deepEqual(conversationBreadcrumb(buildConversationTree(messages), "c").map((node) => node.id), ["a", "b", "c"]);
});

test("reports honest node answer states", () => {
  const unanswered = buildConversationTree([
    { id: "q", role: "user", content: "Question", nodeId: "q", parentId: null, createdAt: at }
  ])[0];
  assert.equal(conversationNodeStatus(unanswered), "unanswered");

  const thinking = buildConversationTree([
    unanswered.question,
    { id: "pending-agent-1", role: "assistant", content: "Thinking", nodeId: "q", parentId: "q", createdAt: at }
  ])[0];
  assert.equal(conversationNodeStatus(thinking), "thinking");

  const failed = buildConversationTree([
    unanswered.question,
    { id: "a", role: "assistant", content: "Failed", nodeId: "q", parentId: "q", error: true, createdAt: at }
  ])[0];
  assert.equal(conversationNodeStatus(failed), "failed");
});

test("reads semantic node kind from message metadata", () => {
  const risk = buildConversationTree([
    { id: "q", role: "user", content: "Risk", nodeId: "q", parentId: null, meta: { nodeKind: "risk" }, createdAt: at }
  ])[0];
  const fallback = buildConversationTree([
    { id: "plain", role: "user", content: "Plain", nodeId: "plain", parentId: null, meta: { nodeKind: "unknown" }, createdAt: at }
  ])[0];

  assert.equal(conversationNodeKind(risk), "risk");
  assert.equal(conversationNodeKind(fallback), "question");
});
