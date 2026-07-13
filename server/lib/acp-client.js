import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class AcpDocumentAgent extends EventEmitter {
  constructor({ documentPath, cwd, commandLine, accessMode = "full-access", timeoutMs }) {
    super();
    this.documentPath = path.resolve(documentPath);
    this.cwd = cwd;
    this.commandLine = commandLine;
    this.accessMode = normalizeAgentMode(accessMode);
    this.timeoutMs = timeoutMs;
    this.protocolId = 0;
    this.pending = new Map();
    this.initialized = false;
    this.agentCapabilities = {};
    this.threadSessions = new Map();
    this.process = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.activeTurn = null;
    this.promptLock = Promise.resolve();
    this.pendingPermissions = new Map();
  }

  status() {
    return {
      command: parseCommandLine(this.commandLine),
      accessMode: this.accessMode,
      initialized: this.initialized,
      sessionCount: this.threadSessions.size,
      running: Boolean(this.process && !this.process.killed),
      stderrTail: this.stderrTail,
      pendingPermissions: this.listPermissionRequests().length
    };
  }

  dispose() {
    this.cancelPendingPermissions();
    this.failAll(new Error("ACP document session closed."));
    this.pending.clear();
    this.initialized = false;
    this.agentCapabilities = {};
    this.threadSessions.clear();
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }

  async start() {
    await this.ensureInitialized();
  }

  async prompt({ question, document, thread, mode = "chat", onSessionId }) {
    const task = () => this.promptViaAcp({ question, document, thread, mode, onSessionId });

    const run = this.promptLock.then(task, task);
    this.promptLock = run.catch(() => {});
    return run;
  }

  async promptViaAcp({ question, document, thread, mode, onSessionId }) {
    const sessionId = await this.ensureThreadSession(thread, onSessionId);
    const turn = {
      id: randomUUID(),
      sessionId,
      threadId: thread.id,
      chunks: [],
      updates: []
    };
    this.activeTurn = turn;

    try {
      const result = await this.request("session/prompt", {
        sessionId,
        prompt: [
          {
            type: "text",
            text: buildPrompt({ question, document, thread, mode, accessMode: this.accessMode })
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
      this.cancelPendingPermissionsForTurn(turn.id);
    }
  }

  async ensureInitialized() {
    if (this.initialized && this.process && !this.process.killed) {
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
    this.agentCapabilities = init?.agentCapabilities || {};
    this.initialized = true;
  }

  async ensureThreadSession(thread, onSessionId) {
    await this.ensureInitialized();
    const activeSessionId = this.threadSessions.get(thread.id);
    if (activeSessionId) {
      if (thread.acpSessionId !== activeSessionId && onSessionId) {
        await onSessionId(activeSessionId);
      }
      return activeSessionId;
    }

    let sessionId = thread.acpSessionId || null;
    if (sessionId) {
      if (this.agentCapabilities.loadSession !== true) {
        throw new Error("ACP agent does not support session/load; persisted thread sessions cannot be restored.");
      }
      await this.request("session/load", {
        sessionId,
        cwd: this.cwd,
        mcpServers: []
      });
    } else {
      const session = await this.request("session/new", {
        cwd: this.cwd,
        mcpServers: []
      });
      if (!session?.sessionId) {
        throw new Error("ACP session/new did not return a sessionId");
      }
      sessionId = session.sessionId;
    }

    this.threadSessions.set(thread.id, sessionId);
    if (thread.acpSessionId !== sessionId && onSessionId) {
      await onSessionId(sessionId);
    }
    return sessionId;
  }

  async startProcess() {
    if (this.process && !this.process.killed) {
      return;
    }

    const [command, ...args] = parseCommandLine(this.commandLine);
    if (!command) {
      throw new Error("XUANNIAO_ACP_CMD is empty");
    }

    const child = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_PATH: process.env.CODEX_PATH ?? "codex",
        INITIAL_AGENT_MODE: acpAgentMode(this.accessMode)
      }
    });
    this.process = child;

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        if (this.process === child) this.process = null;
        reject(new Error(`Failed to start ACP command '${command}': ${error.message}`));
      });
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code) => {
      const detail = this.stderrTail ? `\n\nstderr:\n${this.stderrTail}` : "";
      this.failAll(new Error(`ACP process exited with code ${code}.${detail}`));
      if (this.process === child) this.process = null;
      this.initialized = false;
      this.agentCapabilities = {};
      this.threadSessions.clear();
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

    permission.resolve({
      outcome: {
        outcome: "selected",
        optionId: selected.optionId
      }
    });
  }

  requestUserPermission(params) {
    const options = normalizePermissionOptions(params.options);
    const automaticOption = this.accessMode === "full-access"
      ? optionByPreferredKinds(options, ["allow_always", "allow_once"])
      : optionByPreferredKinds(options, ["reject_always", "reject_once"]);
    if (automaticOption) {
      return Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: automaticOption.optionId
        }
      });
    }
    return Promise.resolve({ outcome: { outcome: "cancelled" } });

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
    const content = await readFile(requestedPath, "utf8");
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
    if (this.accessMode !== "full-access") {
      throw new Error(`write denied in read-only mode: ${requestedPath}`);
    }

    await writeFile(requestedPath, String(params.content ?? ""), "utf8");
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

function optionByPreferredKinds(options, kinds) {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return null;
}

export function normalizeAgentMode(value) {
  const mode = String(value ?? "full-access").trim().toLowerCase();
  if (mode === "full-access" || mode === "read-only") {
    return mode;
  }
  throw new Error(`Unsupported XUANNIAO_AGENT_MODE: ${value}. Expected full-access or read-only.`);
}

export function acpAgentMode(value) {
  return normalizeAgentMode(value) === "full-access" ? "agent-full-access" : "read-only";
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

export function buildPrompt({ question, document, thread, mode = "chat", accessMode = "full-access" }) {
  const history = (thread.messages || [])
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");

  const common = [
    "You are Codex collaborating with the user in Xuanniao, a local Markdown plan document workspace.",
    "The document is the source of truth. Discuss the selected details and propose precise improvements.",
    "For normal chat replies, return Markdown-compatible plain text. Use fenced code blocks for code, XML, JSON, diffs, logs, and protocol examples.",
    accessMode === "full-access"
      ? "Xuanniao has granted full filesystem, command, and network access for this session. Do not ask for permission before acting on the user's request."
      : "This session is read-only. You may inspect files, but do not modify files or perform mutating operations.",
    "",
    `Document path: ${document.path}`,
    `Document title: ${document.title}`,
    "",
    "Complete document content:",
    "<XUANNIAO_DOCUMENT>",
    document.content || "",
    "</XUANNIAO_DOCUMENT>",
    "",
    "Selected text:",
    thread.selectedText || "(no selection)",
    "",
    "Anchor:",
    JSON.stringify(thread.anchor || {}),
    "",
    "Complete current thread message history:",
    "Treat this explicit history as authoritative if it differs from older session context.",
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
