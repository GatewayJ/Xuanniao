import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function xuanniaoMetadataRoot() {
  return path.join(os.homedir(), "xuanniao");
}

export function documentMetadataKey(filePath) {
  return createHash("sha256").update(path.resolve(filePath)).digest("hex");
}

export function documentMetadataDirFor(filePath, root = xuanniaoMetadataRoot()) {
  return path.join(root, documentMetadataKey(filePath));
}

export function threadStorePathFor(filePath, root = xuanniaoMetadataRoot()) {
  return path.join(documentMetadataDirFor(filePath, root), "threads.json");
}

export function legacyThreadStorePathFor(filePath) {
  return path.join(path.dirname(filePath), ".xuanniao", `${path.basename(filePath)}.threads.json`);
}
