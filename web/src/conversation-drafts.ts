import type { ReferenceSnapshot } from "./types";

export type ConversationDrafts = {
  messages: Record<string, string>;
  references: Record<string, ReferenceSnapshot[]>;
  errors: Record<string, string>;
};
export type DocumentConversationDrafts = Record<string, ConversationDrafts>;

const emptyDrafts: ConversationDrafts = { messages: {}, references: {}, errors: {} };

export function conversationDraftsFor(documents: DocumentConversationDrafts, path: string | null): ConversationDrafts {
  return path ? documents[path] || emptyDrafts : emptyDrafts;
}

/** Updates remain bound to the originating document, including queued React updates. */
export function updateConversationDrafts<K extends keyof ConversationDrafts>(
  documents: DocumentConversationDrafts,
  path: string | null,
  field: K,
  update: ConversationDrafts[K] | ((current: ConversationDrafts[K]) => ConversationDrafts[K])
): DocumentConversationDrafts {
  if (!path) return documents;
  const current = conversationDraftsFor(documents, path);
  const value = typeof update === "function" ? update(current[field]) : update;
  if (value === current[field]) return documents;
  return { ...documents, [path]: { ...current, [field]: value } };
}
