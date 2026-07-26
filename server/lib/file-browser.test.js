import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { browseMarkdownDirectory } from "./file-browser.js";

test("browses directories and Markdown files while selecting a requested file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xuanniao-browser-"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "README.md"), "# Readme\n", "utf8");
  await writeFile(path.join(root, "notes.txt"), "ignored\n", "utf8");

  const directory = await browseMarkdownDirectory(root, root);
  assert.deepEqual(directory.entries.map(({ name, kind }) => ({ name, kind })), [
    { name: "docs", kind: "directory" },
    { name: "README.md", kind: "file" }
  ]);

  const selected = await browseMarkdownDirectory(path.join(root, "README.md"), root);
  assert.equal(selected.directory, root);
  assert.equal(selected.selectedPath, path.join(root, "README.md"));
});
