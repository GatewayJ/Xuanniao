import assert from "node:assert/strict";
import test from "node:test";

import { findPreviewBlockForLine } from "./thread-spatial";

function previewBlock(line: number, top: number) {
  return { dataset: { sourceLine: String(line) }, offsetTop: top } as unknown as HTMLElement;
}

test("preview line lookup uses the nearest preceding rendered block", () => {
  const lineOne = previewBlock(1, 0);
  const lineTen = previewBlock(10, 180);
  const lineTwenty = previewBlock(20, 420);
  const root = {
    querySelectorAll: () => [lineTwenty, lineOne, lineTen]
  } as unknown as HTMLElement;

  assert.equal(findPreviewBlockForLine(root, 10), lineTen);
  assert.equal(findPreviewBlockForLine(root, 16), lineTen);
  assert.equal(findPreviewBlockForLine(root, 20), lineTwenty);
});
