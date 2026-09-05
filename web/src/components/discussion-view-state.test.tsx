import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentPayload, Message, Thread } from "../types";
import { chooseComparisonSide, comparisonPair, nodeOutcomeCounts, readWorkspaceDraft, reframeCanvas, restoredDiscussionNode, saveWorkspaceDraft, stableMessage, synthesisReferences, synthesisSources, workspaceEscapeTarget, workspaceStorageKey, type DiscussionPosition } from "./discussion-view-state";
import { defaultThreadPaneWidths } from "./ThreadRail";
import { THREAD_CANVAS_NODE_WIDTH, layoutConversationTree } from "../thread-canvas";
import { buildConversationTree } from "../thread-tree";

const at = "2026-09-05T00:00:00Z";
function question(id: string, parentId: string | null, content = id): Message { return { id, nodeId: id, parentId, content, role: "user", createdAt: at }; }
function answer(nodeId: string, content = `answer ${nodeId}`): Message { return { id: `${nodeId}-answer`, nodeId, parentId: nodeId, content, role: "assistant", createdAt: at }; }
const thread: Thread = {
  id: "source", title: "方案讨论", selectedText: "source", anchor: { start: 0, end: 6, lineStart: 1, lineEnd: 1, blockId: null }, createdAt: at, updatedAt: at,
  messages: [question("root", null, "不新增依赖"), answer("root"), question("constraint", "root", "保留所有旧客户端"), answer("constraint"), question("a", "constraint"), answer("a"), question("b", "constraint"), answer("b"), question("c", "root"), answer("c"), question("descendant", "a"), answer("descendant")]
};
const document: DocumentPayload = { path: "/workspace/design.md", title: "design", content: "source", revision: "v1", blocks: [] };

test("three selected nodes keep full Q&A plus a deduplicated original goal, without implicit ancestors or descendants", async () => {
  const plan = synthesisSources(thread, ["a", "b", "c"]);
  assert.deepEqual(plan.rootIds, ["root"]);
  assert.deepEqual(plan.paths[0].map((node) => node.id), ["root", "constraint", "a"]);
  const references = await synthesisReferences(document, thread, ["a", "b", "c"]);
  assert.deepEqual(references.map((item) => item.messageId), ["root", "a", "a-answer", "b", "b-answer", "c", "c-answer"]);
  assert.match(references[0].title, /原始目标/);
  assert.equal(references[0].content, "不新增依赖");
  assert.ok(references.every((item) => item.kind === "message"));
  assert.ok(references.every((item) => item.revision.length === 64));
});

test("selecting root explicitly does not duplicate its question; below two valid nodes is rejected", async () => {
  const references = await synthesisReferences(document, thread, ["root", "a"]);
  assert.equal(references.filter((item) => item.messageId === "root").length, 1);
  assert.ok(references.some((item) => item.messageId === "root-answer"));
  await assert.rejects(synthesisReferences(document, thread, ["a"]), /至少选择两个/);
  await assert.rejects(synthesisReferences(document, thread, ["a", "a"]), /至少选择两个/);
  await assert.rejects(synthesisReferences(document, thread, ["a", "deleted"]), /至少选择两个/);
});

test("pending and stable-id running answers cannot be synthesized; failed text remains explicit incomplete evidence", async () => {
  const running = { ...answer("a"), meta: { agentRun: { id: "run", status: "running", events: [] } } };
  assert.equal(stableMessage(running), false);
  assert.equal(stableMessage({ ...answer("a"), id: "pending-a" }), false);
  const live = { ...thread, messages: thread.messages.map((item) => item.id === running.id ? running : item) };
  await assert.rejects(synthesisReferences(document, live, ["a", "b"]), /仍在生成/);
  const failed = { ...thread, messages: thread.messages.map((item) => item.id === "a-answer" ? { ...item, error: true } : item).filter((item) => item.id !== "b-answer") };
  assert.deepEqual(synthesisSources(failed, ["a", "b"]).incomplete.map((node) => node.id), ["a", "b"]);
  assert.ok((await synthesisReferences(document, failed, ["a", "b"])).some((item) => item.messageId === "a-answer"));
});

test("side changes and swaps never mutate the complete selection", () => {
  const selected = ["a", "b", "c"];
  let pair = comparisonPair(selected, ["a", "b"]);
  pair = chooseComparisonSide(selected, pair, 1, "c");
  assert.deepEqual(pair, ["a", "c"]);
  pair = chooseComparisonSide(selected, pair, 0, "c");
  assert.deepEqual(pair, ["c", "a"]);
  assert.deepEqual(selected, ["a", "b", "c"]);
  assert.deepEqual(comparisonPair(["b", "c"], pair), ["c", "b"]);
  assert.deepEqual(chooseComparisonSide(selected, pair, 0, "deleted"), pair);
});

test("Escape closes selected text, multiselect, special view, then detail in that order", () => {
  assert.equal(workspaceEscapeTarget(true, true, "compare"), "selection");
  assert.equal(workspaceEscapeTarget(false, true, "compare"), "multiselect");
  assert.equal(workspaceEscapeTarget(false, false, "compare"), "view");
  assert.equal(workspaceEscapeTarget(false, false, "review"), "view");
  assert.equal(workspaceEscapeTarget(false, false, "discussion"), "modal");
});

test("view draft retains node, pin, scale, all scroll positions, selection and separate preparation drafts", () => {
  const key = workspaceStorageKey(document.path, thread.id);
  const state: DiscussionPosition = { view: "compare", selectedNodeId: "a", inspectorOpen: true, pinnedNodeId: "c", selection: ["a", "b", "c"], selecting: true, pair: ["a", "c"], documentOpen: true, transform: { x: 81, y: -22, scale: 1.4 }, overviewTransform: { x: 4, y: 8, scale: .8 }, paneWidths: { document: 240, content: 520 }, scroll: { document: 370, "work:a": 650, "compare:0:a": 170, "compare:1:c": 290 } };
  saveWorkspaceDraft(key, state);
  saveWorkspaceDraft(`${key}:prepare`, { content: "keep this instruction", scope: "references", references: [] });
  assert.deepEqual(readWorkspaceDraft(key), state);
  assert.deepEqual(readWorkspaceDraft(`${key}:prepare`), { content: "keep this instruction", scope: "references", references: [] });
  assert.equal(readWorkspaceDraft(workspaceStorageKey("other.md", thread.id)), null);
});

test("outcome counters use real source-matched unique records, not labels or unrelated messages", () => {
  const record = { id: "applied", kind: "proposal", status: "applied", source: { threadId: thread.id, messageId: "a-answer" } };
  const records = [record, record, { ...record, id: "review", status: "review" }, { ...record, id: "exec", kind: "execution", status: "completed" }, { ...record, id: "other", source: { threadId: "other", messageId: "a-answer" } }, { ...record, id: "no-source", source: {} }];
  assert.deepEqual(nodeOutcomeCounts(records, thread.id, ["a", "a-answer"]), { total: 3, applied: 1, executions: 1 });
  const inverse = { ...record, id: "undo", inverseOf: record.id };
  assert.deepEqual(nodeOutcomeCounts([{ ...record, status: "undone" }, inverse], thread.id, ["a-answer"]), { total: 2, applied: 0, executions: 0 });
});

test("initial whole-window measurement followed by the final three-pane width leaves the root fully visible", () => {
  const initial = { width: 1280 - 12, height: 580 };
  const panes = defaultThreadPaneWidths(1280, true);
  const viewport = { width: initial.width - panes.document - panes.content, height: initial.height };
  for (const messages of [[question("root", null), answer("root")], [question("root", null), answer("root"), question("a", "root"), answer("a"), question("b", "root"), answer("b")]]) {
    const root = layoutConversationTree(buildConversationTree(messages)).nodes[0];
    const first = reframeCanvas({ x: 0, y: 0, scale: 1 }, null, initial, root);
    const settled = reframeCanvas(first, initial, viewport);
    const x = settled.x + root.x * settled.scale;
    assert.equal(x, viewport.width / 2);
    assert.ok(x - THREAD_CANVAS_NODE_WIDTH / 2 >= 0, "the root's left edge must stay in the narrow canvas");
    assert.ok(x + THREAD_CANVAS_NODE_WIDTH / 2 <= viewport.width, "the root's right edge must stay in the narrow canvas");
  }
});

test("window and pane resizing preserve the user's panned world center and zoom, including a round trip", () => {
  const previous = { width: 254, height: 580 };
  const next = { width: 744, height: 410 };
  const panned = { x: -315, y: 206, scale: 1.6 };
  const center = (transform: typeof panned, size: typeof previous) => [(size.width / 2 - transform.x) / transform.scale, (size.height / 2 - transform.y) / transform.scale];
  const resized = reframeCanvas(panned, previous, next);
  assert.deepEqual(center(resized, next), center(panned, previous));
  assert.equal(resized.scale, panned.scale);
  assert.deepEqual(reframeCanvas(resized, next, previous), panned);
  assert.equal(reframeCanvas(panned, previous, previous), panned);
});

test("hiding the canvas never rewrites its transform; selecting a different node explicitly centers that node", () => {
  const viewport = { width: 254, height: 580 };
  const panned = { x: 81, y: -93, scale: .8 };
  assert.equal(reframeCanvas(panned, viewport, { width: 0, height: 0 }), panned);
  const target = { x: 294, y: 416 };
  const selected = reframeCanvas(panned, viewport, viewport, target);
  assert.equal(selected.x + target.x * selected.scale, viewport.width / 2);
  assert.equal(selected.y + target.y * selected.scale, viewport.height / 2);
  assert.equal(selected.scale, panned.scale);
});

test("reopening a saved canvas in a different viewport retains its reading center", () => {
  const saved = { transform: { x: 81, y: -22, scale: 1.4 }, viewport: { width: 254, height: 580 } };
  const next = { width: 450, height: 460 };
  saveWorkspaceDraft("canvas-reopen", saved);
  const restored = readWorkspaceDraft<typeof saved>("canvas-reopen")!;
  const transform = reframeCanvas(restored.transform, restored.viewport, next);
  assert.equal((next.width / 2 - transform.x) / transform.scale, (saved.viewport.width / 2 - saved.transform.x) / saved.transform.scale);
  assert.equal((next.height / 2 - transform.y) / transform.scale, (saved.viewport.height / 2 - saved.transform.y) / saved.transform.scale);
});

test("project discussion navigation restores a valid saved node without changing its drafts or scroll state", () => {
  const path = "/project/navigation-plan.md";
  const key = workspaceStorageKey(path, thread.id);
  const saved = { selectedNodeId: "b", scroll: { "work:b": 801 }, view: "focus" };
  saveWorkspaceDraft(key, saved);
  saveWorkspaceDraft(`${key}:draft`, "未发送草稿：检查视图切换后的阅读位置。");
  assert.equal(restoredDiscussionNode(path, thread), "b");
  assert.deepEqual(readWorkspaceDraft(key), saved);
  assert.equal(readWorkspaceDraft(`${key}:draft`), "未发送草稿：检查视图切换后的阅读位置。");
  assert.equal(restoredDiscussionNode("/project/requirements.md", thread), "root");
});

test("missing, stale or intentionally empty saved nodes fall back to an existing root; only an empty thread has no target", () => {
  const path = "/project/navigation-fallback.md";
  for (const selectedNodeId of ["deleted-node", null, "a-answer"]) {
    saveWorkspaceDraft(workspaceStorageKey(path, thread.id), { selectedNodeId });
    assert.equal(restoredDiscussionNode(path, thread), "root");
  }
  assert.equal(restoredDiscussionNode(path, { ...thread, messages: [] }), null);
  assert.equal(restoredDiscussionNode(path, { ...thread, id: "uncached" }), "root");
});
