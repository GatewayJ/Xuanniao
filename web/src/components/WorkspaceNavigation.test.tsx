import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscussionWorkspaceContext, type DiscussionWorkspaceActions } from "./DiscussionWorkspaceContext";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

const actions: DiscussionWorkspaceActions = {
  adopt() {}, execute() {}, referenceTo() {}, reevaluate() {}, openResults() {}, openProject() {}, stop() {},
  records: [], references: [], document: null, busy: true, canStop: true, activityLabel: "等待权限 · 1 项请求"
};

test("opening a discussion leaves one in-flow project/results navigation with status and stop available", () => {
  const html = renderToStaticMarkup(<DiscussionWorkspaceContext value={actions}>
    <WorkspaceNavigation placement="workspace" hidden />
    <section role="dialog"><WorkspaceNavigation placement="discussion" /></section>
  </DiscussionWorkspaceContext>);
  assert.equal((html.match(/aria-label="项目与成果"/g) || []).length, 1);
  assert.doesNotMatch(html, /workspaceNavigation-workspace|workspaceOutcomeDock/);
  assert.ok(html.indexOf('role="dialog"') < html.indexOf('aria-label="项目与成果"'));
  for (const label of ["项目总览", "成果记录", "等待权限 · 1 项请求", "停止当前执行"]) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /disabled/);
});

test("stopping and recovery states disable the shared stop button in either placement", () => {
  for (const placement of ["workspace", "discussion"] as const) {
    const html = renderToStaticMarkup(<DiscussionWorkspaceContext value={{ ...actions, canStop: false, activityLabel: "正在停止并协调文件变化…" }}>
      <WorkspaceNavigation placement={placement} />
    </DiscussionWorkspaceContext>);
    assert.match(html, /<button[^>]*disabled=""[^>]*>停止当前执行<\/button>/);
    assert.match(html, /正在停止并协调文件变化/);
  }
});
