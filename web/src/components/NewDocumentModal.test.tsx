import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectoryPickerModal } from "./DirectoryPickerModal";
import { NewDocumentModal } from "./NewDocumentModal";

const browser = {
  directory: "/workspace",
  parent: "/",
  selectedPath: null,
  entries: [
    { path: "/workspace/docs", name: "docs", kind: "directory" as const, size: null, modifiedAt: null },
    { path: "/workspace/README.md", name: "README.md", kind: "file" as const, size: 12, modifiedAt: "2026-08-02T00:00:00.000Z" }
  ]
};

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
