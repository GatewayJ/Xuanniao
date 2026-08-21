import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentRuntime, runtimeAgentSettingsFromEnv, runtimeCommand } from "./lib/agent-runtime.js";
import { parseAgentSettingsUpdate, validateAgentSettingsSelection } from "./lib/agent-settings.js";
import { AgentSettingsStore } from "./lib/agent-settings-store.js";
import { atomicWriteText } from "./lib/atomic-file.js";
import { ConversationService } from "./lib/conversation-service.js";
import { AgentRunBroker, interruptedAgentRunSnapshot, normalizeAgentRunId } from "./lib/agent-run-broker.js";
import { normalizeConversationMetaPatch } from "./lib/conversation-model.js";
import { DocumentCreationService } from "./lib/document-creation-service.js";
import { DocumentWorkspace } from "./lib/document-workspace.js";
import { browseMarkdownDirectory } from "./lib/file-browser.js";
import { HttpRequestError, assertSafeHostBinding, assertTrustedRequest, setSecurityHeaders } from "./lib/http-security.js";
import { agentSettingsPath, legacyThreadStorePathFor, threadStorePathFor } from "./lib/metadata-paths.js";
import { ThreadStore } from "./lib/thread-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const webRoot = path.join(projectRoot, "web");
const webDistRoot = path.join(webRoot, "dist");

const args = parseArgs(process.argv.slice(2));
const workspaceRoot = process.cwd();
const host = args.host ?? process.env.HOST ?? "127.0.0.1";
const port = Number(args.port ?? process.env.PORT ?? 4173);
const allowRemote = process.env.XUANNIAO_UNSAFE_ALLOW_REMOTE === "1";
const maxBodyBytes = 8 * 1024 * 1024;
const ignoredFileManagerDirs = new Set([".git", "node_modules", "dist", ".xuanniao"]);

assertSafeHostBinding(host, allowRemote);
const initialDocumentPath = path.resolve(workspaceRoot, args.file ?? "prd.md");
const settingsStore = new AgentSettingsStore(agentSettingsPath());
const agentRuns = new AgentRunBroker();
const environmentAgentSettings = runtimeAgentSettingsFromEnv(process.env);
let agentSettings = await loadAgentSettings();
await ensureDocument(initialDocumentPath);
let activeDocument = await createDocumentContext(initialDocumentPath);
let documentSwitchLock = Promise.resolve();

const server = createServer(async (req, res) => {
  const context = activeDocument;
  const requestId = randomUUID();
  setSecurityHeaders(res, requestId);
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    assertTrustedRequest(req, url, { boundHost: host, allowRemote });

    if (url.pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        documentPath: context.path,
        workspaceRoot,
        agent: context.agent.status()
      });
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      return sendJson(res, 200, await agentSettingsPayload(context.agent));
    }

    if (url.pathname === "/api/settings" && req.method === "PUT") {
      const body = await readJson(req);
      const requestedSettings = parseAgentSettingsUpdate(body);
      const capabilities = context.agent.status().capabilities;
      const modelSettingsChanged = requestedSettings.model !== agentSettings.model
        || requestedSettings.reasoningEffort !== agentSettings.reasoningEffort;
      const permissionChanged = requestedSettings.permissionMode !== agentSettings.permissionMode;
      if (permissionChanged && capabilities.permissionSelection !== true) {
        throw new HttpRequestError(
          409,
          "权限设置仅支持原生 Codex transport。",
          "AGENT_SETTINGS_UNSUPPORTED"
        );
      }
      if (modelSettingsChanged && capabilities.modelSelection !== true) {
        throw new HttpRequestError(
          409,
          "模型和推理深度设置仅支持原生 Codex transport。",
          "AGENT_SETTINGS_UNSUPPORTED"
        );
      }

      let models = [];
      let catalogError = null;
      let nextSettings = requestedSettings;
      if (capabilities.modelSelection === true) {
        try {
          models = await context.agent.listModels();
          if (modelSettingsChanged) {
            nextSettings = validateAgentSettingsSelection(requestedSettings, models);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (modelSettingsChanged) {
            throw new HttpRequestError(
              503,
              `暂时无法读取 Codex 模型列表：${message}`,
              "MODEL_CATALOG_UNAVAILABLE"
            );
          }
          catalogError = message;
        }
      }
      agentSettings = await settingsStore.save(nextSettings);
      activeDocument.agent.configure(agentSettings);
      return sendJson(res, 200, settingsPayload(activeDocument.agent, models, catalogError));
    }

    if (url.pathname === "/api/files" && req.method === "GET") {
      return sendJson(res, 200, {
        root: workspaceRoot,
        currentPath: context.path,
        files: await listMarkdownFiles(context.path)
      });
    }

    if (url.pathname === "/api/files/browse" && req.method === "GET") {
      const targetPath = url.searchParams.get("path") || context.path;
      return sendJson(res, 200, await browseMarkdownDirectory(targetPath, workspaceRoot));
    }

    if (url.pathname === "/api/document" && req.method === "GET") {
      return sendJson(res, 200, await context.document.payload());
    }

    if (url.pathname === "/api/document/open" && req.method === "POST") {
      const body = await readJson(req);
      const nextPath = resolveMarkdownPath(String(body.path || ""));
      if (!existsSync(nextPath)) {
        return sendJson(res, 404, {
          error: `Markdown file not found: ${nextPath}`
        });
      }
      const opened = await switchDocument(nextPath);
      return sendJson(res, 200, {
        document: await opened.document.payload(),
        threads: await opened.threadStore.list(),
        files: await listMarkdownFiles(opened.path)
      });
    }

    if (url.pathname === "/api/document/create" && req.method === "POST") {
      const body = await readJson(req);
      const created = await createAndSwitchDocument(context, {
        instruction: body.instruction,
        directory: body.directory,
        fileName: body.fileName,
        agentRunId: normalizeAgentRunId(body.agentRunId)
      });
      return sendJson(res, 201, {
        document: await created.document.payload(),
        threads: await created.threadStore.list(),
        files: await listMarkdownFiles(created.path)
      });
    }

    if (url.pathname === "/api/document" && req.method === "PUT") {
      const body = await readJson(req);
      assertDocumentContext(body.documentPath, context.path);
      if (typeof body.content !== "string") {
        return sendJson(res, 400, { error: "content must be a string" });
      }
      const patches = Array.isArray(body.threads) ? body.threads.map(normalizeThreadAnchorPatch).filter((patch) => patch.id) : null;
      const deletedThreadIds = Array.isArray(body.deletedThreadIds) ? [...new Set(body.deletedThreadIds.map((id) => String(id)).filter(Boolean))] : [];
      const result = await context.document.save({
        content: body.content,
        expectedRevision: body.expectedRevision,
        anchorPatches: patches,
        deletedThreadIds
      });
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/threads" && req.method === "GET") {
      return sendJson(res, 200, { threads: await context.threadStore.list() });
    }

    const agentRunSnapshotMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)$/);
    if (agentRunSnapshotMatch && req.method === "POST") {
      await readJson(req);
      const agentRunId = normalizeAgentRunId(decodeURIComponent(agentRunSnapshotMatch[1]));
      return sendJson(res, 201, agentRuns.reserve(agentRunId));
    }
    if (agentRunSnapshotMatch && req.method === "GET") {
      const agentRunId = normalizeAgentRunId(decodeURIComponent(agentRunSnapshotMatch[1]));
      const snapshot = agentRuns.snapshot(agentRunId) || interruptedAgentRunSnapshot(
        agentRunId,
        await context.threadStore.list()
      );
      return snapshot
        ? sendJson(res, 200, snapshot)
        : sendJson(res, 404, { error: `agent run not found: ${agentRunId}` });
    }

    const agentRunMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)\/events$/);
    if (agentRunMatch && req.method === "GET") {
      const agentRunId = normalizeAgentRunId(decodeURIComponent(agentRunMatch[1]));
      return streamAgentRun(req, res, agentRunId);
    }

    if (url.pathname === "/api/threads" && req.method === "POST") {
      const body = await readJson(req);
      assertDocumentContext(body.documentPath, context.path);
      const thread = await context.document.createThread({
        title: String(body.title || body.selectedText || "Untitled thread").slice(0, 120),
        selectedText: String(body.selectedText || ""),
        anchor: normalizeAnchor(body.anchor),
        expectedRevision: body.expectedRevision
      });
      return sendJson(res, 201, { thread });
    }

    if (url.pathname === "/api/permissions" && req.method === "GET") {
      return sendJson(res, 200, { requests: context.agent.listPermissionRequests() });
    }

    const permissionMatch = url.pathname.match(/^\/api\/permissions\/([^/]+)\/resolve$/);
    if (permissionMatch && req.method === "POST") {
      const permissionId = decodeURIComponent(permissionMatch[1]);
      const body = await readJson(req);
      context.agent.resolvePermissionRequest(permissionId, {
        optionId: typeof body.optionId === "string" ? body.optionId : "",
        cancelled: body.cancelled === true
      });
      return sendJson(res, 200, { requests: context.agent.listPermissionRequests() });
    }

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (threadMatch && req.method === "DELETE") {
      const threadId = decodeURIComponent(threadMatch[1]);
      await context.conversation.deleteThread(threadId);
      return sendJson(res, 200, { threads: await context.threadStore.list() });
    }

    const messageMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
    if (messageMatch && req.method === "POST") {
      const threadId = decodeURIComponent(messageMatch[1]);
      const body = await readJson(req);
      return sendJson(res, 200, await context.conversation.addQuestion(threadId, body));
    }

    const messageUpdateMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages\/([^/]+)$/);
    const messageMetaMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/meta$/);
    const messageRevisionMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/revisions$/);
    if (messageRevisionMatch && req.method === "POST") {
      const threadId = decodeURIComponent(messageRevisionMatch[1]);
      const messageId = decodeURIComponent(messageRevisionMatch[2]);
      const body = await readJson(req);
      return sendJson(res, 200, await context.conversation.reviseQuestion(threadId, messageId, body));
    }

    if (messageMetaMatch && req.method === "PATCH") {
      const threadId = decodeURIComponent(messageMetaMatch[1]);
      const messageId = decodeURIComponent(messageMetaMatch[2]);
      const body = await readJson(req);
      let metaPatch;
      try {
        metaPatch = normalizeConversationMetaPatch(body.meta ?? body);
      } catch (error) {
        return sendJson(res, 400, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (Object.keys(metaPatch).length === 0) {
        return sendJson(res, 400, { error: "metadata patch is required" });
      }
      const message = await context.threadStore.updateMessageMeta(threadId, messageId, metaPatch);
      return sendJson(res, 200, {
        message,
        threads: await context.threadStore.list()
      });
    }

    if (messageUpdateMatch && req.method === "DELETE") {
      const threadId = decodeURIComponent(messageUpdateMatch[1]);
      const messageId = decodeURIComponent(messageUpdateMatch[2]);
      await context.conversation.deleteMessage(threadId, messageId);
      return sendJson(res, 200, { threads: await context.threadStore.list() });
    }

    if (messageUpdateMatch && req.method === "PUT") {
      const threadId = decodeURIComponent(messageUpdateMatch[1]);
      const messageId = decodeURIComponent(messageUpdateMatch[2]);
      const body = await readJson(req);
      return sendJson(res, 200, await context.conversation.updateQuestion(threadId, messageId, body));
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    console.error(JSON.stringify({
      level: "error",
      requestId,
      method: req.method,
      path: req.url,
      statusCode,
      code: error?.code || null,
      message
    }));
    return sendJson(res, statusCode, {
      error: message,
      requestId,
      ...(error?.currentRevision ? { currentRevision: error.currentRevision } : {})
    });
  }
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Xuanniao serving ${activeDocument.path}`);
  console.log(`Open ${url}`);
  console.log(`Agent mode: ${activeDocument.agent.status().accessMode}`);
  console.log(`Agent transport: ${activeDocument.agent.status().transport}`);
  console.log(`Agent command: ${runtimeCommand(activeDocument.agent)}`);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; closing Xuanniao.`);
  try {
    activeDocument.agent.dispose();
    agentRuns.dispose();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
  server.closeIdleConnections?.();
}

function createAgentFor(filePath) {
  return createAgentRuntime({
    documentPath: filePath,
    cwd: workspaceRoot,
    env: process.env,
    settings: agentSettings
  });
}

async function loadAgentSettings() {
  try {
    return await settingsStore.load(environmentAgentSettings);
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      event: "agent_settings_load_failed",
      path: settingsStore.filePath,
      message: error instanceof Error ? error.message : String(error)
    }));
    return environmentAgentSettings;
  }
}

async function agentSettingsPayload(agent) {
  const status = agent.status();
  if (status.capabilities.modelSelection !== true) {
    return settingsPayload(agent, [], null);
  }
  try {
    return settingsPayload(agent, await agent.listModels(), null);
  } catch (error) {
    return settingsPayload(agent, [], error instanceof Error ? error.message : String(error));
  }
}

function settingsPayload(agent, models, catalogError) {
  const status = agent.status();
  return {
    transport: status.transport,
    modelSelectionSupported: status.capabilities.modelSelection === true,
    permissionSelectionSupported: status.capabilities.permissionSelection === true,
    model: agentSettings.model,
    reasoningEffort: agentSettings.reasoningEffort,
    permissionMode: agentSettings.permissionMode,
    models,
    catalogError
  };
}

async function createDocumentContext(filePath) {
  const resolved = path.resolve(filePath);
  const threadStore = await createThreadStoreFor(resolved);
  const agent = createAgentFor(resolved);
  const document = new DocumentWorkspace(resolved, threadStore);
  return Object.freeze({
    path: resolved,
    threadStore,
    document,
    agent,
    conversation: new ConversationService({
      threadStore,
      document,
      agent,
      agentRuns,
      onAgentError: (event) => {
        console.error(JSON.stringify({
          level: "error",
          event: "agent_turn_failed",
          documentPath: resolved,
          ...event
        }));
      }
    })
  });
}

async function switchDocument(nextPath) {
  return withDocumentSwitchLock(() => performDocumentSwitch(nextPath));
}

function withDocumentSwitchLock(operation) {
  const run = documentSwitchLock.then(operation, operation);
  documentSwitchLock = run.catch(() => {});
  return run;
}

function createAndSwitchDocument(context, command) {
  return withDocumentSwitchLock(async () => {
    if (context !== activeDocument) {
      throw new HttpRequestError(
        409,
        "The active document changed before document creation started; retry from the current document.",
        "DOCUMENT_CONTEXT_CHANGED"
      );
    }
    const service = new DocumentCreationService({
      workspaceRoot,
      agent: context.agent,
      document: context.document,
      agentRuns
    });
    const created = await service.create(command);
    return performDocumentSwitch(created.path);
  });
}

async function performDocumentSwitch(nextPath) {
  const resolved = path.resolve(nextPath);
  if (resolved === activeDocument.path) {
    return activeDocument;
  }
  const next = await createDocumentContext(resolved);
  const previous = activeDocument;
  activeDocument = next;
  previous.agent.dispose();
  return next;
}


async function listMarkdownFiles(activePath) {
  const files = [];
  await collectMarkdownFiles(workspaceRoot, files, activePath);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files.slice(0, 500);
}

async function collectMarkdownFiles(dir, files, activePath) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredFileManagerDirs.has(entry.name)) {
        await collectMarkdownFiles(entryPath, files, activePath);
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
      active: entryPath === activePath
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

function isMarkdownPath(filePath) {
  return [".md", ".markdown", ".mdown", ".mkdn"].includes(path.extname(filePath).toLowerCase());
}

async function ensureDocument(filePath) {
  if (existsSync(filePath)) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteText(filePath, "");
}

async function createThreadStoreFor(filePath) {
  const storePath = threadStorePathFor(filePath);
  const legacyStorePath = legacyThreadStorePathFor(filePath);

  if (!existsSync(storePath) && existsSync(legacyStorePath)) {
    await mkdir(path.dirname(storePath), { recursive: true });
    await copyFile(legacyStorePath, storePath);
  }

  return new ThreadStore(storePath);
}

function normalizeAnchor(anchor) {
  const value = anchor && typeof anchor === "object" ? anchor : {};
  return {
    start: Number.isInteger(value.start) ? value.start : null,
    end: Number.isInteger(value.end) ? value.end : null,
    lineStart: Number.isInteger(value.lineStart) ? value.lineStart : null,
    lineEnd: Number.isInteger(value.lineEnd) ? value.lineEnd : null,
    blockId: typeof value.blockId === "string" ? value.blockId : null,
    contextBefore: typeof value.contextBefore === "string" ? value.contextBefore.slice(-32) : null,
    contextAfter: typeof value.contextAfter === "string" ? value.contextAfter.slice(0, 32) : null
  };
}

function assertDocumentContext(requestedPath, activePath) {
  if (typeof requestedPath !== "string" || path.resolve(requestedPath) !== activePath) {
    throw new HttpRequestError(
      409,
      "The active document changed before this request was handled; retry in the current document.",
      "DOCUMENT_CONTEXT_CHANGED"
    );
  }
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

  const contentType =
    {
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
      throw new HttpRequestError(413, "request body is too large", "REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpRequestError(400, "request body must contain valid JSON", "INVALID_JSON");
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function streamAgentRun(req, res, agentRunId) {
  if (!agentRuns.snapshot(agentRunId)) {
    const error = new Error(`agent run not found: ${agentRunId}`);
    error.statusCode = 404;
    error.code = "AGENT_RUN_NOT_FOUND";
    throw error;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const maxPendingEvents = 128;
  let closed = false;
  let terminal = false;
  let draining = false;
  let heartbeat = null;
  let unsubscribe = () => {};
  const pending = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.off("drain", onDrain);
    unsubscribe();
  };
  const end = () => {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const flush = () => {
    if (closed || draining) return;
    while (pending.length > 0) {
      const next = pending.shift();
      if (!writeServerEvent(res, next.type, next.data)) {
        draining = true;
        res.once("drain", onDrain);
        return;
      }
    }
    if (terminal) end();
  };
  function onDrain() {
    draining = false;
    flush();
  }
  const enqueue = ({ type, data }) => {
    if (closed) return;
    if (pending.length >= maxPendingEvents) {
      pending.length = 0;
      const snapshot = agentRuns.snapshot(agentRunId);
      if (snapshot) pending.push({ type: "snapshot", data: snapshot });
    }
    pending.push({ type, data });
    if (type === "complete" || type === "shutdown") terminal = true;
    flush();
  };

  if (!res.write("retry: 3000\n\n")) draining = true;
  if (draining) res.once("drain", onDrain);
  unsubscribe = agentRuns.subscribe(agentRunId, enqueue);
  if (closed) {
    unsubscribe();
  } else {
    heartbeat = setInterval(() => {
      if (!closed && !draining && pending.length === 0) res.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref?.();
  }

  req.on("close", cleanup);
  res.on("close", cleanup);
}

function writeServerEvent(res, event, payload) {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
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
