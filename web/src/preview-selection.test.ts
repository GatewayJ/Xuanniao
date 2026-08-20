import assert from "node:assert/strict";
import test from "node:test";

import { alignRenderedTextToSource, selectionContextForPreview } from "./preview-selection";

test("aligns rendered text through Markdown block and inline markers", () => {
  const source = "- Use **strong** text";
  const rendered = "Use strong text";
  const boundaries = alignRenderedTextToSource(rendered, source);

  assert.ok(boundaries);
  assert.equal(boundaries[0], source.indexOf("Use"));
  assert.equal(boundaries[rendered.indexOf("strong")], source.indexOf("strong"));
  assert.equal(boundaries[rendered.length], source.length);
});

test("aligns markdown-it typographer replacements to source punctuation", () => {
  const source = '\"Quoted\"... -- done';
  const rendered = "“Quoted”… – done";
  const boundaries = alignRenderedTextToSource(rendered, source);

  assert.ok(boundaries);
  assert.equal(boundaries[0], 0);
  assert.equal(boundaries[rendered.length], source.length);
});

test("uses the DOM range instead of the first duplicate on the same source line", () => {
  const content = "foo **foo**";
  const preview = previewRange(content, "foo foo", 4, 7);

  const selection = selectionContextForPreview(preview.root, preview.range, content);

  assert.equal(selection?.selectedText, "foo");
  assert.equal(selection?.anchor.start, content.lastIndexOf("foo"));
  assert.equal(selection?.anchor.end, content.lastIndexOf("foo") + 3);
});

test("rejects a preview selection when its DOM boundaries cannot map to source", () => {
  const content = "different source";
  const preview = previewRange(content, "unmappable", 0, "unmappable".length);

  assert.equal(selectionContextForPreview(preview.root, preview.range, content), null);
});

test("does not guess between duplicate source matches when DOM mapping fails", () => {
  const content = "| foo | foo |\n";
  const rendered = "\nfoo\nfoo\n";
  const preview = previewRange(content, rendered, rendered.lastIndexOf("foo"), rendered.lastIndexOf("foo") + 3);

  assert.equal(selectionContextForPreview(preview.root, preview.range, content), null);
});

function previewRange(content: string, renderedText: string, startOffset: number, endOffset: number) {
  class FakeHTMLElement {
    nodeType = 1;
    dataset: Record<string, string> = {};
    textContent = "";
    parentElement: FakeHTMLElement | null = null;
    ownerDocument = {
      createRange: () => {
        let offset = 0;
        return {
          selectNodeContents() {},
          setEnd(_node: unknown, nextOffset: number) {
            offset = nextOffset;
          },
          toString() {
            return renderedText.slice(0, offset);
          }
        };
      }
    };

    closest() {
      return this;
    }

    contains() {
      return true;
    }
  }

  const sourceElement = new FakeHTMLElement();
  sourceElement.dataset = {
    sourceStart: "0",
    sourceEnd: String(content.length),
    sourceLine: "1"
  };
  sourceElement.textContent = renderedText;
  const textNode = { nodeType: 3, parentElement: sourceElement };
  const root = new FakeHTMLElement();
  const range = {
    startContainer: textNode,
    endContainer: textNode,
    startOffset,
    endOffset,
    toString: () => renderedText.slice(startOffset, endOffset)
  };
  return { root: root as unknown as HTMLElement, range: range as unknown as Range };
}
