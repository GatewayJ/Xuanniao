import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const markdownExtensions = new Set([".md", ".markdown", ".mdown", ".mkdn"]);
const ignoredDirectories = new Set(["node_modules", "dist"]);

export async function browseMarkdownDirectory(targetPath, basePath) {
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(basePath, targetPath);
  const targetInfo = await stat(resolvedTarget);
  const selectedPath = targetInfo.isFile() ? resolvedTarget : null;

  if (selectedPath && !isMarkdownPath(selectedPath)) {
    throw new Error("only Markdown files can be opened");
  }

  const directory = targetInfo.isDirectory() ? resolvedTarget : path.dirname(resolvedTarget);
  const children = await readdir(directory, { withFileTypes: true });
  const visibleChildren = children.filter((entry) => (
    !entry.name.startsWith(".") && !(entry.isDirectory() && ignoredDirectories.has(entry.name))
  ));
  const entries = (await Promise.all(visibleChildren.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return {
        path: entryPath,
        name: entry.name,
        kind: "directory",
        size: null,
        modifiedAt: null
      };
    }
    if (!entry.isFile() || !isMarkdownPath(entry.name)) {
      return null;
    }
    const info = await stat(entryPath);
    return {
      path: entryPath,
      name: entry.name,
      kind: "file",
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    };
  }))).filter(Boolean);

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  const parent = path.dirname(directory);
  return {
    directory,
    parent: parent === directory ? null : parent,
    selectedPath,
    entries
  };
}

function isMarkdownPath(filePath) {
  return markdownExtensions.has(path.extname(filePath).toLowerCase());
}
