import assert from "node:assert/strict";
import test from "node:test";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReferenceSnapshot } from "../types";
import type { ReferenceCheck } from "../project-api";
import { locateReferenceSource } from "./DiscussionWorkspaceContext";
import { ReferencePreviewContent } from "./ReferencePreview";

const reference: ReferenceSnapshot = { id: "foreign-reference", kind: "document", title: "Foreign excerpt", documentPath: "/external/source.md", content: "Historical content", start: 500, end: 518, revision: "v1" };
const check: ReferenceCheck = { id: reference.id, state: "current", checkedAt: "2026-09-05T00:00:00Z" };
const noop = () => {};
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function preview(props: Partial<Parameters<typeof ReferencePreviewContent>[0]> = {}) {
  let root!: ReturnType<typeof ReferencePreviewContent>;
  function Probe() { root = ReferencePreviewContent({ reference, busy: false, onClose: noop, onOpen: async () => {}, check, checking: false, error: "", refresh: noop, ...props }); return root; }
  const html = renderToStaticMarkup(<Probe />);
  const button = elements(root).find((element) => element.type === "button" && element.props.className === "primary")!;
  assert.ok(button);
  return { html, disabled: button.props.disabled, open: button.props.onClick as () => void };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("foreign message and document references preview without invoking local thread or scroll navigation", () => {
  const previews: ReferenceSnapshot[] = [];
  const local: ReferenceSnapshot[] = [];
  const actions = { preview: (ref: ReferenceSnapshot) => previews.push(ref), locate: (ref: ReferenceSnapshot) => local.push(ref) };
  const foreignMessage = { ...reference, kind: "message" as const, threadId: "absent-local-thread", messageId: "foreign-message" };
  locateReferenceSource(reference, "/active.md", actions);
  locateReferenceSource(foreignMessage, "/active.md", actions);
  assert.deepEqual(previews, [reference, foreignMessage]); assert.deepEqual(local, []);
  locateReferenceSource({ ...reference, documentPath: "/active.md" }, "/active.md", actions);
  assert.equal(local.length, 1);
});

test("previewing a foreign reference never opens it automatically; an explicit click opens it once", async () => {
  const calls: unknown[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const view = preview({ onOpen: async (ref, locate) => { calls.push([ref, locate]); await pending; } });
  assert.deepEqual(calls, []); assert.equal(view.disabled, false);
  assert.match(view.html, /引用来源只读预览/); assert.match(view.html, /Historical content/);
  assert.doesNotMatch(view.html, /<textarea|contenteditable|开始执行|采纳并写入/);
  view.open(); view.open();
  assert.deepEqual(calls, [[reference, true]]);
  finish(); await tick();
});

test("unknown ranges open the source without passing old offsets for navigation; oversized sources explain how to recover", async () => {
  for (const latestUnavailableReason of [undefined, "reference_too_large"] as const) {
    const calls: unknown[] = [];
    const view = preview({ check: { ...check, state: "changed", latestUnavailableReason }, onOpen: async (ref, locate) => { calls.push([ref, locate]); } });
    assert.equal(view.disabled, false);
    assert.match(view.html, latestUnavailableReason ? /超过 160,000 字符.*选择更小的片段/ : /无法唯一定位.*重新查找/);
    view.open(); await tick();
    assert.deepEqual(calls, [[reference, false]]);
  }
  const latest = { ...reference, id: "latest", start: 800, end: 818, revision: "v2" };
  const calls: unknown[] = [];
  const relocated = preview({ check: { ...check, latest, relocated: true }, onOpen: async (ref, locate) => { calls.push([ref, locate]); } });
  relocated.open(); await tick(); assert.deepEqual(calls, [[latest, true]]);
});

test("busy, unavailable and unverified sources remain readable but cannot open, including direct handler dispatch", async () => {
  for (const props of [
    { busy: true }, { check: { ...check, state: "missing" as const } }, { check: undefined }, { checking: true }, { error: "ENOENT" }
  ]) {
    let calls = 0;
    const view = preview({ ...props, onOpen: async () => { calls++; } });
    assert.equal(view.disabled, true); assert.match(view.html, /Historical content/);
    view.open(); await tick(); assert.equal(calls, 0);
  }
});
