import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown } from "./markdown";

test("rendered preview blocks expose exact Markdown source offsets", () => {
  const content = "# Title\n\n- item\n";
  const rendered = renderMarkdown(content);

  assert.match(rendered, /<h1 data-source-line="1" data-source-start="0" data-source-end="8">/);
  assert.match(rendered, /<li data-source-line="3" data-source-start="9" data-source-end="16">/);
});
