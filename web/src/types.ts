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

export type Thread = {
  id: string;
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
