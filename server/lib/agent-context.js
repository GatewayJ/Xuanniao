import { createHash } from "node:crypto";

const maxIncrementalChangeLength = 12_000;
const changeContextLength = 320;
export const defaultAgentContextMaxChars = 1_500_000;

export const AGENT_DEVELOPER_INSTRUCTIONS = [
  "You are Codex collaborating with the user in Xuanniao, a local Markdown plan document workspace.",
  "Treat the supplied Markdown document snapshot and the selected conversation branch as authoritative context.",
  "Do not infer context from sibling conversation branches.",
  "Do not modify the active Markdown document with filesystem tools. Xuanniao owns writes to that document so it can enforce revision checks and keep anchors consistent.",
  "For normal chat replies, return Markdown-compatible plain text. Use fenced code blocks for code, XML, JSON, logs, and protocol examples.",
  "When the user explicitly requests a controlled selection replacement, return only the replacement Markdown wrapped in <XUANNIAO_REPLACEMENT> and </XUANNIAO_REPLACEMENT>."
].join("\n");

export function documentHash(content) {
  return createHash("sha256")
    .update(String(content ?? ""))
    .digest("hex");
}

export function buildAgentPrompt({
  question,
  document,
  thread,
  mode = "chat",
  accessMode = "full-access",
  includeDocument = true,
  includeHistory = true,
  history = thread.messages || [],
  previousDocument = null,
  maxChars = defaultAgentContextMaxChars
}) {
  const sections = [
    `Document path: ${document.path}`,
    `Document title: ${document.title}`,
    "",
    accessMode === "read-only"
      ? "Runtime policy: read-only. Inspect as needed, but do not perform mutating operations."
      : "Runtime policy: full access. Follow the runtime approval policy for operations that require confirmation."
  ];

  if (includeDocument) {
    sections.push("", ...buildDocumentSection(document.content || "", previousDocument));
  } else {
    sections.push("", "The document content is unchanged from the snapshot already present in this agent session.");
  }

  sections.push("", "Selected document text:", thread.selectedText || "(no selection)", "", "Selection anchor:", JSON.stringify(thread.anchor || {}));

  if (includeHistory) {
    sections.push(
      "",
      "Conversation history required to reconstruct this branch:",
      "<XUANNIAO_BRANCH_HISTORY>",
      formatHistory(history),
      "</XUANNIAO_BRANCH_HISTORY>"
    );
  }

  if (thread.branchSelection?.text) {
    sections.push(
      "",
      "Selected excerpt from the current conversation context:",
      "Treat this excerpt as the specific subject of the current user question.",
      "<XUANNIAO_BRANCH_SELECTION>",
      thread.branchSelection.text,
      "</XUANNIAO_BRANCH_SELECTION>"
    );
  }

  sections.push("", "Current user question:", question);

  if (mode === "replace-selection") {
    sections.push(
      "",
      "Return only the replacement Markdown for the selected document text, wrapped exactly like this:",
      "<XUANNIAO_REPLACEMENT>",
      "replacement markdown here",
      "</XUANNIAO_REPLACEMENT>",
      "",
      "Do not include an explanation, diff markers, or surrounding document text."
    );
  }

  const prompt = sections.join("\n");
  if (prompt.length > maxChars) {
    throw new AgentContextLimitError(prompt.length, maxChars);
  }
  return prompt;
}

export class AgentContextLimitError extends Error {
  constructor(actualChars, maxChars) {
    super(
      `Agent context is too large (${actualChars} characters; limit ${maxChars}). ` +
        "Narrow the document or branch before retrying; Xuanniao will not silently drop context."
    );
    this.name = "AgentContextLimitError";
    this.code = "AGENT_CONTEXT_TOO_LARGE";
    this.actualChars = actualChars;
    this.maxChars = maxChars;
  }
}

export class DocumentSnapshotCache {
  constructor(maxEntries = 32) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("DocumentSnapshotCache maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return this;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

function buildDocumentSection(content, previousDocument) {
  if (typeof previousDocument !== "string") {
    return ["Complete document snapshot:", "<XUANNIAO_DOCUMENT>", content, "</XUANNIAO_DOCUMENT>"];
  }

  const change = documentChange(previousDocument, content);
  if (!change || change.removed.length + change.inserted.length > maxIncrementalChangeLength) {
    return [
      "The document changed substantially. Replace the prior session snapshot with this complete snapshot:",
      "<XUANNIAO_DOCUMENT>",
      content,
      "</XUANNIAO_DOCUMENT>"
    ];
  }

  return [
    "The document changed since the prior turn. Apply this exact character splice to the cached snapshot:",
    "<XUANNIAO_DOCUMENT_CHANGE>",
    `startOffset: ${change.start}`,
    `removedCharacterCount: ${change.removed.length}`,
    "contextBefore:",
    change.contextBefore,
    "removedText:",
    change.removed,
    "insertedText:",
    change.inserted,
    "contextAfter:",
    change.contextAfter,
    "</XUANNIAO_DOCUMENT_CHANGE>"
  ];
}

function documentChange(previous, current) {
  if (previous === current) return null;

  let prefixLength = 0;
  const sharedLength = Math.min(previous.length, current.length);
  while (prefixLength < sharedLength && previous[prefixLength] === current[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (suffixLength < sharedLength - prefixLength && previous[previous.length - suffixLength - 1] === current[current.length - suffixLength - 1]) {
    suffixLength += 1;
  }

  return {
    start: prefixLength,
    removed: previous.slice(prefixLength, previous.length - suffixLength),
    inserted: current.slice(prefixLength, current.length - suffixLength),
    contextBefore: current.slice(Math.max(0, prefixLength - changeContextLength), prefixLength),
    contextAfter: current.slice(current.length - suffixLength, current.length - suffixLength + changeContextLength)
  };
}

function formatHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "(new branch)";
  }
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      return `<message role="${role}">\n${message.content || ""}\n</message>`;
    })
    .join("\n\n");
}
