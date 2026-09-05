import type { OutcomeRecord } from "./types";

export type NewDocumentCommand = {
  instruction: string;
  directory: string | null;
  fileName: string | null;
};

export type DocumentCreationRetry = {
  recordId: string;
  documentPath: string;
  command: NewDocumentCommand;
  previousResult: string;
  createdPath?: string;
};

export function prepareDocumentCreationRetry(record: OutcomeRecord, currentPath: string | null): DocumentCreationRetry {
  if (record.origin !== "document-creation" || !record.creationRequest?.instruction.trim()) throw new Error("原始创建要求不可用，请重新准备创建文档。");
  if (!["completed", "failed", "interrupted", "unknown"].includes(record.status) || (record.status === "unknown" && !record.recoveryAcknowledged)) throw new Error("请先核对前次创建的文件和原进程，再重新创建。");
  if (record.documentPath !== currentPath) throw new Error("请先打开前次创建的来源文档，再重新准备。");
  return {
    recordId: record.id, documentPath: record.documentPath,
    command: { instruction: record.creationRequest.instruction, directory: record.creationRequest.directory || null, fileName: record.creationRequest.fileName || null },
    createdPath: record.newDocumentPath || record.creationResult?.path,
    previousResult: record.result || record.error || "前次没有保存输出，请核对已创建的文件与运行记录。"
  };
}

/** The returned request keeps the originating path even after creation opens a different file. */
export function documentCreationCommand(command: NewDocumentCommand, currentPath: string | null, retry: DocumentCreationRetry | null = null) {
  if (!currentPath) throw new Error("来源文档尚未加载，创建尚未开始。");
  if (retry && retry.documentPath !== currentPath) throw new Error("活动文档已切换，请回到前次创建的来源文档后再提交。");
  return { ...command, documentPath: retry?.documentPath || currentPath, ...(retry ? { retryOf: retry.recordId } : {}) };
}
