import { randomUUID } from "node:crypto";

import { parseCommandLine } from "./agent-config.js";
import {
  AGENT_DEVELOPER_INSTRUCTIONS,
  DocumentSnapshotCache,
  buildAgentPrompt,
  documentHash
} from "./agent-context.js";
import { JsonLineRpcProcess } from "./json-line-rpc-process.js";
import { normalizeAgentPermissionMode, normalizeModelCatalog } from "./agent-settings.js";

const adapterName = "codex-app-server";
const COMMAND_OUTPUT_BATCH_MS = 75;
const MAX_PERSISTED_UPDATES = 120;

export class CodexAppServerRuntime {
  constructor({
    documentPath,
    cwd,
    commandLine = "codex app-server",
    timeoutMs = 600_000,
    interruptGraceMs = 5_000,
    model = null,
    reasoningEffort = null,
    permissionMode = "request-approval",
    contextMaxChars,
    snapshotCacheEntries = 32,
    env = process.env
  }) {
    this.documentPath = documentPath;
    this.cwd = cwd;
    this.commandLine = commandLine;
    this.timeoutMs = timeoutMs;
    this.interruptGraceMs = interruptGraceMs;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.permissionMode = normalizeAgentPermissionMode(permissionMode);
    this.contextMaxChars = contextMaxChars;
    this.env = env;
    this.pendingPermissions = new Map();
    this.turns = new Map();
    this.earlyTurnEvents = new Map();
    this.pendingSubagentThreads = new Map();
    this.startingRootThreads = new Set();
    this.subagentOwners = new Map();
    this.abandonedTurnIds = new Set();
    this.sessionLocks = new Map();
    this.loadedThreads = new Set();
    this.threadOwners = new Map();
    this.threadSettings = new Map();
    this.threadPermissionModes = new Map();
    this.modelCatalog = null;
    this.modelCatalogRequest = null;
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
      accessMode: permissionAccessMode(this.permissionMode),
      permissionMode: this.permissionMode,
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
        modelSelection: true,
        permissionSelection: true
      }
    };
  }

  configure({ model = null, reasoningEffort = null, permissionMode = "request-approval" } = {}) {
    this.model = optionalString(model);
    this.reasoningEffort = optionalString(reasoningEffort);
    this.permissionMode = normalizeAgentPermissionMode(permissionMode);
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

    const catalog = normalizeModelCatalog(entries);
    this.modelCatalog = catalog;
    return catalog;
  }

  async cachedModelCatalog() {
    if (this.modelCatalog) return this.modelCatalog;
    if (!this.modelCatalogRequest) {
      this.modelCatalogRequest = this.listModels().finally(() => {
        this.modelCatalogRequest = null;
      });
    }
    return this.modelCatalogRequest;
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
    this.threadSettings.clear();
    this.threadPermissionModes.clear();
    this.modelCatalog = null;
    this.modelCatalogRequest = null;
    this.documentSnapshots.clear();
    this.earlyTurnEvents.clear();
    this.pendingSubagentThreads.clear();
    this.startingRootThreads.clear();
    this.subagentOwners.clear();
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

  async runTurn({ question, document, thread, mode = "chat", onUpdate = null }) {
    const lockKey = thread.sessionKey || thread.id;
    return this.withSessionLock(lockKey, async () => {
      await this.ensureInitialized();
      const turnPermissionMode = mode === "create-document"
        ? documentPermissionMode(this.permissionMode)
        : this.permissionMode;
      const turnAccessMode = mode === "create-document"
        ? "read-only"
        : permissionAccessMode(this.permissionMode);
      const session = await this.ensureThread(thread, turnPermissionMode);
      const effectiveSettings = await this.resolveTurnSettings(session);
      const hash = documentHash(document.content);
      const previousDocument = this.documentSnapshots.get(session.sessionId);
      const includeDocument = session.documentHash !== hash;
      const supplementalHistory = session.historyMode === "fresh"
        ? thread.messages || []
        : session.historyMode === "resumed"
          ? thread.unsyncedCurrentNodeMessages || []
          : [];
      const prompt = buildAgentPrompt({
        question,
        document,
        thread,
        mode,
        accessMode: turnAccessMode,
        includeDocument,
        supplementalHistory,
        previousDocument: includeDocument ? (previousDocument ?? null) : null,
        maxChars: this.contextMaxChars
      });

      this.prepareRootTurnStart(session.sessionId);
      let start;
      try {
        start = await this.request(
          "turn/start",
          compactObject({
            threadId: session.sessionId,
            input: [{ type: "text", text: prompt }],
            cwd: this.cwd,
            model: effectiveSettings.model,
            effort: effectiveSettings.reasoningEffort
          })
        );
      } catch (error) {
        this.cancelRootTurnStart(session.sessionId);
        throw error;
      }
      const turnId = start?.turn?.id;
      if (!turnId) {
        this.cancelRootTurnStart(session.sessionId);
        throw new Error("Codex turn/start did not return a turn id.");
      }
      this.threadSettings.set(session.sessionId, effectiveSettings);
      const turnResult = this.waitForTurn(session.sessionId, turnId, { onUpdate });
      this.startingRootThreads.delete(session.sessionId);

      let result;
      try {
        result = await turnResult;
      } catch (error) {
        if (error && typeof error === "object") {
          if (Array.isArray(error.updates)) {
            error.updates = selectPersistentUpdates(error.updates, MAX_PERSISTED_UPDATES);
          }
          error.model = effectiveSettings.model;
          error.reasoningEffort = effectiveSettings.reasoningEffort;
        }
        throw error;
      }
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
        updates: selectPersistentUpdates(result.updates, MAX_PERSISTED_UPDATES),
        durationMs: result.durationMs,
        model: effectiveSettings.model,
        reasoningEffort: effectiveSettings.reasoningEffort,
        session: agentSession
      };
    });
  }

  async resolveTurnSettings(session) {
    let catalog = this.modelCatalog;
    if ((!this.model || !this.reasoningEffort) && !catalog) {
      try {
        catalog = await this.cachedModelCatalog();
      } catch {
        catalog = [];
      }
    }
    const selectedModel = this.model
      ? catalog?.find((candidate) => candidate.model === this.model || candidate.id === this.model) || null
      : catalog?.find((candidate) => candidate.isDefault) || catalog?.[0] || null;
    const model = this.model || selectedModel?.model || session.model || null;
    const sessionReasoningEffort = !session.model || session.model === model
      ? session.reasoningEffort
      : null;
    return {
      model,
      reasoningEffort: this.reasoningEffort
        || selectedModel?.defaultReasoningEffort
        || sessionReasoningEffort
        || null
    };
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

  async ensureThread(thread, permissionMode = this.permissionMode) {
    if (isDocumentPermissionMode(permissionMode)) {
      return this.createThread(thread, permissionMode);
    }
    const stored = sessionForAdapter(thread.agentSession, adapterName);
    if (stored) {
      if (!this.loadedThreads.has(stored.sessionId)) {
        try {
          const resumed = await this.request(
            "thread/resume",
            this.threadParams({ threadId: stored.sessionId }, permissionMode)
          );
          this.rememberThreadSettings(stored.sessionId, resumed);
          this.threadPermissionModes.set(stored.sessionId, permissionMode);
        } catch {
          return this.createThread(thread, permissionMode);
        }
        this.loadedThreads.add(stored.sessionId);
      } else if (
        this.threadPermissionModes.has(stored.sessionId)
        && this.threadPermissionModes.get(stored.sessionId) !== permissionMode
      ) {
        return this.createThread(thread, permissionMode);
      }
      this.threadOwners.set(stored.sessionId, thread.id);
      return {
        ...stored,
        historyMode: "resumed",
        ...this.settingsForThread(stored.sessionId)
      };
    }

    const parent = sessionForAdapter(thread.parentAgentSession, adapterName);
    if (parent) {
      try {
        const forked = await this.request(
          "thread/fork",
          this.threadParams({
            threadId: parent.sessionId,
            lastTurnId: parent.turnId || null
          }, permissionMode)
        );
        const sessionId = forked?.thread?.id;
        if (!sessionId) throw new Error("Codex thread/fork did not return a thread id.");
        this.loadedThreads.add(sessionId);
        this.threadOwners.set(sessionId, thread.id);
        this.rememberThreadSettings(sessionId, forked);
        this.threadPermissionModes.set(sessionId, permissionMode);
        return {
          sessionId,
          turnId: null,
          documentHash: parent.documentHash,
          historyMode: "inherited",
          ...this.settingsForThread(sessionId)
        };
      } catch {
        return this.createThread(thread, permissionMode);
      }
    }

    return this.createThread(thread, permissionMode);
  }

  async createThread(thread, permissionMode = this.permissionMode) {
    const started = await this.request(
      "thread/start",
      this.threadParams({
        developerInstructions: AGENT_DEVELOPER_INSTRUCTIONS
      }, permissionMode)
    );
    const sessionId = started?.thread?.id;
    if (!sessionId) {
      throw new Error("Codex thread/start did not return a thread id.");
    }
    this.loadedThreads.add(sessionId);
    this.threadOwners.set(sessionId, thread.id);
    this.rememberThreadSettings(sessionId, started);
    this.threadPermissionModes.set(sessionId, permissionMode);
    return {
      sessionId,
      turnId: null,
      documentHash: null,
      historyMode: "fresh",
      ...this.settingsForThread(sessionId)
    };
  }

  rememberThreadSettings(sessionId, response) {
    const previous = this.threadSettings.get(sessionId) || {};
    this.threadSettings.set(sessionId, {
      model: optionalString(response?.model) || previous.model || null,
      reasoningEffort: optionalString(response?.reasoningEffort) || previous.reasoningEffort || null
    });
  }

  settingsForThread(sessionId) {
    return this.threadSettings.get(sessionId) || { model: null, reasoningEffort: null };
  }

  threadParams(params, permissionMode = this.permissionMode) {
    return {
      ...compactObject({
        ...params,
        cwd: this.cwd,
        model: this.model,
        developerInstructions: AGENT_DEVELOPER_INSTRUCTIONS
      }),
      ...codexThreadPermissionParams(permissionMode)
    };
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
    this.threadSettings.clear();
    this.threadPermissionModes.clear();
    this.pendingSubagentThreads.clear();
    this.startingRootThreads.clear();
    this.subagentOwners.clear();
    this.modelCatalog = null;
    this.modelCatalogRequest = null;
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
    const subagentOwner = this.subagentOwners.get(sessionId);
    const activeTurn = (requestedTurnId ? this.turns.get(requestedTurnId) : null)
      || [...this.turns.values()].find((turn) => turn.threadId === sessionId)
      || subagentOwner?.state;
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
        sourceThreadId: sessionId,
        sourceAgentName: subagentOwner?.agentName || subagentOwner?.agentRole || null,
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
    if (message.method === "thread/started") {
      this.handleThreadStarted(params.thread);
      return;
    }
    if (message.method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }
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
    const subagent = this.subagentOwners.get(params.threadId);
    if (subagent) {
      this.applySubagentTurnEvent(subagent, event);
      return;
    }
    if (!this.earlyTurnEvents.has(turnId) && this.earlyTurnEvents.size >= 64) {
      this.earlyTurnEvents.delete(this.earlyTurnEvents.keys().next().value);
    }
    const early = this.earlyTurnEvents.get(turnId) || [];
    early.push(event);
    this.earlyTurnEvents.set(turnId, early.slice(-100));
  }

  handleThreadStarted(thread) {
    if (!thread?.id || !thread.parentThreadId) return;
    const parentOwner = this.subagentOwners.get(thread.parentThreadId);
    const state = parentOwner?.state
      || [...this.turns.values()].find((turn) => turn.threadId === thread.parentThreadId);
    if (!state) {
      const knownInactiveRoot = this.threadOwners.has(thread.parentThreadId)
        && !this.subagentOwners.has(thread.parentThreadId)
        && !this.startingRootThreads.has(thread.parentThreadId);
      if (knownInactiveRoot) return;
      const pending = this.pendingSubagentThreads.get(thread.parentThreadId) || [];
      pending.push(thread);
      this.pendingSubagentThreads.set(thread.parentThreadId, pending.slice(-32));
      if (this.pendingSubagentThreads.size > 64) {
        this.pendingSubagentThreads.delete(this.pendingSubagentThreads.keys().next().value);
      }
      return;
    }
    this.registerSubagent(state, {
      threadId: thread.id,
      parentThreadId: thread.parentThreadId,
      agentName: thread.agentNickname,
      agentRole: thread.agentRole,
      task: thread.preview,
      agentStatus: threadStatusToAgentStatus(thread.status)
    });
  }

  handleThreadStatusChanged({ threadId, status }) {
    const owner = this.subagentOwners.get(threadId);
    if (!owner) return;
    this.registerSubagent(owner.state, {
      threadId,
      parentThreadId: owner.parentThreadId,
      agentStatus: threadStatusToAgentStatus(status)
    });
  }

  replayPendingSubagentThreads(parentThreadId, state) {
    const pending = this.pendingSubagentThreads.get(parentThreadId) || [];
    this.pendingSubagentThreads.delete(parentThreadId);
    for (const thread of pending) this.handleThreadStarted(thread);
    if (pending.length === 0) return;
    for (const thread of pending) {
      const owner = this.subagentOwners.get(thread.id);
      if (owner?.state !== state) continue;
      this.replayPendingSubagentThreads(thread.id, state);
    }
  }

  prepareRootTurnStart(threadId) {
    this.discardPendingSubagentTree(threadId);
    this.startingRootThreads.add(threadId);
  }

  cancelRootTurnStart(threadId) {
    this.startingRootThreads.delete(threadId);
    this.discardPendingSubagentTree(threadId);
  }

  discardPendingSubagentTree(parentThreadId) {
    const pendingParents = [parentThreadId];
    const visited = new Set();
    while (pendingParents.length > 0) {
      const parent = pendingParents.pop();
      if (!parent || visited.has(parent)) continue;
      visited.add(parent);
      const children = this.pendingSubagentThreads.get(parent) || [];
      this.pendingSubagentThreads.delete(parent);
      for (const child of children) {
        if (child?.id) pendingParents.push(child.id);
      }
    }
  }

  discardPendingSubagentsForState(state) {
    this.discardPendingSubagentTree(state.threadId);
    for (const owner of this.subagentOwners.values()) {
      if (owner.state === state) this.discardPendingSubagentTree(owner.threadId);
    }
  }

  registerSubagent(state, details) {
    const threadId = optionalString(details.threadId);
    if (!threadId) return null;
    const existing = this.subagentOwners.get(threadId);
    const now = Date.now();
    const owner = {
      state,
      threadId,
      parentThreadId: optionalString(details.parentThreadId) || existing?.parentThreadId || state.threadId,
      agentName: optionalString(details.agentName) || existing?.agentName || null,
      agentRole: optionalString(details.agentRole) || existing?.agentRole || null,
      task: optionalString(details.task) || existing?.task || null,
      model: optionalString(details.model) || existing?.model || null,
      reasoningEffort: optionalString(details.reasoningEffort) || existing?.reasoningEffort || null,
      agentStatus: optionalString(details.agentStatus) || existing?.agentStatus || "running",
      result: optionalString(details.result) || existing?.result || null,
      startedAt: existing?.startedAt || now,
      durationMs: existing?.durationMs ?? null
    };
    if (isTerminalSubagentStatus(owner.agentStatus)) {
      owner.durationMs = existing?.durationMs ?? Math.max(0, now - owner.startedAt);
    }
    this.subagentOwners.set(threadId, owner);
    const xuanniaoThreadId = this.threadOwners.get(state.threadId);
    if (xuanniaoThreadId) this.threadOwners.set(threadId, xuanniaoThreadId);
    this.adoptPendingSubagentPermissions(owner, xuanniaoThreadId || state.threadId);
    const update = subagentLifecycleUpdate(owner);
    upsertTurnUpdate(state, update);
    this.emitTurnUpdate(state, update);
    this.replayPendingSubagentThreads(threadId, state);
    this.replayEarlySubagentEvents(owner);
    return owner;
  }

  adoptPendingSubagentPermissions(owner, xuanniaoThreadId) {
    let adopted = false;
    for (const permission of this.pendingPermissions.values()) {
      if (permission.sessionId !== owner.threadId) continue;
      permission.turnId = owner.state.turnId;
      permission.snapshot.threadId = xuanniaoThreadId;
      permission.snapshot.sourceThreadId = owner.threadId;
      permission.snapshot.sourceAgentName = owner.agentName || owner.agentRole || null;
      adopted = true;
    }
    if (adopted) this.pauseTurnTimeout(owner.state);
  }

  replayEarlySubagentEvents(owner) {
    for (const [turnId, events] of this.earlyTurnEvents) {
      if (!events.some((event) => event.params?.threadId === owner.threadId)) continue;
      this.earlyTurnEvents.delete(turnId);
      for (const event of events) this.applySubagentTurnEvent(owner, event);
    }
  }

  waitForTurn(threadId, turnId, { onUpdate = null } = {}) {
    return new Promise((resolve, reject) => {
      const state = {
        threadId,
        turnId,
        chunks: [],
        completedText: "",
        updates: [],
        updateIndexes: new Map(),
        commandOutput: new Map(),
        pendingCommandOutput: new Map(),
        pendingCommandMetadata: new Map(),
        reasoningSummary: new Map(),
        subagentMessages: new Map(),
        onUpdate,
        startedAt: Date.now(),
        timer: null,
        interruptTimer: null,
        commandOutputTimer: null,
        timeoutError: null,
        settled: false,
        resolve: (value) => {
          if (state.settled) return;
          state.settled = true;
          clearTimeout(state.timer);
          clearTimeout(state.interruptTimer);
          clearTimeout(state.commandOutputTimer);
          resolve(value);
        },
        reject: (error) => {
          if (state.settled) return;
          state.settled = true;
          clearTimeout(state.timer);
          clearTimeout(state.interruptTimer);
          clearTimeout(state.commandOutputTimer);
          if (error && typeof error === "object") {
            if (!Array.isArray(error.updates)) error.updates = state.updates;
            if (!Number.isFinite(error.durationMs)) error.durationMs = Date.now() - state.startedAt;
          }
          reject(error);
        }
      };
      this.turns.set(turnId, state);
      this.replayPendingSubagentThreads(threadId, state);
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
      this.threadSettings.clear();
      this.modelCatalog = null;
      this.modelCatalogRequest = null;
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
    if (method === "item/commandExecution/outputDelta") {
      const itemId = params.itemId || null;
      const delta = boundedText(params.delta, 4_000);
      if (!delta) return;
      const itemKey = turnItemKey(null, itemId);
      if (itemId) {
        state.commandOutput.set(
          itemKey,
          boundedTail(`${state.commandOutput.get(itemKey) || ""}${delta}`, 12_000)
        );
      }
      this.enqueueCommandOutput(state, itemId, delta);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const itemId = params.itemId || null;
      const delta = boundedText(params.delta, 2_000);
      if (!delta) return;
      const itemKey = turnItemKey(null, itemId);
      if (itemId) {
        state.reasoningSummary.set(
          itemKey,
          boundedTail(`${state.reasoningSummary.get(itemKey) || ""}${delta}`, 8_000)
        );
      }
      this.emitTurnUpdate(state, {
        type: "reasoning",
        status: "inProgress",
        itemId,
        summaryDelta: delta
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (method === "item/completed") this.flushCommandOutput(state);
      const item = params.item || {};
      if (isCollaborationItem(item)) {
        this.applyCollaborationItem(state, method, item);
        return;
      }
      const update = compactItemUpdate(method, item, {
        commandOutput: state.commandOutput.get(turnItemKey(null, item.id)),
        reasoningSummary: state.reasoningSummary.get(turnItemKey(null, item.id))
      });
      if (update) {
        upsertTurnUpdate(state, update);
        this.emitTurnUpdate(state, update);
      }
      if (method === "item/completed" && item.type === "agentMessage") {
        state.completedText = item.text || state.completedText;
      }
      return;
    }
    if (method === "turn/plan/updated") {
      const update = compactPlanUpdate(params);
      upsertTurnUpdate(state, update);
      this.emitTurnUpdate(state, update);
      return;
    }
    if (method === "turn/diff/updated") {
      const update = compactDiffUpdate(params);
      if (!update) return;
      upsertTurnUpdate(state, update);
      this.emitTurnUpdate(state, update);
      return;
    }
    if (method === "error" && params.willRetry === false) {
      const update = {
        type: "error",
        status: "failed",
        message: params.error?.message || "Codex turn error"
      };
      state.updates.push(update);
      this.emitTurnUpdate(state, update);
      return;
    }
    if (method === "turn/completed") {
      this.flushCommandOutput(state);
      this.finalizeSubagentsForState(state, params.turn?.status);
      this.discardPendingSubagentsForState(state);
      this.turns.delete(state.turnId);
      this.cancelPendingPermissionsForTurn(state.turnId);
      const content = state.chunks.join("").trim() || state.completedText.trim();
      if (state.timeoutError) {
        state.reject(state.timeoutError);
      } else if (params.turn?.status === "failed") {
        const error = new Error(params.turn?.error?.message || "Codex turn failed.");
        error.updates = state.updates;
        error.durationMs = Date.now() - state.startedAt;
        state.reject(error);
      } else {
        state.resolve({
          content,
          turn: params.turn,
          updates: state.updates,
          durationMs: Date.now() - state.startedAt
        });
      }
      this.releaseSubagentsForState(state);
    }
  }

  applyCollaborationItem(state, method, item) {
    for (const details of collaborationReferences(method, item, state.threadId)) {
      this.registerSubagent(state, details);
    }
  }

  applySubagentTurnEvent(owner, { method, params }) {
    const state = owner.state;
    if (state.settled) return;
    if (method !== "turn/completed") this.refreshTurnTimeout(state);
    const scope = subagentScope(owner);
    if (method === "item/agentMessage/delta") {
      const key = turnItemKey(owner.threadId, params.itemId);
      state.subagentMessages.set(
        key,
        boundedTail(`${state.subagentMessages.get(key) || ""}${params.delta || ""}`, 12_000)
      );
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = params.itemId || null;
      const delta = boundedText(params.delta, 4_000);
      if (!delta) return;
      const itemKey = turnItemKey(owner.threadId, itemId);
      if (itemId) {
        state.commandOutput.set(
          itemKey,
          boundedTail(`${state.commandOutput.get(itemKey) || ""}${delta}`, 12_000)
        );
      }
      this.enqueueCommandOutput(state, itemId, delta, scope);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const itemId = params.itemId || null;
      const delta = boundedText(params.delta, 2_000);
      if (!delta) return;
      const itemKey = turnItemKey(owner.threadId, itemId);
      if (itemId) {
        state.reasoningSummary.set(
          itemKey,
          boundedTail(`${state.reasoningSummary.get(itemKey) || ""}${delta}`, 8_000)
        );
      }
      this.emitTurnUpdate(state, {
        ...scope,
        type: "reasoning",
        status: "inProgress",
        itemId,
        summaryDelta: delta
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (method === "item/completed") this.flushCommandOutput(state);
      const item = params.item || {};
      if (isCollaborationItem(item)) {
        this.applyCollaborationItem(state, method, item);
        return;
      }
      if (item.type === "agentMessage") {
        if (method === "item/completed") {
          const result = item.text || state.subagentMessages.get(turnItemKey(owner.threadId, item.id));
          if (result) this.registerSubagent(state, { threadId: owner.threadId, result });
        }
        return;
      }
      const update = compactItemUpdate(method, item, {
        commandOutput: state.commandOutput.get(turnItemKey(owner.threadId, item.id)),
        reasoningSummary: state.reasoningSummary.get(turnItemKey(owner.threadId, item.id))
      });
      if (!update) return;
      const scoped = { ...scope, ...update };
      upsertTurnUpdate(state, scoped);
      this.emitTurnUpdate(state, scoped);
      return;
    }
    if (method === "turn/plan/updated") {
      const update = { ...scope, ...compactPlanUpdate(params) };
      upsertTurnUpdate(state, update);
      this.emitTurnUpdate(state, update);
      return;
    }
    if (method === "turn/diff/updated") {
      const compact = compactDiffUpdate(params);
      if (!compact) return;
      const update = { ...scope, ...compact };
      upsertTurnUpdate(state, update);
      this.emitTurnUpdate(state, update);
      return;
    }
    if (method === "error" && params.willRetry === false) {
      const update = {
        ...scope,
        type: "error",
        status: "failed",
        message: params.error?.message || "Codex subagent error"
      };
      state.updates.push(update);
      this.emitTurnUpdate(state, update);
      this.registerSubagent(state, { threadId: owner.threadId, agentStatus: "errored" });
      return;
    }
    if (method === "turn/completed") {
      this.flushCommandOutput(state);
      const turnStatus = params.turn?.status;
      this.registerSubagent(state, {
        threadId: owner.threadId,
        agentStatus: turnStatus === "completed"
          ? "completed"
          : turnStatus === "interrupted"
            ? "interrupted"
            : "errored"
      });
    }
  }

  releaseSubagentsForState(state) {
    for (const [threadId, owner] of this.subagentOwners) {
      if (owner.state !== state) continue;
      this.subagentOwners.delete(threadId);
      this.threadOwners.delete(threadId);
    }
  }

  finalizeSubagentsForState(state, rootStatus) {
    for (const owner of this.subagentOwners.values()) {
      if (owner.state !== state || isTerminalSubagentStatus(owner.agentStatus)) continue;
      this.registerSubagent(state, {
        threadId: owner.threadId,
        agentStatus: rootStatus === "completed" ? "interrupted" : "errored"
      });
    }
  }

  emitTurnUpdate(state, update) {
    if (typeof state.onUpdate !== "function") return;
    try {
      state.onUpdate(update);
    } catch (error) {
      this.rpc.appendDiagnostic(`\nAgent run update listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  enqueueCommandOutput(state, itemId, delta, metadata = {}) {
    const key = turnItemKey(metadata.agentThreadId, itemId);
    state.pendingCommandOutput.set(
      key,
      boundedTail(`${state.pendingCommandOutput.get(key) || ""}${delta}`, 12_000)
    );
    state.pendingCommandMetadata.set(key, { ...metadata, itemId: itemId || null });
    if (state.commandOutputTimer) return;
    state.commandOutputTimer = setTimeout(() => this.flushCommandOutput(state), COMMAND_OUTPUT_BATCH_MS);
    state.commandOutputTimer.unref?.();
  }

  flushCommandOutput(state) {
    clearTimeout(state.commandOutputTimer);
    state.commandOutputTimer = null;
    if (state.settled || state.pendingCommandOutput.size === 0) return;
    const pending = [...state.pendingCommandOutput];
    state.pendingCommandOutput.clear();
    for (const [key, outputDelta] of pending) {
      const metadata = state.pendingCommandMetadata.get(key) || { itemId: null };
      state.pendingCommandMetadata.delete(key);
      this.emitTurnUpdate(state, {
        ...metadata,
        type: "commandExecution",
        status: "inProgress",
        outputDelta
      });
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
    this.pendingSubagentThreads.clear();
    this.startingRootThreads.clear();
    this.subagentOwners.clear();
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

function compactItemUpdate(method, item, accumulated = {}) {
  if (item.type === "agentMessage" || item.type === "userMessage") return null;
  const update = {
    type: item.type || "unknown",
    status: method === "item/completed" ? item.status || "completed" : item.status || "inProgress",
    itemId: item.id || null
  };
  if (item.type === "commandExecution") {
    update.command = boundedText(item.command, 2_000);
    update.cwd = boundedText(item.cwd, 1_000);
    update.output = boundedTail(item.aggregatedOutput || accumulated.commandOutput, 12_000);
    update.exitCode = Number.isInteger(item.exitCode) ? item.exitCode : null;
    update.durationMs = Number.isFinite(item.durationMs) ? item.durationMs : null;
  } else if (item.type === "fileChange") {
    update.changes = Array.isArray(item.changes)
      ? item.changes.slice(0, 50).map((change) => compactObject({
          path: boundedText(change.path, 1_000),
          kind: change.kind || null,
          diff: boundedText(change.diff, 8_000)
        }))
      : [];
  } else if (item.type === "mcpToolCall") {
    update.server = boundedText(item.server, 200);
    update.tool = boundedText(item.tool, 300);
    update.result = boundedText(stringifyDisplayValue(item.result), 12_000);
    update.error = boundedText(stringifyDisplayValue(item.error), 4_000);
  } else if (item.type === "dynamicToolCall") {
    update.tool = boundedText(item.tool, 300);
    update.result = boundedText(stringifyDisplayValue(item.contentItems || item.result), 12_000);
  } else if (item.type === "webSearch") {
    update.query = boundedText(item.query, 2_000);
    update.action = boundedText(stringifyDisplayValue(item.action), 4_000);
  } else if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : item.summary;
    update.summary = boundedText(summary || accumulated.reasoningSummary, 8_000);
  } else if (item.type === "imageView") {
    update.path = boundedText(item.path, 1_000);
  }
  return compactObject(update);
}

function compactPlanUpdate(params) {
  const plan = Array.isArray(params.plan)
    ? params.plan.slice(0, 50).map((entry) => compactObject({
        step: boundedText(entry.step, 1_000),
        status: entry.status || null
      }))
    : [];
  return {
    type: "plan",
    status: plan.length > 0 && plan.every((entry) => entry.status === "completed")
      ? "completed"
      : "inProgress",
    itemId: "turn-plan",
    explanation: boundedText(params.explanation, 4_000),
    plan
  };
}

function compactDiffUpdate(params) {
  const summary = summarizeUnifiedDiff(params.diff);
  if (!summary) return null;
  return {
    type: "diff",
    status: "inProgress",
    itemId: "turn-diff",
    ...summary
  };
}

export function summarizeUnifiedDiff(value) {
  if (typeof value !== "string") return null;
  const lines = value.split(/\r?\n/);
  const files = new Set();
  const fallbackFiles = new Set();
  let additions = 0;
  let deletions = 0;
  let oldLinesRemaining = 0;
  let newLinesRemaining = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      files.add(line);
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLinesRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLinesRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (inHunk) {
      if (line.startsWith("+")) {
        additions += 1;
        newLinesRemaining = Math.max(0, newLinesRemaining - 1);
      } else if (line.startsWith("-")) {
        deletions += 1;
        oldLinesRemaining = Math.max(0, oldLinesRemaining - 1);
      } else if (!line.startsWith("\\")) {
        oldLinesRemaining = Math.max(0, oldLinesRemaining - 1);
        newLinesRemaining = Math.max(0, newLinesRemaining - 1);
      }
      if (oldLinesRemaining === 0 && newLinesRemaining === 0) inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path !== "/dev/null") fallbackFiles.add(path);
      continue;
    }
    if (line.startsWith("--- ")) continue;
  }
  if (files.size === 0) {
    for (const path of fallbackFiles) files.add(path);
  }
  return {
    filesChanged: files.size,
    additions,
    deletions
  };
}

function isCollaborationItem(item) {
  return item?.type === "collabAgentToolCall"
    || item?.type === "collabToolCall"
    || item?.type === "subAgentActivity";
}

function collaborationReferences(method, item, rootThreadId) {
  if (item.type === "subAgentActivity") {
    const status = item.kind === "interrupted" ? "interrupted" : "running";
    return item.agentThreadId
      ? [{
          threadId: String(item.agentThreadId),
          parentThreadId: rootThreadId,
          agentName: agentNameFromPath(item.agentPath),
          agentStatus: status
        }]
      : [];
  }

  const states = item.agentsStates && typeof item.agentsStates === "object"
    ? item.agentsStates
    : {};
  const ids = new Set([
    ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []),
    item.receiverThreadId,
    item.newThreadId,
    ...Object.keys(states)
  ].filter(Boolean).map(String));
  const normalizedTool = String(item.tool || "").replaceAll("_", "").toLowerCase();
  return [...ids].map((threadId) => {
    const agentState = states[threadId] || {};
    let agentStatus = optionalString(agentState.status) || optionalString(item.agentStatus);
    if (!agentStatus && item.status === "failed") agentStatus = "errored";
    if (!agentStatus && ["spawnagent", "resumeagent", "sendinput"].includes(normalizedTool)) agentStatus = "running";
    if (!agentStatus && normalizedTool === "closeagent" && method === "item/completed") agentStatus = "shutdown";
    return {
      threadId,
      parentThreadId: optionalString(item.senderThreadId) || rootThreadId,
      task: item.prompt,
      model: item.model,
      reasoningEffort: item.reasoningEffort,
      agentStatus,
      result: agentState.message
    };
  });
}

function agentNameFromPath(value) {
  const path = optionalString(value);
  return path ? path.split("/").filter(Boolean).at(-1) || null : null;
}

function threadStatusToAgentStatus(status) {
  switch (status?.type) {
    case "active": return "running";
    case "idle": return "completed";
    case "systemError": return "errored";
    case "notLoaded": return "shutdown";
    default: return null;
  }
}

function isTerminalSubagentStatus(status) {
  return ["completed", "errored", "interrupted", "shutdown", "notFound"].includes(status);
}

function subagentLifecycleUpdate(owner) {
  return compactObject({
    type: "subagent",
    scope: "subagent",
    status: subagentUpdateStatus(owner.agentStatus),
    itemId: `subagent:${owner.threadId}`,
    agentThreadId: owner.threadId,
    parentAgentThreadId: owner.parentThreadId,
    agentName: owner.agentName,
    agentRole: owner.agentRole,
    task: owner.task,
    model: owner.model,
    reasoningEffort: owner.reasoningEffort,
    agentStatus: owner.agentStatus,
    result: owner.result,
    startedAt: new Date(owner.startedAt).toISOString(),
    durationMs: owner.durationMs
  });
}

function subagentScope(owner) {
  return compactObject({
    scope: "subagent",
    agentThreadId: owner.threadId,
    parentAgentThreadId: owner.parentThreadId,
    agentName: owner.agentName,
    agentRole: owner.agentRole
  });
}

function subagentUpdateStatus(agentStatus) {
  if (["completed", "shutdown"].includes(agentStatus)) return "completed";
  if (["errored", "interrupted", "notFound"].includes(agentStatus)) return "failed";
  return "inProgress";
}

function turnItemKey(agentThreadId, itemId) {
  return `${agentThreadId || "main"}:${itemId || ""}`;
}

function upsertTurnUpdate(state, update) {
  const key = updateIdentity(update);
  if (!key) {
    state.updates.push(update);
    return;
  }
  const existing = state.updateIndexes.get(key);
  if (existing === undefined) {
    state.updateIndexes.set(key, state.updates.length);
    state.updates.push(update);
  } else {
    state.updates[existing] = update;
  }
}

function updateIdentity(update) {
  return update.itemId
    ? `${update.scope || "main"}:${update.agentThreadId || "main"}:${update.type}:${update.itemId}`
    : null;
}

function selectPersistentUpdates(updates, limit) {
  if (!Array.isArray(updates) || updates.length <= limit) return Array.isArray(updates) ? updates : [];
  const featured = updates.filter((update) => ["plan", "diff", "subagent"].includes(update.type));
  const selected = new Set(featured.slice(-limit));
  for (let index = updates.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    selected.add(updates[index]);
  }
  return updates.filter((update) => selected.has(update));
}

function stringifyDisplayValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function boundedText(value, limit) {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function boundedTail(value, limit) {
  if (typeof value !== "string") return "";
  return value.length > limit ? `…${value.slice(-(limit - 1))}` : value;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function documentPermissionMode(permissionMode) {
  return `document-read-only:${permissionMode}`;
}

function isDocumentPermissionMode(permissionMode) {
  return permissionMode.startsWith("document-read-only:");
}

function codexThreadPermissionParams(permissionMode) {
  if (isDocumentPermissionMode(permissionMode)) {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only"
    };
  }
  if (permissionMode === "request-approval") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write"
    };
  }
  if (permissionMode === "auto-review") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write"
    };
  }
  if (permissionMode === "full-access") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access"
    };
  }
  return {
    approvalPolicy: null,
    approvalsReviewer: null,
    sandbox: null
  };
}

function permissionAccessMode(permissionMode) {
  if (permissionMode === "request-approval" || permissionMode === "auto-review") {
    return "workspace-write";
  }
  if (permissionMode === "full-access") return "full-access";
  return "custom";
}

function optionalString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
