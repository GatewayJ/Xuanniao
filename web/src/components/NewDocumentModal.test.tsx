import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectoryPickerModal } from "./DirectoryPickerModal";
import { NewDocumentModal } from "./NewDocumentModal";
import { DiscussionWorkspaceContext, type DiscussionWorkspaceActions } from "./DiscussionWorkspaceContext";
import type { DocumentCreationRetry } from "../document-creation";

const browser = {
  directory: "/workspace",
  parent: "/",
  selectedPath: null,
  entries: [
    { path: "/workspace/docs", name: "docs", kind: "directory" as const, size: null, modifiedAt: null },
    { path: "/workspace/README.md", name: "README.md", kind: "file" as const, size: 12, modifiedAt: "2026-08-02T00:00:00.000Z" }
  ]
};

function renderCreation(workspace: DiscussionWorkspaceActions, { creating = true, retry = null }: { creating?: boolean; retry?: DocumentCreationRetry | null } = {}) {
  return renderToStaticMarkup(<DiscussionWorkspaceContext value={workspace}><NewDocumentModal
    open creating={creating} retry={retry} workspaceRoot="/workspace" error="" run={null}
    directoryBrowser={browser} directoryLoading={false} directoryError="" permissionRequests={[]}
    resolvingPermissionIds={new Set()} onClose={() => {}} onBrowseDirectory={() => {}} onCreate={() => {}} onResolvePermission={() => {}}
  /></DiscussionWorkspaceContext>);
}

const workspace: DiscussionWorkspaceActions = {
  adopt() {}, execute() {}, referenceTo() {}, reevaluate() {}, openResults() {}, stop() {},
  busy: true, canStop: true, records: [], references: [], document: null
};

test("document creation can be stopped or left running from inside its modal", () => {
  const html = renderCreation(workspace);
  assert.match(html, /<button type="button">停止创建<\/button>/);
  assert.match(html, /<button type="button">后台继续<\/button>/);
  assert.match(html, /关闭面板后继续生成/);
  assert.match(html, /停止不会撤销已经创建的文件/);
  assert.doesNotMatch(html, /disabled=""[^>]*>关闭/);
  assert.match(renderCreation({ ...workspace, canStop: false }), /<button type="button" disabled="">停止创建<\/button>/);
});

test("reopening a creation retry restores the destination and shows the already-created file", () => {
  const html = renderCreation(workspace, { creating: false, retry: {
    recordId: "old", documentPath: "/workspace/source.md", createdPath: "/workspace/docs/old.md",
    command: { instruction: "Document recovery behavior", directory: "docs", fileName: "plan.md" }, previousResult: "Partial result"
  } });
  assert.match(html, /Document recovery behavior/);
  assert.match(html, /value="docs"/);
  assert.match(html, /value="plan.md"/);
  assert.match(html, /已创建文件：\/workspace\/docs\/old.md/);
  assert.match(html, /Partial result/);
  assert.match(html, /disabled=""[^>]*>创建文档/);
});

test("new document form exposes optional directory and file name controls", () => {
  const html = renderToStaticMarkup(
    <NewDocumentModal
      open
      workspaceRoot="/workspace"
      creating={false}
      error=""
      run={null}
      directoryBrowser={browser}
      directoryLoading={false}
      directoryError=""
      permissionRequests={[]}
      resolvingPermissionIds={new Set()}
      onClose={() => {}}
      onBrowseDirectory={() => {}}
      onCreate={() => {}}
      onResolvePermission={() => {}}
    />
  );

  assert.match(html, /保存位置（可选）/);
  assert.match(html, /aria-label="文档目录"/);
  assert.match(html, /选择目录/);
  assert.match(html, /aria-label="文档文件名"/);
  assert.match(html, /由 Codex 自动命名/);
});

test("directory picker lists only directories and cannot leave the workspace root", () => {
  const html = renderToStaticMarkup(
    <DirectoryPickerModal
      open
      workspaceRoot="/workspace"
      browser={browser}
      loading={false}
      error=""
      onClose={() => {}}
      onBrowse={() => {}}
      onSelect={() => {}}
    />
  );

  assert.match(html, /选择当前目录/);
  assert.match(html, /▸ docs/);
  assert.doesNotMatch(html, /README\.md/);
  assert.match(html, /<button type="button" disabled="">上一级<\/button>/);
});
