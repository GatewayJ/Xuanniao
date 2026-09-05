import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { atomicWriteText } from "./atomic-file.js";
import { DocumentWorkspace } from "./document-workspace.js";
import { captureReferences, locateReferenceRange, referenceRevision, MAX_REFERENCE_CHARS } from "./discussion-context.js";
import { documentMetadataDirFor, documentMetadataKey, legacyThreadStorePathFor, threadStorePathFor, xuanniaoMetadataRoot } from "./metadata-paths.js";
import { ThreadStore } from "./thread-store.js";

const indexLocks = new Map();

/** An explicit local catalog of documents with discussion data. Never crawls Markdown. */
export class ProjectWorkspace {
  constructor({ root, metadataRoot = xuanniaoMetadataRoot() }) {
    this.root = path.resolve(root);
    this.metadataRoot = path.resolve(metadataRoot);
    this.indexPath = path.join(this.metadataRoot, "projects", documentMetadataKey(this.root), "index.json");
    this.resolveDocument = this.resolveDocument.bind(this);
  }

  async registerDocument(filePath, { relink = false } = {}) {
    const resolved = this.documentPath(filePath);
    const previous = indexLocks.get(this.indexPath) || Promise.resolve();
    const run = previous.then(async () => {
      const index = await this.readIndex();
      const existing = index.documents.find((entry) => entry.path === resolved);
      // Passive discovery preserves identity even if a file disappears or a symlink moves.
      if (existing?.identity && !relink) return existing;
      const location = existing && !relink ? existing : await this.inspectPath(resolved);
      const changed = existing && existing.realPath !== location.realPath;
      const entry = existing || { path: resolved, title: path.basename(resolved), registeredAt: new Date().toISOString() };
      Object.assign(entry, {
        realPath: location.realPath, external: location.external,
        identity: changed ? randomUUID() : existing?.identity || referenceRevision(location.realPath || resolved),
        ...(changed ? { relinkedAt: new Date().toISOString() } : {})
      });
      if (!existing) index.documents.push(entry);
      await mkdir(path.dirname(this.indexPath), { recursive: true });
      await atomicWriteText(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
      return entry;
    });
    const barrier = run.catch(() => {});
    indexLocks.set(this.indexPath, barrier);
    try { return await run; }
    finally { if (indexLocks.get(this.indexPath) === barrier) indexLocks.delete(this.indexPath); }
  }

  async list() {
    await indexLocks.get(this.indexPath);
    const index = await this.readIndex();
    const documents = await Promise.all(index.documents.map(async (entry) => {
      let available = true;
      let external = entry.external;
      let unavailableReason;
      try { external = (await this.inspectPath(entry.path, entry)).external; }
      catch (error) { available = false; unavailableReason = error.message; }
      const errors = [];
      const threads = await this.threadStoreFor(entry.path).then((store) => store.list()).catch((error) => { errors.push(`讨论记录：${error.message}`); return []; });
      const records = await this.recordsFor(entry.path).catch((error) => { errors.push(`成果记录：${error.message}`); return []; });
      return { path: entry.path, title: entry.title, available, external, threads, records, ...(unavailableReason ? { unavailableReason } : {}), ...(errors.length ? { errors } : {}) };
    }));
    return { root: this.root, checkedAt: new Date().toISOString(), documents };
  }

  async preview(filePath) {
    const { document, threadStore } = await this.resolveDocument(filePath);
    const [threads, records, location] = await Promise.all([threadStore.list(), this.recordsFor(document.path), this.inspectPath(document.path)]);
    return { document, threads, records, external: location.external };
  }

  async resolveDocument(filePath) {
    const resolved = this.documentPath(filePath);
    await indexLocks.get(this.indexPath);
    const index = await this.readIndex();
    const entry = index.documents.find((item) => item.path === resolved);
    if (!entry) throw unavailable("来源文档尚未登记，请重新关联", "DOCUMENT_NOT_REGISTERED");
    await this.inspectPath(resolved, entry);
    const threadStore = await this.threadStoreFor(resolved);
    const document = { ...await new DocumentWorkspace(resolved, threadStore).payload(),
      referenceIdentity: entry.identity || referenceRevision(entry.realPath || resolved), referenceIdentityRequired: !!entry.relinkedAt };
    return { document, threadStore };
  }

  async checkReferences(references) {
    if (!Array.isArray(references) || references.length > 512) {
      const error = new Error("每次最多检查 512 项引用");
      error.statusCode = 400;
      throw error;
    }
    const checkedAt = new Date().toISOString();
    const documents = new Map();
    const results = [];
    for (const reference of references) {
      const base = { id: reference?.id, checkedAt };
      if (!reference || typeof reference.id !== "string" || typeof reference.documentPath !== "string" || !["document", "message"].includes(reference.kind)) {
        results.push({ ...base, state: "missing", reason: "invalid_reference" });
        continue;
      }
      let origin;
      try {
        const resolved = this.documentPath(reference.documentPath);
        if (!documents.has(resolved)) {
          // Cache both success and failure for a consistent check of a document's sources.
          documents.set(resolved, this.resolveDocument(resolved).then(async (value) => ({ ...value, threads: await value.threadStore.list() })).catch((error) => ({ error })));
        }
        origin = await documents.get(resolved);
        if (origin.error) throw origin.error;
      } catch (error) {
        if (!isUnavailable(error)) throw error;
        results.push({ ...base, state: "missing", reason: "document_unavailable" });
        continue;
      }
      if ((reference.sourceIdentity || origin.document.referenceIdentityRequired) && reference.sourceIdentity !== origin.document.referenceIdentity) {
        results.push({ ...base, state: "missing", reason: "document_identity_changed" });
        continue;
      }
      const source = reference.kind === "document" ? origin.document.content
        : origin.threads.find((thread) => thread.id === reference.threadId)?.messages.find((message) => message.id === reference.messageId)?.content;
      if (source === undefined) {
        results.push({ ...base, state: "missing", reason: "message_unavailable" });
        continue;
      }
      const located = locateReferenceRange(reference, source);
      const { start, end, ...status } = located;
      let latest;
      const tooLarge = Number.isInteger(start) && end - start > MAX_REFERENCE_CHARS;
      if (Number.isInteger(start) && end > start && !tooLarge) {
        [latest] = await captureReferences([{ ...reference, start, end, revision: referenceRevision(source) }], {
          document: origin.document, threadStore: { list: async () => origin.threads }
        });
      }
      results.push({ ...base, ...status, sourceRevision: referenceRevision(source), ...(latest ? { latest } : {}),
        ...(tooLarge ? { latestUnavailableReason: "reference_too_large" } : {}) });
    }
    return results;
  }

  documentPath(filePath) {
    if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
      const error = new Error("文档路径无效");
      error.statusCode = 400;
      throw error;
    }
    return path.resolve(this.root, filePath);
  }

  async inspectPath(filePath, entry) {
    const realPath = await realpath(filePath);
    if (entry?.realPath && realPath !== entry.realPath) throw unavailable("来源路径已改变，无法确定文档身份，请重新关联", "DOCUMENT_IDENTITY_CHANGED");
    if (!(await stat(filePath)).isFile()) throw unavailable("来源文档不可用", "DOCUMENT_UNAVAILABLE");
    await access(filePath, constants.R_OK);
    const projectRealPath = await realpath(this.root);
    return { realPath, external: outside(this.root, filePath) || outside(projectRealPath, realPath) };
  }

  async threadStoreFor(filePath) {
    const canonical = threadStorePathFor(filePath, this.metadataRoot);
    try { await access(canonical); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Preview may read old metadata; migration remains the active-document owner's job.
      return new ThreadStore(legacyThreadStorePathFor(filePath));
    }
    return new ThreadStore(canonical);
  }

  async recordsFor(filePath) {
    const file = path.join(documentMetadataDirFor(filePath, this.metadataRoot), "outcomes.json");
    let raw;
    try { raw = await readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const data = JSON.parse(raw);
    if (data.version !== 1 || data.documentPath !== filePath || !Array.isArray(data.records)) throw new Error("成果记录格式或文档身份不匹配");
    return data.records;
  }

  async readIndex() {
    let raw;
    try { raw = await readFile(this.indexPath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { version: 1, root: this.root, documents: [] }; throw error; }
    const data = JSON.parse(raw);
    if (data.version !== 1 || data.root !== this.root || !Array.isArray(data.documents)
      || data.documents.some((entry) => !entry || typeof entry.path !== "string" || !path.isAbsolute(entry.path))) {
      throw new Error("项目索引格式或根目录不匹配");
    }
    return data;
  }
}

function outside(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function unavailable(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 404;
  return error;
}

function isUnavailable(error) {
  return error.statusCode === 404 || ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code);
}
