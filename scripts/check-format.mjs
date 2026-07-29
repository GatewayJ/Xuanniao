import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["server", "web/src", "scripts"];
const extensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
const failures = [];

for (const root of roots) {
  for (const filePath of await sourceFiles(root)) {
    const content = await readFile(filePath, "utf8");
    if (content && !content.endsWith("\n")) failures.push(`${filePath}: missing final newline`);
    content.split(/\r?\n/).forEach((line, index) => {
      if (/[ \t]+$/.test(line)) failures.push(`${filePath}:${index + 1}: trailing whitespace`);
      if (line.includes("\t")) failures.push(`${filePath}:${index + 1}: tab indentation`);
    });
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (extensions.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}
