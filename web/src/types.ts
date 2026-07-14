export type Block = {
  id: string;
  type: "paragraph" | "heading" | "list" | "code";
  content: string;
  lineStart: number;
  lineEnd: number;
  sectionTitle?: string;
  depth?: number | null;
};

export type Anchor = {
  start: number | null;
  end: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  blockId: string | null;
  contextBefore?: string | null;
  contextAfter?: string | null;
};

export type DocumentPayload = {
  path: string;
  title: string;
  content: string;
  blocks: Block[];
};

export type MarkdownFile = {
  path: string;
  relativePath: string;
  name: string;
  directory: string;
  size: number;
  modifiedAt: string;
  active: boolean;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
};

export type PermissionRequest = {
  id: string;
  sessionId: string | null;
  threadId: string | null;
  toolCallId: string | null;
  title: string;
  kind: string | null;
  status: string | null;
  rawInput: string | null;
  options: PermissionOption[];
  createdAt: string;
};

export type ThreadPosition = {
  threadId: string;
  line: number | null;
  top: number;
};

export type ThreadSpatialLayout = {
  contentHeight: number;
  viewportHeight: number;
  scrollTop: number;
  positions: Record<string, ThreadPosition>;
};

export type Thread = {
  id: string;
  acpSessionId: string | null;
  title: string;
  selectedText: string;
  anchor: Anchor;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

export type SelectionContext = {
  selectedText: string;
  anchor: Anchor;
};
