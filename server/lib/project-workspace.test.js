import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureReferences, referenceRevision } from "./discussion-context.js";
import { documentMetadataDirFor, threadStorePathFor } from "./metadata-paths.js";
import { ProjectWorkspace } from "./project-workspace.js";
import { ThreadStore } from "./thread-store.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-project-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  const metadataRoot = path.join(dir, "metadata");
  await mkdir(root);
  const first = path.join(root, "plan.md");
  const second = path.join(root, "decision.md");
  await writeFile(first, "# Plan\n\nbefore QUOTE after\n");
  await writeFile(second, "# Decision\n\nOriginal decision\n");
  return { dir, root, metadataRoot, first, second, project: new ProjectWorkspace({ root, metadataRoot }) };
}

async function savedDiscussion(file, metadataRoot) {
  const store = new ThreadStore(threadStorePathFor(file, metadataRoot));
  const thread = await store.create({ title: "Discussion", selectedText: "Plan", anchor: { start: 2, end: 6 } });
  const message = await store.addMessage(thread.id, { role: "user", content: "Original question" });
  const source = { kind: "message", threadId: thread.id, messageId: message.id, documentPath: file, start: 0, end: message.content.length, revision: referenceRevision(message.content) };
  return { store, thread, message, source };
}

test("catalog is explicit, persistent, metadata-only and includes recorded outcomes without inferring tasks", async (t) => {
  const { project, root, metadataRoot, first, second } = await fixture(t);
  const original = await readFile(first, "utf8");
  const { source } = await savedDiscussion(first, metadataRoot);
  const records = [{ id: "p1", kind: "proposal", status: "review", documentPath: first, title: "A real proposal", source }];
  await writeFile(path.join(documentMetadataDirFor(first, metadataRoot), "outcomes.json"), JSON.stringify({ version: 1, documentPath: first, records }));
  await savedDiscussion(second, metadataRoot);
  assert.deepEqual((await project.list()).documents, []);
  await project.registerDocument(first);
  const reloaded = new ProjectWorkspace({ root, metadataRoot });
  const listing = await reloaded.list();
  assert.equal(listing.root, root);
  assert.ok(Date.parse(listing.checkedAt));
  assert.equal(listing.documents.length, 1);
  assert.equal(listing.documents[0].available, true);
  assert.equal(listing.documents[0].external, false);
  assert.equal(listing.documents[0].threads.length, 1);
  assert.deepEqual(listing.documents[0].records, records);
  assert.equal(await readFile(first, "utf8"), original);
  await assert.rejects(project.preview(second), { code: "DOCUMENT_NOT_REGISTERED" });
  const preview = await project.preview(first);
  assert.equal(preview.document.content, original);
  assert.deepEqual(preview.records, records);
  assert.deepEqual(preview.threads, listing.documents[0].threads);
});

test("concurrent registrations across instances merge without duplicate or lost documents", async (t) => {
  const { project, root, metadataRoot, first, second } = await fixture(t);
  const other = new ProjectWorkspace({ root, metadataRoot });
  await Promise.all([project.registerDocument(first), other.registerDocument(second), other.registerDocument(first)]);
  assert.deepEqual((await project.list()).documents.map((item) => item.path).sort(), [first, second].sort());
});

test("deleted and renamed files retain indexed history and never resolve a same-named file elsewhere", async (t) => {
  const { project, root, metadataRoot, first } = await fixture(t);
  const { source } = await savedDiscussion(first, metadataRoot);
  await project.registerDocument(first);
  const origin = await project.resolveDocument(first);
  const [reference] = await captureReferences([source], origin);
  const before = structuredClone(reference);
  const movedDirectory = path.join(root, "moved");
  await mkdir(movedDirectory);
  await rename(first, path.join(movedDirectory, "plan.md"));
  await project.registerDocument(first);
  const listing = await project.list();
  assert.equal(listing.documents.length, 1);
  assert.equal(listing.documents[0].available, false);
  assert.equal(listing.documents[0].threads.length, 1);
  assert.equal(listing.documents[0].path, first);
  const [check] = await project.checkReferences([reference]);
  assert.equal(check.state, "missing");
  assert.equal(check.latest, undefined);
  assert.deepEqual(reference, before);
  await assert.rejects(project.preview(first), { code: "ENOENT" });
});

test("project-external and symlinked sources are labelled, and retargeted symlinks are not silently followed", async (t) => {
  const { dir, root, project, second } = await fixture(t);
  const external = path.join(dir, "external.md");
  await writeFile(external, "# Outside\n");
  const link = path.join(root, "linked.md");
  await symlink(external, link);
  await project.registerDocument(external);
  await project.registerDocument(link);
  assert.equal((await project.list()).documents.every((item) => item.external), true);
  assert.equal((await project.preview(link)).external, true);
  await rm(link);
  await symlink(second, link);
  await assert.rejects(project.resolveDocument(link), { code: "DOCUMENT_IDENTITY_CHANGED" });
  assert.equal((await project.list()).documents.find((item) => item.path === link).available, false);
});

test("reference checks distinguish source edits, relocated excerpts, deletion and legacy revisions without rewriting snapshots", async (t) => {
  const { project, first, second, metadataRoot } = await fixture(t);
  const { source, store, thread } = await savedDiscussion(second, metadataRoot);
  await project.registerDocument(first);
  await project.registerDocument(second);
  const origin = await project.resolveDocument(first);
  const content = origin.document.content;
  const start = content.indexOf("QUOTE");
  const [excerpt, full, message] = await captureReferences([
    { kind: "document", start, end: start + 5, revision: referenceRevision(content) },
    { kind: "document", start: 0, end: content.length, revision: referenceRevision(content) },
    source
  ], { ...origin, resolveDocument: project.resolveDocument });
  const { sourceScope, contextBefore, contextAfter, ...legacy } = excerpt;
  legacy.id = "legacy";
  const snapshots = [excerpt, full, legacy, message];
  const before = structuredClone(snapshots);
  assert.equal((await project.checkReferences(snapshots)).every((check) => check.state === "current"), true);
  await writeFile(first, `Inserted prefix\n${content}`);
  let checks = await project.checkReferences(snapshots);
  assert.equal(checks[0].state, "current");
  assert.equal(checks[0].relocated, true);
  assert.equal(checks[0].latest.content, excerpt.content);
  assert.equal(checks[0].latest.start, excerpt.start + "Inserted prefix\n".length);
  assert.equal(checks[1].state, "changed");
  assert.equal(checks[2].state, "current");
  assert.equal(checks[3].state, "current");
  await writeFile(first, content.replace("QUOTE", "NEW TEXT"));
  checks = await project.checkReferences(snapshots);
  assert.equal(checks[0].state, "changed");
  assert.equal(checks[0].latest.content, "NEW TEXT");
  assert.equal(checks[2].state, "changed");
  assert.equal(checks[2].latest, undefined);
  await store.delete(thread.id);
  assert.equal((await project.checkReferences([message]))[0].state, "missing");
  await writeFile(first, "");
  const [empty] = await project.checkReferences([full]);
  assert.equal(empty.state, "changed");
  assert.equal(empty.latest, undefined);
  assert.ok(empty.sourceRevision);
  assert.equal((await project.checkReferences([{ ...excerpt, contextBefore: null }]))[0].reason, "invalid_reference");
  assert.deepEqual(snapshots, before);
});

test("metadata errors are explicit and cannot erase or misattribute historical records", async (t) => {
  const { project, first, second, metadataRoot } = await fixture(t);
  await project.registerDocument(first);
  await savedDiscussion(first, metadataRoot);
  await writeFile(path.join(documentMetadataDirFor(first, metadataRoot), "outcomes.json"), JSON.stringify({ version: 1, documentPath: second, records: [{ id: "foreign" }] }));
  const listing = await project.list();
  assert.deepEqual(listing.documents[0].records, []);
  assert.match(listing.documents[0].errors[0], /文档身份不匹配/);
  await writeFile(project.indexPath, "not json");
  await assert.rejects(project.registerDocument(second), SyntaxError);
  assert.equal(await readFile(project.indexPath, "utf8"), "not json");
});

test("checking a source that grew beyond the send budget preserves the rest of the batch", async (t) => {
  const { project, first, second } = await fixture(t);
  await project.registerDocument(first);
  await project.registerDocument(second);
  const origin = await project.resolveDocument(first);
  const [reference] = await captureReferences([{ kind: "document", start: 0, end: origin.document.content.length, revision: origin.document.revision }], origin);
  const other = await project.resolveDocument(second);
  const [unchanged] = await captureReferences([{ kind: "document", start: 0, end: other.document.content.length, revision: other.document.revision }], other);
  const grown = "x".repeat(160_001);
  await writeFile(first, grown);
  const before = structuredClone(reference);
  const [changed, current] = await project.checkReferences([reference, unchanged]);
  assert.equal(changed.state, "changed");
  assert.equal(changed.sourceRevision, referenceRevision(grown));
  assert.equal(changed.latest, undefined);
  assert.equal(changed.latestUnavailableReason, "reference_too_large");
  assert.equal(current.state, "current");
  assert.deepEqual(reference, before);
  const updated = await project.resolveDocument(first);
  await assert.rejects(captureReferences([{ ...reference, end: grown.length, revision: updated.document.revision }], updated), /160,000/);
});

test("explicit relinking restores preview without moving old references to a different file", async (t) => {
  const { project, root, metadataRoot, first, second } = await fixture(t);
  // Equal content ensures the document identity, rather than a content hash, protects history.
  await writeFile(second, await readFile(first, "utf8"));
  const link = path.join(root, "linked.md");
  await symlink(first, link);
  const initial = await project.registerDocument(link);
  const origin = await project.resolveDocument(link);
  const [reference] = await captureReferences([{ kind: "document", start: 0, end: origin.document.content.length, revision: origin.document.revision }], origin);
  const legacy = { ...reference, id: "legacy" };
  delete legacy.sourceIdentity;
  await rm(link);
  await symlink(second, link);
  assert.equal((await project.registerDocument(link)).identity, initial.identity);
  await assert.rejects(project.preview(link), { code: "DOCUMENT_IDENTITY_CHANGED" });
  const relinked = await project.registerDocument(link, { relink: true });
  assert.notEqual(relinked.identity, initial.identity);
  const reloaded = new ProjectWorkspace({ root, metadataRoot });
  const preview = await reloaded.preview(link);
  assert.equal(preview.document.content, origin.document.content);
  assert.equal(preview.document.referenceIdentity, relinked.identity);
  const checks = await reloaded.checkReferences([reference, legacy]);
  assert.equal(checks.every((check) => check.state === "missing" && check.reason === "document_identity_changed"), true);
  const current = await reloaded.resolveDocument(link);
  await assert.rejects(captureReferences([reference], current), /身份已变化/);
  await assert.rejects(captureReferences([legacy], current), /身份已变化/);
  const [newReference] = await captureReferences([{ ...reference, sourceIdentity: relinked.identity }], current);
  assert.notEqual(newReference.id, reference.id);
  assert.equal((await reloaded.checkReferences([newReference]))[0].state, "current");
});

test("default metadata root honors isolated XUANNIAO_DATA_DIR and keeps project catalogs separate", async (t) => {
  const { root, metadataRoot, first, dir } = await fixture(t);
  const previous = process.env.XUANNIAO_DATA_DIR;
  process.env.XUANNIAO_DATA_DIR = metadataRoot;
  try {
    const project = new ProjectWorkspace({ root });
    assert.equal(project.metadataRoot, metadataRoot);
    await project.registerDocument(first);
    assert.equal((await new ProjectWorkspace({ root }).list()).documents.length, 1);
    assert.deepEqual((await new ProjectWorkspace({ root: dir }).list()).documents, []);
  } finally {
    if (previous === undefined) delete process.env.XUANNIAO_DATA_DIR;
    else process.env.XUANNIAO_DATA_DIR = previous;
  }
});
