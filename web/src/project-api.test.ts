import assert from "node:assert/strict";
import test from "node:test";
import { projectApi } from "./project-api";
import type { ReferenceSnapshot } from "./types";

test("project requests preserve explicit document paths and the immutable reference check body", async (t) => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const payloads = [{ root: "/project", checkedAt: "now", documents: [] }, { document: {}, threads: [], records: [], external: true }, [{ id: "r", state: "missing", checkedAt: "now" }]];
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payloads[calls.length - 1]), { status: 200 });
  });
  const reference: ReferenceSnapshot = { id: "r", documentPath: "/outside/含 #&.md", kind: "document", start: 0, end: 3, content: "old", title: "Old", revision: "v1" };
  const before = structuredClone(reference);
  const controller = new AbortController();
  await projectApi.list(controller.signal);
  await projectApi.preview(reference.documentPath, controller.signal);
  assert.deepEqual(await projectApi.checkReferences([reference], controller.signal), payloads[2]);
  assert.equal(calls[0].url, "/api/project");
  assert.equal(calls[1].url, `/api/project/preview?path=${encodeURIComponent(reference.documentPath)}`);
  assert.equal(calls[2].url, "/api/references/check");
  assert.equal(calls[2].options?.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].options?.body as string), { references: [reference] });
  assert.equal(calls.every((call) => call.options?.signal === controller.signal && call.options?.cache === "no-store"), true);
  assert.deepEqual(reference, before);
});

test("failed checks surface an error instead of treating an unavailable response as current", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "source unavailable" }), { status: 503 }));
  await assert.rejects(projectApi.checkReferences([]), /source unavailable/);
});

test("relinking is explicit while ordinary registration preserves historical identity", async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options?: RequestInit) => {
    bodies.push(JSON.parse(options?.body as string));
    return new Response(JSON.stringify({ registeredPath: "/project/source.md", documents: [] }));
  });
  await projectApi.register("source.md");
  await projectApi.register("source.md", true);
  assert.deepEqual(bodies, [{ path: "source.md", relink: false }, { path: "source.md", relink: true }]);
});
