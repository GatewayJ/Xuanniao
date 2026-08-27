import assert from "node:assert/strict";
import test from "node:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_DOCUMENT_MODE, DocumentPane } from "./DocumentPane";

test("document pane defaults to preview and lists preview before edit", () => {
  const html = renderToStaticMarkup(
    <DocumentPane
      mode={DEFAULT_DOCUMENT_MODE}
      documentData={null}
      activeThread={null}
      editorHostRef={createRef<HTMLDivElement>()}
      previewRef={createRef<HTMLElement>()}
      onModeChange={() => {}}
      onNavigateToLine={() => {}}
      onPreviewScroll={() => {}}
      onPreviewSelectionChange={() => {}}
    />
  );

  assert.equal(DEFAULT_DOCUMENT_MODE, "preview");
  assert.ok(html.indexOf(">预览</button>") < html.indexOf(">编辑</button>"));
  assert.match(html, /class="tab active">预览<\/button>/);
});
