import { createContext, useContext } from "react";
import type { DocumentPayload, Message, OutcomeRecord, ReferenceSnapshot, Thread } from "../types";

export type DiscussionWorkspaceActions = {
  adopt(thread: Thread, message: Message, text?: string): void;
  execute(thread: Thread, message: Message, text?: string): void;
  referenceTo(thread: Thread, message: Message, text?: string): void;
  reevaluate(thread: Thread, message: Message, references: ReferenceSnapshot[]): void;
  previewReference?(reference: ReferenceSnapshot): void;
  onReevaluate?: (references: ReferenceSnapshot[]) => void;
  openResults(threadId?: string, messageId?: string): void;
  openProject?(): void;
  onDiscussionVisibilityChange?(open: boolean): void;
  activityLabel?: string;
  stop(): void;
  canStop?: boolean;
  reanchor?(thread: Thread): void;
  busy: boolean;
  records: OutcomeRecord[];
  references: ReferenceSnapshot[];
  citations?: import("../project-api").IncomingCitation[];
  document: DocumentPayload | null;
  navigation?: { threadId: string; nodeId: string | null; nonce: number; reference?: ReferenceSnapshot; focusComposer?: boolean };
};
export type DiscussionWorkspaceValue = DiscussionWorkspaceActions;
export const DiscussionWorkspaceContext = createContext<DiscussionWorkspaceActions | null>(null);
export const useDiscussionWorkspace = () => useContext(DiscussionWorkspaceContext);

export function locateReferenceSource(reference: ReferenceSnapshot, documentPath: string | undefined, actions: {
  preview(reference: ReferenceSnapshot): void; locate(reference: ReferenceSnapshot): void;
}) {
  if (reference.documentPath !== documentPath) actions.preview(reference);
  else actions.locate(reference);
}
