import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FilePickerModal } from "./FilePickerModal";

test("file picker can open the displayed directory or a Markdown file", () => {
  const html = renderToStaticMarkup(
    <FilePickerModal
      open
      currentPath="/workspace/prd.md"
      browser={{
        directory: "/workspace",
        parent: "/",
        selectedPath: "/workspace/prd.md",
        entries: []
      }}
      loading={false}
      error=""
      onClose={() => {}}
      onBrowse={() => {}}
      onOpenDirectory={() => {}}
      onOpenFile={() => {}}
    />
  );

  assert.match(html, /打开目录或 Markdown 文档/);
  assert.match(html, />打开目录</);
  assert.match(html, />打开文件</);
});
