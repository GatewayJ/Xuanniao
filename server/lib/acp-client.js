import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class AcpDocumentAgent extends EventEmitter {
  constructor({ documentPath, cwd, commandLine, fallbackCommandLine, timeoutMs }) {
    super();
    this.documentPath = path.resolve(documentPath);
    this.cwd = cwd;
    this.commandLine = commandLine;
    this.fallbackCommandLine = fallbackCommandLine;
    this.timeoutMs = timeoutMs;
    this.protocolId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.process = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.activeTurn = null;
    this.promptLock = Promise.resolve();
    this.pendingPermissions = new Map();
    this.writePermission = {
      always: false,
      turnIds: new Set()
    };
  }

  status() {
    return {
      command: parseCommandLine(this.commandLine),
      fallbackCommand: parseCommandLine(this.fallbackCommandLine),
      sessionId: this.sessionId,
      running: Boolean(this.process && !this.process.killed),
      stderrTail: this.stderrTail,
      pendingPermissions: this.listPermissionRequests().length
    };
  }

  dispose() {
    this.cancelPendingPermissions();
    this.failAll(new Error("ACP document session closed."));
    this.pending.clear();
    this.sessionId = null;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.writePermission.always = false;
    this.writePermission.turnIds.clear();
  }

  async prompt({ question, document, thread, mode = "chat" }) {
    const task = async () => {
      try {
        return await this.promptViaAcp({ question, document, thread, mode });
      } catch (error) {
        if (!this.shouldFallback(error)) {
          throw error;
        }
        return this.promptViaCodexExec({ question, document, thread, mode, acpError: error });
      }
    };

    const run = this.promptLock.then(task, task);
    this.promptLock = run.catch(() => {});
    return run;
  }

  async promptViaAcp({ question, document, thread, mode }) {
    await this.ensureSession();
    const turn = {
      id: randomUUID(),
      sessionId: this.sessionId,
      threadId: thread.id,
      chunks: [],
      updates: []
    };
    this.activeTurn = turn;

    try {
      const result = await this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [
          {
            type: "text",
            text: buildPrompt({ question, document, thread, mode })
          }
        ]
      });

      const content = turn.chunks.join("").trim();
      return {
        content: content || "Codex completed without returning text.",
        stopReason: result?.stopReason ?? null,
        transport: "acp",
        updates: turn.updates.slice(-30)
      };
    } finally {
      if (this.activeTurn?.id === turn.id) {
        this.activeTurn = null;
      }
      this.writePermission.turnIds.delete(turn.id);
      this.cancelPendingPermissionsForTurn(turn.id);
    }
  }

  async promptViaCodexExec({ question, document, thread, mode, acpError }) {
    const [command, ...configuredArgs] = parseCommandLine(this.fallbackCommandLine || "codex");
    if (!command) {
      throw new Error(`ACP failed (${messageOf(acpError)}) and XUANNIAO_CODEX_CMD is empty.`);
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "xuanniao-codex-"));
    const outputPath = path.join(tempDir, "last-message.md");
    const args = [
      ...configuredArgs,
      "exec",
      "--cd",
      this.cwd,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-last-message",
      outputPath,
      "-"
    ];

    try {
      const result = await runStdioProcess({
        command,
        args,
        cwd: this.cwd,
        input: buildPrompt({ question, document, thread, mode }),
        timeoutMs: this.timeoutMs
      });

      if (result.code !== 0) {
        throw new Error([
          `ACP failed (${messageOf(acpError)}).`,
          `Codex fallback exited with code ${result.code}.`,
          result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
          result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : ""
        ].filter(Boolean).join("\n\n"));
      }

      const content = existsSync(outputPath)
        ? (await readFile(outputPath, "utf8")).trim()
        : result.stdout.trim();

      return {
        content: content || "Codex fallback completed without returning text.",
        stopReason: "codex_exec_fallback",
        transport: "codex-exec",
        updates: [
          {
            sessionUpdate: "fallback",
            reason: messageOf(acpError)
          }
        ]
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  shouldFallback(error) {
    if (process.env.XUANNIAO_DISABLE_CODEX_FALLBACK === "1") {
      return false;
    }
    if (process.env.XUANNIAO_ACP_CMD) {
      return false;
    }
    const message = messageOf(error);
    return message.includes("ENOENT") || message.includes("ACP process is not writable");
  }

  async ensureSession() {
    if (this.sessionId && this.process && !this.process.killed) {
      return;
    }
    await this.startProcess();
    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true
        },
        terminal: false
      },
      clientInfo: {
        name: "xuanniao",
        title: "玄鸟 Xuanniao",
        version: "0.1.0"
      }
    });

    const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    if (authMethods.length > 0 && process.env.XUANNIAO_ACP_SKIP_AUTH !== "1") {
      const ids = authMethods.map((method) => method.id || method.name || "unknown").join(", ");
      throw new Error(`ACP agent requires authentication (${ids}). Authenticate the adapter first or set XUANNIAO_ACP_SKIP_AUTH=1 if it can use existing credentials.`);
    }

    const session = await this.request("session/new", {
      cwd: this.cwd,
      mcpServers: []
    });
    if (!session?.sessionId) {
      throw new Error("ACP session/new did not return a sessionId");
    }
    this.sessionId = session.sessionId;
  }

  async startProcess() {
    if (this.process && !this.process.killed) {
      return;
    }

    const [command, ...args] = parseCommandLine(this.commandLine);
    if (!command) {
      throw new Error("XUANNIAO_ACP_CMD is empty");
    }

    this.process = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("close", (code) => {
      const detail = this.stderrTail ? `\n\nstderr:\n${this.stderrTail}` : "";
      this.failAll(new Error(`ACP process exited with code ${code}.${detail}`));
      this.process = null;
      this.sessionId = null;
    });
  }

  request(method, params) {
    const id = ++this.protocolId;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      this.writeMessage(payload);
    });
  }

  writeMessage(payload) {
    if (!this.process?.stdin?.writable) {
      throw new Error("ACP process is not writable");
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleMessageLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleMessageLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.stderrTail = `${this.stderrTail}\nInvalid ACP JSON: ${line}`.slice(-4000);
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      if (Object.hasOwn(message, "id")) {
        this.handleClientRequest(message);
      } else {
        this.handleNotification(message);
      }
    }
  }

  async handleClientRequest(message) {
    try {
      if (message.method === "fs/read_text_file") {
        const result = await this.readTextFile(message.params || {});
        return this.writeMessage({ jsonrpc: "2.0", id: message.id, result });
      }

      if (message.method === "fs/write_text_file") {
        const result = await this.writeTextFile(message.params || {});
        return this.writeMessage({ jsonrpc: "2.0", id: message.id, result });
      }

      if (message.method === "session/request_permission") {
        const result = await this.requestUserPermission(message.params || {});
        return this.writeMessage({ jsonrpc: "2.0", id: message.id, result });
      }

      return this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported client method: ${message.method}`
        }
      });
    } catch (error) {
      return this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  listPermissionRequests() {
    return [...this.pendingPermissions.values()].map((permission) => permission.snapshot);
  }

  resolvePermissionRequest(id, { optionId, cancelled = false }) {
    const permission = this.pendingPermissions.get(id);
    if (!permission) {
      throw new Error(`permission request not found: ${id}`);
    }

    if (cancelled) {
      permission.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }

    const selected = permission.snapshot.options.find((option) => option.optionId === optionId);
    if (!selected) {
      throw new Error(`permission option not found: ${optionId}`);
    }

    this.applyPermissionGrant(permission, selected);

    permission.resolve({
      outcome: {
        outcome: "selected",
        optionId: selected.optionId
      }
    });
  }

  applyPermissionGrant(permission, selected) {
    if (selected.kind === "allow_always") {
      this.writePermission.always = true;
      return;
    }
    if (selected.kind === "allow_once" && permission.turnId) {
      this.writePermission.turnIds.add(permission.turnId);
    }
  }

  requestUserPermission(params) {
    const turn = this.activeTurn;
    const toolCall = params.toolCall || {};
    const id = randomUUID();
    const snapshot = {
      id,
      sessionId: params.sessionId || this.sessionId || null,
      threadId: turn?.threadId || null,
      toolCallId: toolCall.toolCallId || null,
      title: toolCall.title || "Codex requests permission",
      kind: toolCall.kind || null,
      status: toolCall.status || null,
      rawInput: previewRawValue(toolCall.rawInput),
      options: normalizePermissionOptions(params.options),
      createdAt: new Date().toISOString()
    };

    return new Promise((resolve) => {
      this.pendingPermissions.set(id, {
        turnId: turn?.id || null,
        snapshot,
        resolve: (result) => {
          this.pendingPermissions.delete(id);
          resolve(result);
        }
      });
    });
  }

  cancelPendingPermissionsForTurn(turnId) {
    if (!turnId) return;
    for (const [id, permission] of this.pendingPermissions) {
      if (permission.turnId !== turnId) continue;
      this.pendingPermissions.delete(id);
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  cancelPendingPermissions() {
    for (const [id, permission] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  handleNotification(message) {
    if (message.method !== "session/update") {
      return;
    }
    const params = message.params || {};
    const update = params.update || {};
    if (!this.activeTurn || params.sessionId !== this.activeTurn.sessionId) {
      return;
    }

    this.activeTurn.updates.push(compactUpdate(update));
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      this.activeTurn.chunks.push(update.content.text || "");
    }
  }

  async readTextFile(params) {
    const requestedPath = path.resolve(String(params.path || ""));
    if (requestedPath !== this.documentPath) {
      throw new Error(`read denied outside active document: ${requestedPath}`);
    }

    const content = await readFile(this.documentPath, "utf8");
    const line = Number.isInteger(params.line) ? params.line : null;
    const limit = Number.isInteger(params.limit) ? params.limit : null;
    if (!line && !limit) {
      return { content };
    }

    const lines = content.split(/\r?\n/);
    const start = Math.max((line ?? 1) - 1, 0);
    const end = limit ? start + limit : lines.length;
    return { content: lines.slice(start, end).join("\n") };
  }

  async writeTextFile(params) {
    const requestedPath = path.resolve(String(params.path || ""));
    if (requestedPath !== this.documentPath) {
      throw new Error(`write denied outside active document: ${requestedPath}`);
    }
    if (!this.writePermission.always && !this.writePermission.turnIds.has(this.activeTurn?.id)) {
      throw new Error("write denied until the user approves the active permission request");
    }

    await writeFile(this.documentPath, String(params.content ?? ""), "utf8");
    return {};
  }

  failAll(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function normalizePermissionOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => ({
    optionId: String(option.optionId || ""),
    name: String(option.name || option.optionId || "Permission option"),
    kind: String(option.kind || "other")
  })).filter((option) => option.optionId);
}

function previewRawValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? `${json.slice(0, 240)}...` : json;
  } catch {
    return String(value);
  }
}

export function parseCommandLine(commandLine) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && index + 1 < commandLine.length) {
        current += commandLine[++index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function runStdioProcess({ command, args, cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildPrompt({ question, document, thread, mode = "chat" }) {
  const history = (thread.messages || [])
    .slice(-12)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");

  const common = [
    "You are Codex collaborating with the user in Xuanniao, a local Markdown plan document workspace.",
    "The document is the source of truth. Discuss the selected details and propose precise improvements.",
    "For normal chat replies, return Markdown-compatible plain text. Use fenced code blocks for code, XML, JSON, diffs, logs, and protocol examples.",
    "When the user asks you to change the active document, you may write only that document after Xuanniao grants an explicit permission request.",
    "Never write files outside the active document path.",
    "",
    `Document path: ${document.path}`,
    `Document title: ${document.title}`,
    "",
    "Selected text:",
    thread.selectedText || "(no selection)",
    "",
    "Anchor:",
    JSON.stringify(thread.anchor || {}),
    "",
    "Recent thread history:",
    history || "(new thread)",
    "",
    "Current user question:",
    question
  ];

  if (mode === "replace-selection") {
    return [
      ...common,
      "",
      "The user is explicitly asking you to edit the selected Markdown.",
      "Return only the replacement Markdown for the selected text, wrapped exactly like this:",
      "<XUANNIAO_REPLACEMENT>",
      "replacement markdown here",
      "</XUANNIAO_REPLACEMENT>",
      "",
      "Do not include explanation, diff markers, or surrounding document text."
    ].join("\n");
  }

  return common.join("\n");
}

function compactUpdate(update) {
  if (update.sessionUpdate === "agent_message_chunk") {
    return { sessionUpdate: update.sessionUpdate, textLength: update.content?.text?.length ?? 0 };
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return {
      sessionUpdate: update.sessionUpdate,
      toolCallId: update.toolCallId,
      title: update.title,
      kind: update.kind,
      status: update.status
    };
  }
  if (update.sessionUpdate === "plan") {
    return {
      sessionUpdate: update.sessionUpdate,
      entries: Array.isArray(update.entries) ? update.entries.length : 0
    };
  }
  return { sessionUpdate: update.sessionUpdate || "unknown" };
}
