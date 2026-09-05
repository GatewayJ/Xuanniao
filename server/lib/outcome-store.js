import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "./atomic-file.js";
import { documentMetadataDirFor } from "./metadata-paths.js";

const locks = new Map();
const snapshots = new Map();
export class OutcomeConflictError extends Error {
  constructor(message = "成果记录已变化，请刷新后重试。") {
    super(message);
    this.statusCode = 409;
    this.code = "OUTCOME_CONFLICT";
  }
}

export class OutcomeStore {
  constructor(documentPath, { metadataRoot } = {}) {
    this.documentPath = path.resolve(documentPath);
    this.filePath = path.join(documentMetadataDirFor(documentPath, metadataRoot), "outcomes.json");
  }

  get needsRecovery() {
    return (snapshots.get(this.filePath) || []).some((record) => record.status === "unknown" && !record.recoveryAcknowledged);
  }

  get hasPendingApplication() {
    return (snapshots.get(this.filePath) || []).some((record) => record.status === "applying");
  }

  async readState() {
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8"));
      if (data.version !== 1 || data.documentPath !== this.documentPath || !Array.isArray(data.records)
        || data.records.some((record) => !record || typeof record.id !== "string" || !Number.isSafeInteger(record.revision) || record.revision < 1)
        || new Set(data.records.map((record) => record.id)).size !== data.records.length) throw new Error("Invalid outcome store or document identity");
      const tombstones = data.tombstones ?? [];
      if (!Array.isArray(tombstones) || tombstones.some((item) => !item || typeof item.requestKey !== "string" || typeof item.requestFingerprint !== "string")
        || new Set(tombstones.map((item) => item.requestKey)).size !== tombstones.length) throw new Error("Invalid outcome request tombstones");
      snapshots.set(this.filePath, structuredClone(data.records));
      return { records: data.records, tombstones };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      snapshots.set(this.filePath, []);
      return { records: [], tombstones: [] };
    }
  }

  async read() { return (await this.readState()).records; }

  findRequest(requestKey, fingerprint) {
    return withStoreLock(this.filePath, async () => {
      const { records, tombstones } = await this.readState();
      assertNotDeleted(tombstones, requestKey, fingerprint);
      const existing = records.find((record) => record.requestKey === requestKey);
      if (existing && fingerprint !== undefined && existing.requestFingerprint !== fingerprint) throw new OutcomeConflictError("提交标识已用于不同的操作，请重新准备。");
      return existing || null;
    });
  }

  // Startup must not recreate a deleted, already-acknowledged execution from its question.
  hasRun(agentRunId) {
    if (typeof agentRunId !== "string" || !agentRunId) return Promise.resolve(false);
    return withStoreLock(this.filePath, async () => {
      const { records, tombstones } = await this.readState();
      return [...records, ...tombstones].some((item) => item.agentRunId === agentRunId || item.requestKey === agentRunId);
    });
  }

  list() {
    return withStoreLock(this.filePath, () => this.read());
  }

  async get(id) {
    const record = (await this.list()).find((item) => item.id === id);
    if (!record) { const error = new Error("成果记录不存在"); error.statusCode = 404; throw error; }
    return record;
  }

  mutate(operation) {
    return withStoreLock(this.filePath, async () => {
      const { records, tombstones } = await this.readState();
      const result = await operation(records, tombstones);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await atomicWriteText(this.filePath, JSON.stringify({ version: 1, documentPath: this.documentPath, records, tombstones }, null, 2) + "\n");
      snapshots.set(this.filePath, structuredClone(records));
      return structuredClone(result);
    });
  }

  create(fields) {
    fields = structuredClone(fields);
    if (!["proposal", "execution"].includes(fields.kind)) throw new OutcomeConflictError("未知成果类型。");
    if (fields.requestKey !== undefined) validateRequestKey(fields.requestKey);
    const fingerprint = fields.requestFingerprint || outcomeRequestFingerprint(fields.kind, fields);
    return this.mutate((records, tombstones) => {
      if (fields.requestKey) assertNotDeleted(tombstones, fields.requestKey, fingerprint);
      const existing = fields.requestKey && records.find((record) => record.requestKey === fields.requestKey);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw new OutcomeConflictError("提交标识已用于不同的操作，请重新准备并使用新的提交标识。");
        return existing;
      }
      const now = new Date().toISOString();
      const record = { ...fields, requestFingerprint: fingerprint, documentPath: this.documentPath, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
      records.unshift(record);
      return record;
    });
  }

  update(id, patch, expectedRevision = null) {
    if (typeof patch !== "function") patch = structuredClone(patch);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new OutcomeConflictError("缺少有效的成果版本，请刷新后重试。");
    return this.mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new OutcomeConflictError("成果记录已删除。");
      const record = records[index];
      if (expectedRevision !== null && record.revision !== expectedRevision) throw new OutcomeConflictError();
      const changes = typeof patch === "function" ? patch(structuredClone(record)) : patch;
      if (changes === null) return record;
      for (const key of ["id", "documentPath", "kind", "requestKey", "requestFingerprint", "createdAt"]) {
        if (Object.hasOwn(changes, key) && changes[key] !== record[key]) throw new OutcomeConflictError(`成果身份不可修改：${key}`);
      }
      records[index] = { ...record, ...changes, revision: record.revision + 1, updatedAt: new Date().toISOString() };
      return records[index];
    });
  }

  delete(id) {
    return this.mutate((records, tombstones) => {
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) {
        const record = records[index];
        if (["running", "generating", "stopping", "applying"].includes(record.status) || (record.status === "unknown" && !record.recoveryAcknowledged)) throw new OutcomeConflictError("请先完成执行或核对未知结果再删除。");
        if (records.some((item) => item.inverseOf === id && item.status === "applying")) throw new OutcomeConflictError("撤回记录正在收尾，暂不可删除。");
        if (record.requestKey && !tombstones.some((item) => item.requestKey === record.requestKey)) {
          tombstones.push({ requestKey: record.requestKey, requestFingerprint: record.requestFingerprint,
            ...(record.agentRunId ? { agentRunId: record.agentRunId } : {}) });
        }
        records.splice(index, 1);
      }
      return { deleted: index >= 0 };
    });
  }
}

function assertNotDeleted(tombstones, requestKey, fingerprint) {
  const deleted = tombstones.find((item) => item.requestKey === requestKey);
  if (!deleted) return;
  if (fingerprint !== undefined && deleted.requestFingerprint !== fingerprint) throw new OutcomeConflictError("提交标识已用于不同的操作，请使用新的提交标识。");
  throw Object.assign(new OutcomeConflictError("这次操作已处理且记录已删除；旧提交不会再次执行。请明确准备新的操作。"), { code: "OUTCOME_REQUEST_DELETED", statusCode: 410 });
}

function withStoreLock(filePath, operation) {
  const run = (locks.get(filePath) || Promise.resolve()).then(operation);
  const settled = run.catch(() => {});
  locks.set(filePath, settled);
  void settled.finally(() => { if (locks.get(filePath) === settled) locks.delete(filePath); });
  return run;
}

export function validateRequestKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 120 || key.trim() !== key) throw new OutcomeConflictError("本次操作缺少有效的提交标识。");
}

export function outcomeRequestFingerprint(kind, command) {
  const request = { kind };
  for (const key of ["documentRevision", "instruction", "source", "references", "target", "restrictions", "acceptance", "retryOf", "inverseOf", "baseRevision", "origin", "creationRequest"]) {
    if (command[key] !== undefined) request[key] = command[key];
  }
  return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}
