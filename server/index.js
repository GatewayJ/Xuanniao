import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { AcpDocumentAgent, parseCommandLine } from "./lib/acp-client.js";
import { buildBlockIndex } from "./lib/block-index.js";
import { ThreadStore } from "./lib/thread-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, "..");
const webRoot = path.join(projectRoot, "web");
const webDistRoot = path.join(webRoot, "dist");

const args = parseArgs(process.argv.slice(2));
const workspaceRoot = process.cwd();
const host = args.host ?? process.env.HOST ?? "127.0.0.1";
const port = Number(args.port ?? process.env.PORT ?? 4173);
const maxBodyBytes = 8 * 1024 * 1024;
const ignoredFileManagerDirs = new Set([".git", "node_modules", "dist", ".xuanniao"]);

let documentPath = path.resolve(workspaceRoot, args.file ?? "prd.md");
await ensureDocument(documentPath);

let threadStore = new ThreadStore(sidecarPathFor(documentPath));
let agent = createAgentFor(documentPath);
await agent.start();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        documentPath,
        workspaceRoot,
        acp: agent.status()
      });
    }

    if (url.pathname === "/api/files" && req.method === "GET") {
      return sendJson(res, 200, {
        root: workspaceRoot,
        currentPath: documentPath,
        files: await listMarkdownFiles()
      });
    }

    if (url.pathname === "/api/files/pick" && req.method === "POST") {
      const body = await readJson(req);
      const pickedPath = await pickMarkdownFile(String(body.startPath || documentPath));
      return sendJson(res, 200, {
        path: pickedPath,
        canceled: !pickedPath
      });
    }

    if (url.pathname === "/api/document" && req.method === "GET") {
      return sendJson(res, 200, await readDocumentPayload());
    }

    if (url.pathname === "/api/document/open" && req.method === "POST") {
      const body = await readJson(req);
      const nextPath = resolveMarkdownPath(String(body.path || ""));
      if (!existsSync(nextPath)) {
        return sendJson(res, 404, { error: `Markdown file not found: ${nextPath}` });
      }
      await switchDocument(nextPath);
      return sendJson(res, 200, {
        document: await readDocumentPayload(),
        threads: await threadStore.list(),
        files: await listMarkdownFiles()
      });
    }

    if (url.pathname === "/api/document" && req.method === "PUT") {
      const body = await readJson(req);
      if (typeof body.content !== "string") {
        return sendJson(res, 400, { error: "content must be a string" });
      }
      await writeFile(documentPath, body.content, "utf8");
      return sendJson(res, 200, await readDocumentPayload());
    }

    if (url.pathname === "/api/threads" && req.method === "GET") {
      return sendJson(res, 200, { threads: await threadStore.list() });
    }

    if (url.pathname === "/api/threads" && req.method === "POST") {
      const body = await readJson(req);
      const thread = await threadStore.create({
        title: String(body.title || body.selectedText || "Untitled thread").slice(0, 120),
        selectedText: String(body.selectedText || ""),
        anchor: normalizeAnchor(body.anchor)
      });
      return sendJson(res, 201, { thread });
    }

    if (url.pathname === "/api/threads/anchors" && req.method === "PUT") {
      const body = await readJson(req);
      const patches = Array.isArray(body.threads) ? body.threads.map(normalizeThreadAnchorPatch).filter((patch) => patch.id) : [];
      const threads = await threadStore.updateAnchors(patches);
      return sendJson(res, 200, { threads });
    }

    if (url.pathname === "/api/permissions" && req.method === "GET") {
      return sendJson(res, 200, { requests: agent.listPermissionRequests() });
    }

    const permissionMatch = url.pathname.match(/^\/api\/permissions\/([^/]+)\/resolve$/);
    if (permissionMatch && req.method === "POST") {
      const permissionId = decodeURIComponent(permissionMatch[1]);
      const body = await readJson(req);
      agent.resolvePermissionRequest(permissionId, {
        optionId: typeof body.optionId === "string" ? body.optionId : "",
        cancelled: body.cancelled === true
      });
      return sendJson(res, 200, { requests: agent.listPermissionRequests() });
    }

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (threadMatch && req.method === "DELETE") {
      const threadId = decodeURIComponent(threadMatch[1]);
      await threadStore.delete(threadId);
      return sendJson(res, 200, { threads: await threadStore.list() });
    }

    const messageMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
    if (messageMatch && req.method === "POST") {
      const threadId = decodeURIComponent(messageMatch[1]);
      const body = await readJson(req);
      const content = String(body.content || "").trim();
      if (!content) {
        return sendJson(res, 400, { error: "message content is required" });
      }

      const userMessage = await threadStore.addMessage(threadId, {
        role: "user",
        content
      });

      if (body.askAgent === false) {
        return sendJson(res, 200, {
          userMessage,
          assistantMessage: null,
          threads: await threadStore.list()
        });
      }

      const { assistantMessage, updatedDocument } = await createAssistantReply(threadId, content, (message) => threadStore.addMessage(threadId, message));

      return sendJson(res, 200, {
        userMessage,
        assistantMessage,
        threads: await threadStore.list(),
        document: updatedDocument
      });
    }

    const messageUpdateMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages\/([^/]+)$/);
    if (messageUpdateMatch && req.method === "DELETE") {
      const threadId = decodeURIComponent(messageUpdateMatch[1]);
      const messageId = decodeURIComponent(messageUpdateMatch[2]);
      await threadStore.deleteMessage(threadId, messageId);
      return sendJson(res, 200, { threads: await threadStore.list() });
    }

    if (messageUpdateMatch && req.method === "PUT") {
      const threadId = decodeURIComponent(messageUpdateMatch[1]);
      const messageId = decodeURIComponent(messageUpdateMatch[2]);
      const body = await readJson(req);
      const content = String(body.content || "").trim();
      if (!content) {
        return sendJson(res, 400, { error: "message content is required" });
      }
      const shouldRerunAgent = body.rerunAgent === true || await threadStore.hasAssistantAfter(threadId, messageId);
      const message = await threadStore.updateMessage(threadId, messageId, { content });
      let assistantMessage = null;
      let updatedDocument = null;
      if (shouldRerunAgent) {
        await threadStore.removeAssistantAfter(threadId, messageId);
        const reply = await createAssistantReply(threadId, content, (assistant) => threadStore.addMessageAfter(threadId, messageId, assistant));
        assistantMessage = reply.assistantMessage;
        updatedDocument = reply.updatedDocument;
      }
      return sendJson(res, 200, {
        message,
        assistantMessage,
        threads: await threadStore.list(),
        document: updatedDocument
      });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 500, { error: message });
  }
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Xuanniao serving ${documentPath}`);
  console.log(`Open ${url}`);
  console.log(`Agent mode: ${agent.accessMode}`);
  console.log(`ACP command: ${parseCommandLine(agent.commandLine).join(" ")}`);
});

function createAgentFor(filePath) {
  return new AcpDocumentAgent({
    documentPath: filePath,
    cwd: path.dirname(filePath),
    commandLine: process.env.XUANNIAO_ACP_CMD ?? "codex-acp",
    accessMode: process.env.XUANNIAO_AGENT_MODE ?? "full-access",
    timeoutMs: Number(process.env.XUANNIAO_ACP_TIMEOUT_MS ?? 180000)
  });
}

async function switchDocument(nextPath) {
  const resolved = path.resolve(nextPath);
  if (resolved === documentPath) {
    return;
  }
  const nextAgent = createAgentFor(resolved);
  await nextAgent.start();
  agent.dispose();
  documentPath = resolved;
  threadStore = new ThreadStore(sidecarPathFor(documentPath));
  agent = nextAgent;
}

async function readDocumentPayload() {
  const content = await readFile(documentPath, "utf8");
  return {
    path: documentPath,
    title: path.basename(documentPath),
    content,
    blocks: buildBlockIndex(content)
  };
}

async function createAssistantReply(threadId, content, saveAssistantMessage) {
  let updatedDocument = null;
  let assistantMessage;
  try {
    const document = await readDocumentPayload();
    const thread = await threadStore.get(threadId);
    const editRequested = process.env.XUANNIAO_CONTROLLED_REPLACEMENT === "1" && wantsDocumentEdit(content) && canReplaceSelection(thread);
    const answer = await agent.prompt({
      question: content,
      document,
      thread,
      mode: editRequested ? "replace-selection" : "chat",
      onSessionId: (acpSessionId) => threadStore.updateThread(threadId, { acpSessionId })
    });

    if (editRequested) {
      const replacement = extractReplacement(answer.content);
      if (replacement === null) {
        throw new Error("Codex did not return a Xuanniao replacement block for the selected text.");
      }

      const edit = applySelectionReplacement(document.content, thread, replacement);
      await writeFile(documentPath, edit.content, "utf8");
      updatedDocument = await readDocumentPayload();
      await threadStore.updateThread(threadId, {
        selectedText: replacement,
        anchor: {
          ...thread.anchor,
          start: edit.start,
          end: edit.start + replacement.length,
          lineStart: lineNumberAt(edit.content, edit.start),
          lineEnd: lineNumberAt(edit.content, edit.start + replacement.length),
          blockId: null
        }
      });
      answer.content = [
        "Applied this replacement to the document:",
        "",
        "```md",
        replacement,
        "```"
      ].join("\n");
      answer.appliedEdit = true;
    }

    if (!updatedDocument) {
      const latestDocument = await readDocumentPayload();
      if (latestDocument.content !== document.content) {
        updatedDocument = latestDocument;
      }
    }

    assistantMessage = await saveAssistantMessage({
      role: "assistant",
      content: answer.content,
      meta: {
        stopReason: answer.stopReason,
        transport: answer.transport,
        appliedEdit: Boolean(answer.appliedEdit),
        updates: answer.updates
      }
    });
  } catch (error) {
    assistantMessage = await saveAssistantMessage({
      role: "assistant",
      content: [
        "Codex request failed.",
        "",
        error instanceof Error ? error.message : String(error),
        "",
        "Install codex-acp or set XUANNIAO_ACP_CMD to an ACP-compatible Codex adapter:",
        "",
        "```bash",
        "npm install -g @agentclientprotocol/codex-acp",
        "XUANNIAO_ACP_CMD=\"/path/to/codex-acp\" npm start -- prd.md",
        "```"
      ].join("\n"),
      error: true
    });
  }
  return { assistantMessage, updatedDocument };
}

async function listMarkdownFiles() {
  const files = [];
  await collectMarkdownFiles(workspaceRoot, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files.slice(0, 500);
}

async function collectMarkdownFiles(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredFileManagerDirs.has(entry.name)) {
        await collectMarkdownFiles(entryPath, files);
      }
      continue;
    }
    if (!entry.isFile() || !isMarkdownPath(entry.name)) {
      continue;
    }
    const info = await stat(entryPath);
    const relativePath = path.relative(workspaceRoot, entryPath);
    files.push({
      path: entryPath,
      relativePath,
      name: entry.name,
      directory: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      active: entryPath === documentPath
    });
  }
}

function resolveMarkdownPath(value) {
  if (!value.trim()) {
    throw new Error("file path is required");
  }
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
  if (!isMarkdownPath(resolved)) {
    throw new Error("only Markdown files can be opened");
  }
  return resolved;
}

async function pickMarkdownFile(startPath) {
  const startDir = await pickerStartDir(startPath);
  const commands = systemPickerCommands(startDir);
  const errors = [];

  for (const command of commands) {
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync(command.file, command.args, { windowsHide: true }));
    } catch (error) {
      if (isPickerCancel(error)) {
        return null;
      }
      errors.push(formatPickerError(command.file, error));
      continue;
    }

    const pickedPath = String(stdout || "").trim();
    if (!pickedPath) {
      return null;
    }
    return resolveMarkdownPath(pickedPath);
  }

  throw new Error([
    "System file picker is not available from this Xuanniao server.",
    "Paste an absolute Markdown path into the path field instead.",
    `Tried: ${errors.join("; ")}`
  ].join(" "));
}

async function pickerStartDir(startPath) {
  const resolved = path.isAbsolute(startPath) ? path.resolve(startPath) : path.resolve(workspaceRoot, startPath);
  try {
    const info = await stat(resolved);
    return info.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return workspaceRoot;
  }
}

function systemPickerCommands(startDir) {
  if (process.platform === "darwin") {
    return [{
      file: "osascript",
      args: [
        "-e",
        'set pickedFile to choose file with prompt "Open Markdown File"',
        "-e",
        "POSIX path of pickedFile"
      ]
    }];
  }

  if (process.platform === "win32") {
    const escapedDir = startDir.replace(/'/g, "''");
    return [{
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms",
          "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
          "$dialog.Title = 'Open Markdown File'",
          "$dialog.Filter = 'Markdown files (*.md;*.markdown;*.mdown;*.mkdn)|*.md;*.markdown;*.mdown;*.mkdn|All files (*.*)|*.*'",
          `$dialog.InitialDirectory = '${escapedDir}'`,
          "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.FileName) }"
        ].join("; ")
      ]
    }];
  }

  return [
    {
      file: "zenity",
      args: [
        "--file-selection",
        "--title=Open Markdown File",
        `--filename=${withTrailingSeparator(startDir)}`,
        "--file-filter=Markdown files | *.md *.markdown *.mdown *.mkdn",
        "--file-filter=All files | *"
      ]
    },
    {
      file: "kdialog",
      args: [
        "--title",
        "Open Markdown File",
        "--getopenfilename",
        startDir,
        "Markdown files (*.md *.markdown *.mdown *.mkdn)"
      ]
    },
    {
      file: "yad",
      args: [
        "--file",
        "--title=Open Markdown File",
        `--filename=${withTrailingSeparator(startDir)}`,
        "--file-filter=Markdown files | *.md *.markdown *.mdown *.mkdn",
        "--file-filter=All files | *"
      ]
    },
    {
      file: "qarma",
      args: [
        "--file-selection",
        "--title=Open Markdown File",
        `--filename=${withTrailingSeparator(startDir)}`,
        "--file-filter=Markdown files | *.md *.markdown *.mdown *.mkdn",
        "--file-filter=All files | *"
      ]
    },
    {
      file: "python3",
      args: ["-c", tkinterPickerScript(), startDir]
    },
    {
      file: "python",
      args: ["-c", tkinterPickerScript(), startDir]
    }
  ];
}

function tkinterPickerScript() {
  return [
    "import sys",
    "from tkinter import Tk, filedialog",
    "root = Tk()",
    "root.withdraw()",
    "root.update()",
    "picked = filedialog.askopenfilename(title='Open Markdown File', initialdir=sys.argv[1], filetypes=[('Markdown files', '*.md *.markdown *.mdown *.mkdn'), ('All files', '*.*')])",
    "root.destroy()",
    "print(picked)"
  ].join("; ");
}

function withTrailingSeparator(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function isPickerCancel(error) {
  const code = error?.code;
  const stderr = String(error?.stderr || "");
  return code === 1 && (!stderr.trim() || /cancel/i.test(stderr));
}

function formatPickerError(command, error) {
  if (error?.code === "ENOENT") {
    return `${command} not installed`;
  }
  return `${command} failed`;
}

function isMarkdownPath(filePath) {
  return [".md", ".markdown", ".mdown", ".mkdn"].includes(path.extname(filePath).toLowerCase());
}

function wantsDocumentEdit(text) {
  return /修改|改成|改为|替换|翻译|英文|translate|rewrite|replace|change|edit|update/i.test(text);
}

function canReplaceSelection(thread) {
  const anchor = thread?.anchor || {};
  return Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.end > anchor.start;
}

function extractReplacement(content) {
  const tagged = /<XUANNIAO_REPLACEMENT>\s*([\s\S]*?)\s*<\/XUANNIAO_REPLACEMENT>/i.exec(content);
  if (tagged) {
    return tagged[1].replace(/\n$/, "");
  }

  const fenced = /```(?:xuanniao-replacement|md|markdown)?\s*([\s\S]*?)```/i.exec(content);
  if (fenced && !/^[+-]/m.test(fenced[1])) {
    return fenced[1].replace(/\n$/, "");
  }

  const trimmed = content.trim();
  if (trimmed && !trimmed.includes("```") && trimmed.length < 20000) {
    return trimmed;
  }

  return null;
}

function applySelectionReplacement(content, thread, replacement) {
  const anchor = thread.anchor || {};
  let start = anchor.start;
  let end = anchor.end;
  const selectedText = String(thread.selectedText || "");

  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || content.slice(start, end) !== selectedText) {
    const first = selectedText ? content.indexOf(selectedText) : -1;
    const last = selectedText ? content.lastIndexOf(selectedText) : -1;
    if (first < 0 || first !== last) {
      throw new Error("Selected text no longer matches the document. Re-select the text and create a new comment thread.");
    }
    start = first;
    end = first + selectedText.length;
  }

  return {
    start,
    content: `${content.slice(0, start)}${replacement}${content.slice(end)}`
  };
}

function lineNumberAt(content, offset) {
  return content.slice(0, Math.max(offset, 0)).split(/\r?\n/).length;
}

async function ensureDocument(filePath) {
  if (existsSync(filePath)) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "", "utf8");
}

function sidecarPathFor(filePath) {
  return path.join(path.dirname(filePath), ".xuanniao", `${path.basename(filePath)}.threads.json`);
}

function normalizeAnchor(anchor) {
  const value = anchor && typeof anchor === "object" ? anchor : {};
  return {
    start: Number.isInteger(value.start) ? value.start : null,
    end: Number.isInteger(value.end) ? value.end : null,
    lineStart: Number.isInteger(value.lineStart) ? value.lineStart : null,
    lineEnd: Number.isInteger(value.lineEnd) ? value.lineEnd : null,
    blockId: typeof value.blockId === "string" ? value.blockId : null
  };
}

function normalizeThreadAnchorPatch(value) {
  const patch = value && typeof value === "object" ? value : {};
  return {
    id: String(patch.id || ""),
    selectedText: typeof patch.selectedText === "string" ? patch.selectedText : undefined,
    anchor: normalizeAnchor(patch.anchor)
  };
}

function serveStatic(routePath, res) {
  const staticRoot = existsSync(path.join(webDistRoot, "index.html")) ? webDistRoot : webRoot;
  const route = routePath === "/" ? "/index.html" : routePath;
  const safePath = path.normalize(route).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(staticRoot, safePath);

  if (!filePath.startsWith(staticRoot)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  if (!existsSync(filePath)) {
    filePath = path.join(staticRoot, "index.html");
  }

  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml"
  }[path.extname(filePath)] ?? "application/octet-stream";

  res.writeHead(200, { "content-type": contentType });
  createReadStream(filePath).pipe(res);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      parsed.port = argv[++index];
    } else if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
    } else if (arg === "--host") {
      parsed.host = argv[++index];
    } else if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
    } else if (!arg.startsWith("--") && !parsed.file) {
      parsed.file = arg;
    }
  }
  return parsed;
}
