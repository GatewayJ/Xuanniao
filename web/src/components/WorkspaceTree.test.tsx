import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { directoryPathChain, WorkspaceTree } from "./WorkspaceTree";

test("workspace tree exposes the selected directory as persistent navigation", () => {
  const html = renderToStaticMarkup(
    <WorkspaceTree
      rootPath="/workspace"
      currentPath="/workspace/docs/readme.md"
      collapsed={false}
      openingPath={null}
      onBrowse={async () => ({ directory: "/workspace", parent: "/", selectedPath: null, entries: [] })}
      onChooseDirectory={() => {}}
      onOpenFile={() => {}}
      onToggleCollapsed={() => {}}
    />
  );

  assert.match(html, /aria-label="目录文件树"/);
  assert.match(html, /aria-label="收起目录"/);
  assert.match(html, /aria-label="workspace"/);
});

test("collapsed workspace tree keeps a compact expand control", () => {
  const html = renderToStaticMarkup(
    <WorkspaceTree
      rootPath="/workspace"
      currentPath="/workspace/prd.md"
      collapsed
      openingPath={null}
      onBrowse={async () => ({ directory: "/workspace", parent: "/", selectedPath: null, entries: [] })}
      onChooseDirectory={() => {}}
      onOpenFile={() => {}}
      onToggleCollapsed={() => {}}
    />
  );

  assert.match(html, /aria-label="已收起的目录文件树"/);
  assert.match(html, /aria-label="展开目录"/);
  assert.doesNotMatch(html, /role="tree"/);
});

test("directory path chain expands the active file ancestors only inside the root", () => {
  assert.deepEqual(
    directoryPathChain("/workspace", "/workspace/docs/guides/readme.md"),
    ["/workspace", "/workspace/docs", "/workspace/docs/guides"]
  );
  assert.deepEqual(directoryPathChain("/", "/docs/readme.md"), ["/", "/docs"]);
  assert.deepEqual(directoryPathChain("/workspace", "/workspace-copy/readme.md"), []);
});
