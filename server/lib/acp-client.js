import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeAgentMode, parseCommandLine } from "./agent-config.js";
import {
  AGENT_DEVELOPER_INSTRUCTIONS,
  DocumentSnapshotCache,
  buildAgentPrompt,
  documentHash
} from "./agent-context.js";
import { JsonLineRpcProcess, RpcRequestTimeoutError } from "./json-line-rpc-process.js";

export { normalizeAgentMode, parseCommandLine } from "./agent-config.js";

export class AcpDocumentAgent {
  constructor({
    documentPath,
    cwd,
    commandLine,
    accessMode = "full-access",
    timeoutMs,
    contextMaxChars,
    snapshotCacheEntries = 32,
    env = process.env
  }) {
    this.documentPath = path.resolve(documentPath);
    this.cwd = cwd;
    this.commandLine = commandLine;
    this.accessMode = normalizeAgentMode(accessMode);
    this.timeoutMs = timeoutMs;
    this.contextMaxChars = contextMaxChars;
    this.env = env;
    this.initialized = false;
    this.agentCapabilities = {};
    this.threadSessions = new Map();
    this.activeTurn = null;
    this.promptLock = Promise.resolve();
    this.pendingPermissions = new Map();
    this.documentSnapshots = new DocumentSnapshotCache(snapshotCacheEntries);
    this.rpc = new JsonLineRpcProcess({
      label: "ACP",
      commandLine,
      cwd,
      env: {
        ...env,
        CODEX_PATH: env.CODEX_PATH ?? "codex",
        INITIAL_AGENT_MODE: acpAgentMode(this.accessMode)
      },
      timeoutMs,
      emptyCommandMessage: "XUANNIAO_ACP_CMD is empty",
      formatRequest: ({ id, method, params }) => ({
        jsonrpc: "2.0",
        id,
        method,
        params
      }),
      onMessage: (message) => this.handleRpcMessage(message),
      onExit: () => this.handleProcessExit()
    });
  }

  status() {
    return {
      transport: "acp",
      command: parseCommandLine(this.commandLine),
      accessMode: this.accessMode,
      initialized: this.initialized,
      sessionCount: this.threadSessions.size,
      running: this.rpc.running,
      stderrTail: this.rpc.stderrTail,
      pendingPermissions: this.listPermissionRequests().length,
      model: null,
      reasoningEffort: null,
      capabilities: {
        resume: this.agentCapabilities.loadSession === true,
        fork: false,
        concurrentSessions: false,
        approvalBroker: true,
        incrementalDocumentContext: true,
        eventStream: true,
        structuredUserInput: false,
        mcpElicitation: false,
        dynamicClientTools: false,
        modelSelection: false,
        permissionSelection: false
      }
    };
  }

  listModels() {
    return Promise.resolve([]);
  }

  configure({ model = null, reasoningEffort = null } = {}) {
    if (model || reasoningEffort) {
      const error = new Error("Model selection is only available with the native Codex transport.");
      error.statusCode = 409;
      throw error;
    }
  }

  dispose() {
    this.cancelPendingPermissions();
    this.initialized = false;
    this.agentCapabilities = {};
    this.threadSessions.clear();
    this.documentSnapshots.clear();
    this.rpc.dispose(new Error("ACP document session closed."));
  }

  async start() {
    await this.ensureInitialized();
  }

  async runTurn({ question, document, thread, mode = "chat", onUpdate = null }) {
    const task = () => this.promptViaAcp({ question, document, thread, mode, onUpdate });

    const run = this.promptLock.then(task, task);
    this.promptLock = run.catch(() => {});
    return run;
  }

  async promptViaAcp({ question, document, thread, mode, onUpdate }) {
    const turnAccessMode = mode === "create-document" ? "read-only" : this.accessMode;
    const session = await this.ensureThreadSession(thread, turnAccessMode);
    const hash = documentHash(document.content);
    const previousDocument = this.documentSnapshots.get(session.sessionId);
    const includeDocument = session.documentHash !== hash;
    const unsyncedMessages = thread.unsyncedCurrentNodeMessages || [];
    const turn = {
      id: randomUUID(),
      sessionId: session.sessionId,
      threadId: thread.id,
      chunks: [],
      updates: [],
      updateIndexes: new Map(),
      onUpdate,
      readOnly: turnAccessMode === "read-only",
      startedAt: Date.now()
    };
    this.activeTurn = turn;

    try {
      const result = await this.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: buildPrompt({
              question,
              document,
              thread,
              mode,
              accessMode: turnAccessMode,
              includeDocument,
              includeHistory: session.historyMode === "fresh" || unsyncedMessages.length > 0,
              history: session.historyMode === "fresh" ? thread.messages || [] : unsyncedMessages,
              previousDocument: includeDocument ? (previousDocument ?? null) : null,
              maxChars: this.contextMaxChars
            })
          }
        ]
      });

      const content = turn.chunks.join("").trim();
      const agentSession = {
        adapter: "acp",
        sessionId: session.sessionId,
        turnId: null,
        documentHash: hash
      };
      this.documentSnapshots.set(session.sessionId, document.content);
      return {
        content: content || "Codex completed without returning text.",
        stopReason: result?.stopReason ?? null,
        transport: "acp",
        updates: turn.updates.slice(-30),
        durationMs: Date.now() - turn.startedAt,
        model: null,
        reasoningEffort: null,
        session: agentSession
      };
    } catch (error) {
      if (error && typeof error === "object") {
        if (!Array.isArray(error.updates)) error.updates = turn.updates;
        if (!Number.isFinite(error.durationMs)) error.durationMs = Date.now() - turn.startedAt;
      }
      throw error;
    } finally {
      if (this.activeTurn?.id === turn.id) {
        this.activeTurn = null;
      }
      this.cancelPendingPermissionsForTurn(turn.id);
    }
  }

  async ensureInitialized() {
    if (this.initialized && this.rpc.running) {
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
    if (authMethods.length > 0 && this.env.XUANNIAO_ACP_SKIP_AUTH !== "1") {
      const ids = authMethods.map((method) => method.id || method.name || "unknown").join(", ");
      throw new Error(
        `ACP agent requires authentication (${ids}). Authenticate the adapter first or set XUANNIAO_ACP_SKIP_AUTH=1 if it can use existing credentials.`
      );
    }
    this.agentCapabilities = init?.agentCapabilities || {};
    this.initialized = true;
  }

  async ensureThreadSession(thread, accessMode = this.accessMode) {
    await this.ensureInitialized();
    const sessionKey = thread.sessionKey || thread.id;
    const activeSession = this.threadSessions.get(sessionKey);
    if (activeSession) {
      await this.enforceSessionAccessMode(activeSession.sessionId, accessMode);
      return { ...activeSession, historyMode: "inherited" };
    }

    const stored = thread.agentSession?.adapter === "acp" ? thread.agentSession : null;
    let sessionId = stored?.sessionId || null;
    let historyMode = "inherited";
    if (sessionId && this.agentCapabilities.loadSession === true) {
      try {
        await this.request("session/load", {
          sessionId,
          cwd: this.cwd,
          mcpServers: []
        });
      } catch {
        sessionId = null;
      }
    } else if (sessionId) {
      sessionId = null;
    }

    if (!sessionId) {
      historyMode = "fresh";
      const session = await this.request("session/new", {
        cwd: this.cwd,
        mcpServers: []
      });
      if (!session?.sessionId) {
        throw new Error("ACP session/new did not return a sessionId");
      }
      sessionId = session.sessionId;
    }

    await this.enforceSessionAccessMode(sessionId, accessMode);

    const active = {
      sessionId,
      documentHash: historyMode === "inherited" ? stored?.documentHash || null : null
    };
    this.threadSessions.set(sessionKey, active);
    return { ...active, historyMode };
  }

  async enforceSessionAccessMode(sessionId, accessMode) {
    if (accessMode === this.accessMode) return;
    await this.request("session/set_mode", {
      sessionId,
      modeId: acpAgentMode(accessMode)
    });
  }

  async startProcess() {
    this.rpc.commandLine = this.commandLine;
    await this.rpc.start();
  }

  request(method, params) {
    return this.rpc.request(method, params).catch((error) => {
      if (error instanceof RpcRequestTimeoutError || error?.code === "RPC_REQUEST_TIMEOUT") {
        this.resetAfterTimeout(error);
      }
      throw error;
    });
  }

  writeMessage(payload) {
    this.rpc.write(payload);
  }

  handleRpcMessage(message) {
    if (message.method) {
      if (Object.hasOwn(message, "id")) {
        void this.handleClientRequest(message).catch((error) => {
          this.rpc.appendDiagnostic(
            `\nFailed to handle ACP client request '${message.method}': ${error instanceof Error ? error.message : String(error)}`
          );
        });
      } else {
        this.handleNotification(message);
      }
    }
  }

  handleProcessExit() {
    this.initialized = false;
    this.agentCapabilities = {};
    this.threadSessions.clear();
  }

  resetAfterTimeout(error) {
    this.cancelPendingPermissions();
    this.initialized = false;
    this.agentCapabilities = {};
    this.threadSessions.clear();
    this.documentSnapshots.clear();
    this.rpc.dispose(
      new Error(`ACP runtime was restarted after a request timeout: ${error.message}`)
    );
  }

  async handleClientRequest(message) {
    try {
      if (message.method === "fs/read_text_file") {
        const result = await this.readTextFile(message.params || {});
        return this.writeClientResponse({ jsonrpc: "2.0", id: message.id, result });
      }

      if (message.method === "fs/write_text_file") {
        const result = await this.writeTextFile(message.params || {});
        return this.writeClientResponse({ jsonrpc: "2.0", id: message.id, result });
      }

      if (message.method === "session/request_permission") {
        this.rpc.pauseRequests("session/prompt");
        try {
          const result = await this.requestUserPermission(message.params || {});
          return this.writeClientResponse({ jsonrpc: "2.0", id: message.id, result });
        } finally {
          this.rpc.resumeRequests("session/prompt");
        }
      }

      return this.writeClientResponse({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported client method: ${message.method}`
        }
      });
    } catch (error) {
      return this.writeClientResponse({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  writeClientResponse(payload) {
    if (!this.rpc.running) return false;
    this.writeMessage(payload);
    return true;
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
    if (options.length === 0) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const id = randomUUID();
    const turn = this.activeTurn;
    return new Promise((resolve) => {
      const finish = (result) => {
        this.pendingPermissions.delete(id);
        resolve(result);
      };
      this.pendingPermissions.set(id, {
        turnId: turn?.id || null,
        resolve: finish,
        snapshot: {
          id,
          sessionId: params.sessionId || turn?.sessionId || "",
          threadId: turn?.threadId || "",
          toolCallId: params.toolCall?.toolCallId || params.toolCallId || "",
          title: params.toolCall?.title || params.title || "Allow agent operation",
          kind: params.toolCall?.kind || "permission",
          status: "pending",
          rawInput: permissionInput(params),
          options,
          createdAt: new Date().toISOString()
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

    this.rpc.touchRequests("session/prompt");
    const compact = compactUpdate(update);
    if (compact) {
      upsertAcpUpdate(this.activeTurn, compact);
      if (typeof this.activeTurn.onUpdate === "function") {
        try {
          this.activeTurn.onUpdate(compact);
        } catch (error) {
          this.rpc.appendDiagnostic(`\nAgent run update listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
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
    if (this.accessMode !== "full-access" || this.activeTurn?.readOnly) {
      throw new Error(`write denied in read-only mode: ${requestedPath}`);
    }
    if (requestedPath === this.documentPath) {
      throw new Error(`write denied for Xuanniao's protected active document: ${requestedPath}`);
    }

    await writeFile(requestedPath, String(params.content ?? ""), "utf8");
    return {};
  }

  get process() {
    return this.rpc.process;
  }

  set process(value) {
    this.rpc.process = value;
  }
}

function normalizePermissionOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => ({
      optionId: String(option.optionId || ""),
      name: String(option.name || option.optionId || "Permission option"),
      kind: String(option.kind || "other")
    }))
    .filter((option) => option.optionId);
}

function permissionInput(params) {
  const value = params.toolCall?.rawInput ?? params.rawInput ?? null;
  if (typeof value === "string") return value.slice(0, 4000);
  if (value && typeof value === "object") return JSON.stringify(value, null, 2).slice(0, 4000);
  return null;
}

export function acpAgentMode(value) {
  return normalizeAgentMode(value) === "full-access" ? "agent-full-access" : "read-only";
}

export function buildPrompt(options) {
  return `${AGENT_DEVELOPER_INSTRUCTIONS}\n\n${buildAgentPrompt(options)}`;
}

function compactUpdate(update) {
  if (update.sessionUpdate === "agent_message_chunk") {
    return null;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const compact = {
      type: "toolCall",
      itemId: update.toolCallId || null
    };
    copyDefined(compact, update, "title");
    copyDefined(compact, update, "kind");
    if (update.status !== undefined && update.status !== null) {
      compact.status = update.status;
    } else if (update.sessionUpdate === "tool_call") {
      compact.status = "inProgress";
    }
    const output = update.content ?? update.rawOutput ?? update.result;
    if (output !== undefined && output !== null) compact.output = displayValue(output);
    return compact;
  }
  if (update.sessionUpdate === "plan") {
    return {
      type: "plan",
      itemId: "turn-plan",
      status: "inProgress",
      plan: Array.isArray(update.entries) ? update.entries.slice(0, 50) : []
    };
  }
  return null;
}

function copyDefined(target, source, key) {
  if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
}

function upsertAcpUpdate(turn, update) {
  const key = update.itemId ? `${update.type}:${update.itemId}` : null;
  if (!key) {
    turn.updates.push(update);
    return;
  }
  const index = turn.updateIndexes.get(key);
  if (index === undefined) {
    turn.updateIndexes.set(key, turn.updates.length);
    turn.updates.push(update);
  } else {
    turn.updates[index] = { ...turn.updates[index], ...update };
  }
}

function displayValue(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 12_000 ? `…${text.slice(-11_999)}` : text;
}
