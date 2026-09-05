import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscussionAnswerActions } from "./DiscussionAnswerActions";
import { DiscussionWorkspaceContext, type DiscussionWorkspaceActions } from "./DiscussionWorkspaceContext";
import { DiscussionComparison, DiscussionViewSwitcher } from "./DiscussionViews";
import { buildConversationTree, flattenConversationTree } from "../thread-tree";
import type { Message, Thread } from "../types";

const message: Message = { id: "answer", role: "assistant", content: "A stable conclusion", createdAt: "2026-09-05" };
const thread: Thread = { id: "thread", title: "Source", selectedText: "source", anchor: { start: 0, end: 6, lineStart: 1, lineEnd: 1, blockId: null }, createdAt: "2026-09-05", updatedAt: "2026-09-05", messages: [message] };
const actions: DiscussionWorkspaceActions = { adopt() {}, execute() {}, referenceTo() {}, reevaluate() {}, stop() {}, openResults() {}, records: [], references: [], document: null, busy: false };

test("answer toolbar renders all parent actions and disables unstable text even with a durable message id", () => {
  const render = (answer: Message, busy = false) => renderToStaticMarkup(<DiscussionWorkspaceContext value={{ ...actions, busy }}><DiscussionAnswerActions thread={thread} message={answer} /></DiscussionWorkspaceContext>);
  const html = render(message);
  assert.match(html, /采纳到文档/);
  assert.match(html, /据此执行/);
  assert.match(html, /引用到其他讨论/);
  assert.doesNotMatch(html, /disabled/);
  const pending = render({ ...message, meta: { agentRun: { id: "durable", status: "running", events: [] } } });
  assert.equal((pending.match(/disabled=""/g) || []).length, 3);
  // A stable answer can open a preparation draft while another operation runs.
  assert.equal((render(message, true).match(/disabled=""/g) || []).length, 0);
  assert.equal(renderToStaticMarkup(<DiscussionAnswerActions thread={thread} message={message} />), "");
});

test("comparison markup includes every selected node and separate accessible selectors", () => {
  const source = { ...thread, messages: ["a", "b", "c"].flatMap((id) => [
    { ...message, id, nodeId: id, parentId: null, role: "user" as const, content: `Question ${id}` },
    { ...message, id: `${id}-answer`, nodeId: id, parentId: id, content: `Answer ${id}` }
  ]) };
  const html = renderToStaticMarkup(<DiscussionComparison thread={source} nodes={flattenConversationTree(buildConversationTree(source.messages))} selectedIds={["a", "b", "c"]} pair={["a", "b"]} onPairChange={() => {}} onOpen={() => {}} scroll={{}} onSaveScroll={() => {}} />);
  assert.match(html, /共选 3 项/);
  assert.match(html, /<li>Question c<\/li>/);
  assert.match(html, /aria-label="左栏节点"/);
  assert.match(html, /aria-label="右栏节点"/);
  assert.match(html, /交换左右/);
  assert.match(html, /左栏问答，可独立滚动/);
  assert.match(html, /右栏问答，可独立滚动/);
});

test("view switcher requires two selected nodes for comparison and preserves normal modes", () => {
  const html = renderToStaticMarkup(<DiscussionViewSwitcher view="focus" onChange={() => {}} canCompare={false} />);
  assert.match(html, /disabled=""[^>]*>比较/);
  for (const label of ["讨论", "专注", "审核", "总览"]) assert.ok(html.includes(label));
});
