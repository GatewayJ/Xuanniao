import type { DocumentSessionOperation } from "./document-session-scope.ts";

export type ScopedSaveOutcome<T> =
  | { status: "saved"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "stale" };

type ScopedSaveOptions<T> = {
  previous: Promise<unknown>;
  operation: DocumentSessionOperation;
  isCurrent: (operation: DocumentSessionOperation) => boolean;
  persist: () => Promise<T>;
};

export async function executeScopedSave<T>({
  previous,
  operation,
  isCurrent,
  persist
}: ScopedSaveOptions<T>): Promise<ScopedSaveOutcome<T>> {
  try {
    await previous;
  } catch {
    // A newer save may still recover after the preceding attempt failed.
  }
  if (!isCurrent(operation)) return { status: "stale" };

  try {
    const value = await persist();
    return isCurrent(operation) ? { status: "saved", value } : { status: "stale" };
  } catch (error) {
    return isCurrent(operation) ? { status: "failed", error } : { status: "stale" };
  }
}
