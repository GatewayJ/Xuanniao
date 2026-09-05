import assert from "node:assert/strict";
import test from "node:test";
import { conversationDraftsFor, updateConversationDrafts, type DocumentConversationDrafts } from "./conversation-drafts";
import type { ReferenceSnapshot } from "./types";

const reference: ReferenceSnapshot = {
  id: "source", kind: "document", documentPath: "/source.md", title: "Source",
  revision: "original-version", start: 0, end: 5, content: "quote", capturedAt: "2026-09-05T00:00:00Z"
};

test("returning to a document restores its question, references and send error", () => {
  let documents: DocumentConversationDrafts = {};
  documents = updateConversationDrafts(documents, "/a.md", "messages", { node: "Unsent question" });
  documents = updateConversationDrafts(documents, "/a.md", "references", { node: [reference] });
  documents = updateConversationDrafts(documents, "/a.md", "errors", { node: "Source changed" });
  assert.deepEqual(conversationDraftsFor(documents, "/b.md"), { messages: {}, references: {}, errors: {} });
  documents = updateConversationDrafts(documents, "/b.md", "messages", { node: "Another question" });
  assert.deepEqual(conversationDraftsFor(documents, "/a.md"), {
    messages: { node: "Unsent question" }, references: { node: [reference] }, errors: { node: "Source changed" }
  });
});

test("queued draft updates and submission cleanup stay scoped to their source document", () => {
  let documents: DocumentConversationDrafts = {};
  documents = updateConversationDrafts(documents, "/a.md", "messages", { node: "A question" });
  documents = updateConversationDrafts(documents, "/b.md", "messages", { node: "B question" });
  documents = updateConversationDrafts(documents, "/b.md", "references", { node: [reference] });
  documents = updateConversationDrafts(documents, "/a.md", "messages", (current) => ({ ...current, child: "Queued edit" }));
  documents = updateConversationDrafts(documents, "/a.md", "messages", (current) => {
    const next = { ...current }; delete next.node; return next;
  });
  assert.deepEqual(conversationDraftsFor(documents, "/a.md").messages, { child: "Queued edit" });
  assert.deepEqual(conversationDraftsFor(documents, "/b.md").messages, { node: "B question" });
  assert.deepEqual(conversationDraftsFor(documents, "/b.md").references, { node: [reference] });
});

test("unloaded documents do not expose or overwrite another document's draft", () => {
  const documents = updateConversationDrafts({}, "/a.md", "messages", { node: "Keep me" });
  assert.deepEqual(conversationDraftsFor(documents, null).messages, {});
  assert.equal(updateConversationDrafts(documents, null, "messages", {}), documents);
  assert.equal(conversationDraftsFor(documents, "/a.md").messages.node, "Keep me");
});
