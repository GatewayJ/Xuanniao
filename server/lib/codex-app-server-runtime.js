import { randomUUID } from "node:crypto";

import { normalizeAgentMode, parseCommandLine } from "./agent-config.js";
import {
  AGENT_DEVELOPER_INSTRUCTIONS,
  DocumentSnapshotCache,
  buildAgentPrompt,
  documentHash
} from "./agent-context.js";
import { JsonLineRpcProcess } from "./json-line-rpc-process.js";
import { normalizeModelCatalog } from "./agent-settings.js";

const adapterName = "codex-app-server";

export class CodexAppServerRuntime {
  constructor({
    documentPath,
    cwd,
    commandLine = "codex app-server",
    accessMode = "full-access",
    timeoutMs = 600_000,
    interruptGraceMs = 5_000,
    model = null,
    reasoningEffort = null,
    contextMaxChars,
    snapshotCacheEntries = 32,
    env = process.env
  }) {
    this.documentPath = documentPath;
    this.cwd = cwd;
    this.commandLine = commandLine;
    this.accessMode = normalizeAgentMode(accessMode);
    this.timeoutMs = timeoutMs;
    this.interruptGraceMs = interruptGraceMs;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.contextMaxChars = contextMaxChars;
    this.env = env;
    this.pendingPermissions = new Map();
    this.turns = new Map();
    this.earlyTurnEvents = new Map();
    this.abandonedTurnIds = new Set();
    this.sessionLocks = new Map();
    this.loadedThreads = new Set();
    this.threadOwners = new Map();
    this.documentSnapshots = new DocumentSnapshotCache(snapshotCacheEntries);
    this.initialized = false;
    this.initializing = null;
    this.rpc = new JsonLineRpcProcess({
      label: "Codex app-server",
      commandLine,
      cwd,
      env,
      timeoutMs,
      emptyCommandMessage: "XUANNIAO_CODEX_CMD is empty",
      onMessage: (message) => this.handleRpcMessage(message),
      onExit: (error) => this.handleProcessExit(error)
    });
  }

  status() {
    return {
      transport: adapterName,
      command: parseCommandLine(this.commandLine),
      accessMode: this.accessMode,
      initialized: this.initialized,
      running: this.rpc.running,
      sessionCount: this.loadedThreads.size,
      pendingPermissions: this.pendingPermissions.size,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      stderrTail: this.rpc.stderrTail,
      capabilities: {
        resume: true,
        fork: true,
        concurrentSessions: true,
        approvalBroker: true,
        incrementalDocumentContext: true,
        eventStream: true,
        structuredUserInput: false,
        mcpElicitation: false,
        dynamicClientTools: false,
        modelSelection: true
      }
    };
  }

  configure({ model = null, reasoningEffort = null } = {}) {
    this.model = optionalString(model);
    this.reasoningEffort = optionalString(reasoningEffort);
  }

  async listModels() {
    await this.ensureInitialized();
    const entries = [];
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 0; page < 20; page += 1) {
      const response = await this.request("model/list", compactObject({
        cursor,
        limit: 100,
        includeHidden: false
      }));
      if (Array.isArray(response?.data)) entries.push(...response.data);
      const nextCursor = optionalString(response?.nextCursor);
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return normalizeModelCatalog(entries);
  }

  async start() {
    await this.ensureInitialized();
  }

  dispose() {
    const error = new Error("Codex app-server runtime closed.");
    this.cancelPendingPermissions();
    this.failRuntimeState(error);
    this.rpc.dispose(error);
    this.initialized = false;
    this.initializing = null;
    this.loadedThreads.clear();
    this.threadOwners.clear();
    this.documentSnapshots.clear();
    this.earlyTurnEvents.clear();
    this.abandonedTurnIds.clear();
  }

  listPermissionRequests() {
    return [...this.pendingPermissions.values()].map((permission) => permission.snapshot);
  }

  resolvePermissionRequest(id, { optionId, cancelled = false }) {
    const permission = this.pendingPermissions.get(id);
    if (!permission) {
      throw new Error(`permission request not found: ${id}`);
    }
    const selected = cancelled ? permission.cancelOption : permission.options.get(optionId);
    if (selected === undefined) {
      throw new Error(`permission option not found: ${optionId}`);
    }
    this.pendingPermissions.delete(id);
    this.writeMessage({ id: permission.requestId, result: selected });
    const turn = (permission.turnId ? this.turns.get(permission.turnId) : null)
      || [...this.turns.values()].find((candidate) => candidate.threadId === permission.sessionId);
    if (turn && !this.hasPendingPermissionsForTurn(turn)) {
      this.refreshTurnTimeout(turn);
    }
  }

  async runTurn({ question, document, thread, mode = "chat" }) {
    const lockKey = thread.sessionKey || thread.id;
    return this.withSessionLock(lockKey, async () => {
      await this.ensureInitialized();
      const session = await this.ensureThread(thread);
      const hash = documentHash(document.content);
      const previousDocument = this.documentSnapshots.get(session.sessionId);
      const includeDocument = session.documentHash !== hash;
      const unsyncedMessages = thread.unsyncedCurrentNodeMessages || [];
      const includeHistory = session.historyMode !== "inherited" || unsyncedMessages.length > 0;
      const history =
        session.historyMode === "inherited" ? unsyncedMessages : session.historyMode === "forked" ? thread.currentNodeMessages || [] : thread.messages || [];
      const prompt = buildAgentPrompt({
        question,
        document,
        thread,
        mode,
        accessMode: this.accessMode,
        includeDocument,
        includeHistory,
        history,
        previousDocument: includeDocument ? (previousDocument ?? null) : null,
        maxChars: this.contextMaxChars
      });

      const start = await this.request(
        "turn/start",
        compactObject({
          threadId: session.sessionId,
          input: [{ type: "text", text: prompt }],
          cwd: this.cwd,
          model: this.model,
          effort: this.reasoningEffort
        })
      );
      const turnId = start?.turn?.id;
      if (!turnId) {
        throw new Error("Codex turn/start did not return a turn id.");
      }

      const result = await this.waitForTurn(session.sessionId, turnId);
      const agentSession = {
        adapter: adapterName,
        sessionId: session.sessionId,
        turnId,
        documentHash: hash
      };
      this.documentSnapshots.set(session.sessionId, document.content);

      return {
        content: result.content || "Codex completed without returning text.",
        stopReason: result.turn?.status ?? null,
        transport: adapterName,
        updates: result.updates.slice(-50),
        session: agentSession
      };
    });
  }

  async ensureInitialized() {
    if (this.initialized && this.rpc.running) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      await this.startProcess();
      await this.request("initialize", {
        clientInfo: {
          name: "xuanniao",
          title: "玄鸟 Xuanniao",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: false
        }
      });
      this.writeMessage({ method: "initialized" });
      this.initialized = true;
    })();

    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async ensureThread(thread) {
    const stored = sessionForAdapter(thread.agentSession, adapterName);
    if (stored) {
      if (!this.loadedThreads.has(stored.sessionId)) {
        try {
          await this.request("thread/resume", this.threadParams({ threadId: stored.sessionId }));
        } catch {
          return this.createThread(thread);
        }
        this.loadedThreads.add(stored.sessionId);
      }
      this.threadOwners.set(stored.sessionId, thread.id);
      return { ...stored, historyMode: "inherited" };
    }

    const parent = sessionForAdapter(thread.parentAgentSession, adapterName);
    if (parent) {
      try {
        const forked = await this.request(
          "thread/fork",
          this.threadParams({
            threadId: parent.sessionId,
            lastTurnId: parent.turnId || null
          })
        );
        const sessionId = forked?.thread?.id;
        if (!sessionId) throw new Error("Codex thread/fork did not return a thread id.");
        this.loadedThreads.add(sessionId);
        this.threadOwners.set(sessionId, thread.id);
        const parentSnapshot = this.documentSnapshots.get(parent.sessionId);
        if (parentSnapshot !== undefined) this.documentSnapshots.set(sessionId, parentSnapshot);
        return {
          sessionId,
          turnId: null,
          documentHash: parent.documentHash,
          historyMode: "forked"
        };
      } catch {
        return this.createThread(thread);
      }
    }

    return this.createThread(thread);
  }

  async createThread(thread) {
    const started = await this.request(
      "thread/start",
      this.threadParams({
        developerInstructions: AGENT_DEVELOPER_INSTRUCTIONS
      })
    );
    const sessionId = started?.thread?.id;
    if (!sessionId) {
      throw new Error("Codex thread/start did not return a thread id.");
    }
    this.loadedThreads.add(sessionId);
    this.threadOwners.set(sessionId, thread.id);
    return {
      sessionId,
      turnId: null,
      documentHash: null,
      historyMode: "fresh"
    };
  }

  threadParams(params) {
    return compactObject({
      ...params,
      cwd: this.cwd,
      sandbox: this.accessMode === "read-only" ? "read-only" : "danger-full-access",
      model: this.model
    });
  }

  async startProcess() {
    this.rpc.commandLine = this.commandLine;
    await this.rpc.start();
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    return this.rpc.request(method, params, timeoutMs);
  }

  writeMessage(payload) {
    this.rpc.write(payload);
  }

  handleRpcMessage(message) {
    if (!message.method) return;
    if (Object.hasOwn(message, "id")) {
      this.handleServerRequest(message);
    } else {
      this.handleNotification(message);
    }
  }

  handleProcessExit(error) {
    this.failRuntimeState(error);
    this.initialized = false;
    this.loadedThreads.clear();
    this.threadOwners.clear();
  }

  handleServerRequest(message) {
    if (isCommandApproval(message.method)) {
      this.queueApproval(message, commandApproval(message.method, message.params || {}));
      return;
    }
    if (isFileApproval(message.method)) {
      this.queueApproval(message, fileApproval(message.method, message.params || {}));
      return;
    }
    if (message.method === "item/permissions/requestApproval") {
      this.queueApproval(message, permissionsApproval(message.params || {}));
      return;
    }
    this.writeMessage({
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported Xuanniao client method: ${message.method}`
      }
    });
  }

  queueApproval(message, approval) {
    const id = randomUUID();
    const sessionId = message.params?.threadId || message.params?.conversationId || message.params?.sessionId || "";
    const requestedTurnId = message.params?.turnId || null;
    const activeTurn = (requestedTurnId ? this.turns.get(requestedTurnId) : null)
      || [...this.turns.values()].find((turn) => turn.threadId === sessionId);
    const turnId = activeTurn?.turnId || requestedTurnId || null;
    const owner = this.threadOwners.get(sessionId) || sessionId;
    this.pendingPermissions.set(id, {
      requestId: message.id,
      sessionId,
      turnId,
      options: new Map(approval.options.map((option) => [option.optionId, option.result])),
      cancelOption: approval.cancelResult,
      snapshot: {
        id,
        sessionId,
        threadId: owner,
        toolCallId: message.params?.itemId || message.params?.callId || "",
        title: approval.title,
        kind: approval.kind,
        status: "pending",
        rawInput: approval.detail,
        options: approval.options.map(({ result: _result, ...option }) => option),
        createdAt: new Date().toISOString()
      }
    });
    if (activeTurn) this.pauseTurnTimeout(activeTurn);
  }

  handleNotification(message) {
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id;
    if (!turnId) return;
    if (this.abandonedTurnIds.has(turnId)) {
      if (message.method === "turn/completed") this.abandonedTurnIds.delete(turnId);
      return;
    }
    const event = { method: message.method, params };
    const active = this.turns.get(turnId);
    if (active) {
      this.applyTurnEvent(active, event);
      return;
    }
    if (!this.earlyTurnEvents.has(turnId) && this.earlyTurnEvents.size >= 64) {
      this.earlyTurnEvents.delete(this.earlyTurnEvents.keys().next().value);
    }
    const early = this.earlyTurnEvents.get(turnId) || [];
    early.push(event);
    this.earlyTurnEvents.set(turnId, early.slice(-100));
  }

  waitForTurn(threadId, turnId) {
    return new Promise((resolve, reject) => {
      const state = {
        threadId,
        turnId,
        chunks: [],
        completedText: "",
        updates: [],
        timer: null,
        interruptTimer: null,
        timeoutError: null,
        settled: false,
        resolve: (value) => {
          if (state.settled) return;
          state.settled = true;
          clearTimeout(state.timer);
          clearTimeout(state.interruptTimer);
          resolve(value);
        },
        reject: (error) => {
          if (state.settled) return;
          state.settled = true;
          clearTimeout(state.timer);
          clearTimeout(state.interruptTimer);
          reject(error);
        }
      };
      this.turns.set(turnId, state);
      this.refreshTurnTimeout(state);
      for (const event of this.earlyTurnEvents.get(turnId) || []) {
        this.applyTurnEvent(state, event);
      }
      this.earlyTurnEvents.delete(turnId);
    });
  }

  refreshTurnTimeout(state) {
    if (
      state.settled
      || state.timeoutError
      || this.turns.get(state.turnId) !== state
      || this.hasPendingPermissionsForTurn(state)
    ) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this.timeoutTurn(state), this.timeoutMs);
  }

  pauseTurnTimeout(state) {
    if (!state || state.settled || this.turns.get(state.turnId) !== state) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  hasPendingPermissionsForTurn(state) {
    return [...this.pendingPermissions.values()].some((permission) => (
      permission.turnId === state.turnId
      || (!permission.turnId && permission.sessionId === state.threadId)
    ));
  }

  timeoutTurn(state) {
    if (state.settled || this.turns.get(state.turnId) !== state || state.timeoutError) return;
    state.timeoutError = new Error(
      `Codex turn timed out and was interrupted after ${this.timeoutMs} ms without activity: ${state.turnId}`
    );
    this.cancelPendingPermissionsForTurn(state.turnId);
    const interruptTimeoutMs = Math.max(10, Math.min(this.interruptGraceMs, this.timeoutMs));
    void this.request(
      "turn/interrupt",
      {
        threadId: state.threadId,
        turnId: state.turnId
      },
      interruptTimeoutMs
    ).catch((error) => {
      this.rpc.appendDiagnostic(`\nFailed to interrupt ${state.turnId}: ${error.message}`);
    });
    state.interruptTimer = setTimeout(() => {
      if (this.turns.get(state.turnId) !== state) return;
      this.turns.delete(state.turnId);
      this.rememberAbandonedTurn(state.turnId);
      state.reject(state.timeoutError);
      const runtimeError = new Error(`Codex app-server was restarted because turn ${state.turnId} did not stop after interruption.`);
      this.rpc.failAll(runtimeError);
      this.failRuntimeState(runtimeError);
      this.initialized = false;
      this.loadedThreads.clear();
      this.threadOwners.clear();
      this.rpc.kill();
    }, this.interruptGraceMs);
  }

  rememberAbandonedTurn(turnId) {
    this.abandonedTurnIds.add(turnId);
    if (this.abandonedTurnIds.size > 256) {
      this.abandonedTurnIds.delete(this.abandonedTurnIds.values().next().value);
    }
  }

  applyTurnEvent(state, { method, params }) {
    if (method !== "turn/completed") this.refreshTurnTimeout(state);
    if (method === "item/agentMessage/delta") {
      state.chunks.push(params.delta || "");
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item || {};
      state.updates.push(compactItemUpdate(method, item));
      if (method === "item/completed" && item.type === "agentMessage") {
        state.completedText = item.text || state.completedText;
      }
      return;
    }
    if (method === "error" && params.willRetry === false) {
      state.updates.push({
        type: "error",
        message: params.error?.message || "Codex turn error"
      });
      return;
    }
    if (method === "turn/completed") {
      this.turns.delete(state.turnId);
      this.cancelPendingPermissionsForTurn(state.turnId);
      const content = state.chunks.join("").trim() || state.completedText.trim();
      if (state.timeoutError) {
        state.reject(state.timeoutError);
      } else if (params.turn?.status === "failed") {
        state.reject(new Error(params.turn?.error?.message || "Codex turn failed."));
      } else {
        state.resolve({ content, turn: params.turn, updates: state.updates });
      }
    }
  }

  async withSessionLock(key, task) {
    const previous = this.sessionLocks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.sessionLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.sessionLocks.get(key) === current) {
        this.sessionLocks.delete(key);
      }
    }
  }

  cancelPendingPermissions() {
    for (const [id, permission] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      try {
        this.writeMessage({
          id: permission.requestId,
          result: permission.cancelOption
        });
      } catch {
        // The process is already unavailable.
      }
    }
  }

  cancelPendingPermissionsForTurn(turnId) {
    for (const [id, permission] of this.pendingPermissions) {
      if (permission.turnId !== turnId) continue;
      this.pendingPermissions.delete(id);
      try {
        this.writeMessage({
          id: permission.requestId,
          result: permission.cancelOption
        });
      } catch {
        // The process is already unavailable.
      }
    }
  }

  failRuntimeState(error) {
    for (const [turnId, turn] of this.turns) {
      this.turns.delete(turnId);
      turn.reject(error);
    }
    this.pendingPermissions.clear();
    this.earlyTurnEvents.clear();
  }

  get process() {
    return this.rpc.process;
  }

  set process(value) {
    this.rpc.process = value;
  }
}

function sessionForAdapter(value, adapter) {
  if (!value || value.adapter !== adapter || !value.sessionId) return null;
  return {
    sessionId: value.sessionId,
    turnId: value.turnId || null,
    documentHash: value.documentHash || null
  };
}

function isCommandApproval(method) {
  return method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
}

function isFileApproval(method) {
  return method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
}

function commandApproval(method, params) {
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  const title = command ? `Allow command: ${shortText(command, 180)}` : shortText(params.reason, 180) || "Allow command execution";
  return decisionApproval(method, title, "command", permissionDetail(params, ["command", "cwd", "reason"]));
}

function fileApproval(method, params) {
  return decisionApproval(
    method,
    shortText(params.reason, 180) || "Allow proposed file changes",
    "file-change",
    permissionDetail(params, ["reason", "grantRoot"])
  );
}

function decisionApproval(method, title, kind, detail) {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return legacyDecisionApproval(title, kind, detail);
  }
  return {
    title,
    kind,
    detail,
    options: [
      {
        optionId: "accept",
        name: "Allow once",
        kind: "allow_once",
        result: { decision: "accept" }
      },
      {
        optionId: "acceptForSession",
        name: "Allow for session",
        kind: "allow_always",
        result: { decision: "acceptForSession" }
      },
      {
        optionId: "decline",
        name: "Reject",
        kind: "reject_once",
        result: { decision: "decline" }
      }
    ],
    cancelResult: { decision: "cancel" }
  };
}

function legacyDecisionApproval(title, kind, detail) {
  return {
    title,
    kind,
    detail,
    options: [
      {
        optionId: "accept",
        name: "Allow once",
        kind: "allow_once",
        result: { decision: "approved" }
      },
      {
        optionId: "acceptForSession",
        name: "Allow for session",
        kind: "allow_always",
        result: { decision: "approved_for_session" }
      },
      {
        optionId: "decline",
        name: "Reject",
        kind: "reject_once",
        result: {
          decision: {
            denied: {
              rejection: "The user declined this operation."
            }
          }
        }
      }
    ],
    cancelResult: { decision: "abort" }
  };
}

function permissionsApproval(params) {
  const permissions = params.permissions || {};
  return {
    title: shortText(params.reason, 180) || "Allow additional runtime permissions",
    kind: "permissions",
    detail: permissionDetail(params, ["reason", "cwd", "permissions"]),
    options: [
      {
        optionId: "accept",
        name: "Allow once",
        kind: "allow_once",
        result: { permissions, scope: "turn" }
      },
      {
        optionId: "acceptForSession",
        name: "Allow for session",
        kind: "allow_always",
        result: { permissions, scope: "session" }
      },
      {
        optionId: "decline",
        name: "Reject",
        kind: "reject_once",
        result: { permissions: {}, scope: "turn" }
      }
    ],
    cancelResult: { permissions: {}, scope: "turn" }
  };
}

function permissionDetail(params, keys) {
  const detail = Object.fromEntries(keys.filter((key) => params[key] !== null && params[key] !== undefined).map((key) => [key, params[key]]));
  return Object.keys(detail).length > 0 ? JSON.stringify(detail, null, 2).slice(0, 4000) : null;
}

function shortText(value, limit) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function compactItemUpdate(method, item) {
  return {
    type: item.type || "unknown",
    status: method === "item/completed" ? item.status || "completed" : item.status || "inProgress",
    itemId: item.id || null,
    command: item.type === "commandExecution" ? item.command : undefined,
    exitCode: item.type === "commandExecution" ? item.exitCode : undefined,
    tool: item.type === "mcpToolCall" ? item.tool : undefined
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function optionalString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
