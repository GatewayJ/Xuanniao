import { AcpDocumentAgent } from "./acp-client.js";
import { normalizeAgentMode } from "./agent-config.js";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";

const requiredRuntimeMethods = [
  "status",
  "start",
  "dispose",
  "runTurn",
  "listPermissionRequests",
  "resolvePermissionRequest"
];

export function createAgentRuntime({ documentPath, cwd, env = process.env }) {
  const transport = normalizeAgentTransport(env.XUANNIAO_AGENT_TRANSPORT);
  const common = {
    documentPath,
    cwd,
    accessMode: normalizeAgentMode(env.XUANNIAO_AGENT_MODE),
    timeoutMs: numberFromEnv(env.XUANNIAO_AGENT_TIMEOUT_MS, 600_000),
    contextMaxChars: integerFromEnv(env.XUANNIAO_AGENT_CONTEXT_MAX_CHARS, 1_500_000),
    snapshotCacheEntries: integerFromEnv(env.XUANNIAO_AGENT_SNAPSHOT_CACHE_ENTRIES, 32),
    env
  };

  let runtime;
  if (transport === "acp") {
    runtime = new AcpDocumentAgent({
      ...common,
      commandLine: env.XUANNIAO_ACP_CMD ?? "codex-acp",
      timeoutMs: numberFromEnv(env.XUANNIAO_ACP_TIMEOUT_MS, common.timeoutMs)
    });
  } else {
    runtime = new CodexAppServerRuntime({
      ...common,
      commandLine: env.XUANNIAO_CODEX_CMD ?? "codex app-server",
      model: optionalString(env.XUANNIAO_CODEX_MODEL),
      reasoningEffort: optionalString(env.XUANNIAO_CODEX_REASONING_EFFORT)
    });
  }
  return assertAgentRuntime(runtime);
}

export function normalizeAgentTransport(value) {
  const transport = String(value ?? "codex")
    .trim()
    .toLowerCase();
  if (transport === "codex" || transport === "acp") {
    return transport;
  }
  throw new Error(`Unsupported XUANNIAO_AGENT_TRANSPORT: ${value}. Expected codex or acp.`);
}

export function runtimeCommand(runtime) {
  return runtime.status().command.join(" ");
}

export function assertAgentRuntime(runtime) {
  for (const method of requiredRuntimeMethods) {
    if (typeof runtime?.[method] !== "function") {
      throw new TypeError(`AgentRuntime is missing required method: ${method}`);
    }
  }
  return runtime;
}

function numberFromEnv(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive numeric value, received: ${value}`);
  }
  return parsed;
}

function integerFromEnv(value, fallback) {
  const parsed = numberFromEnv(value, fallback);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Expected a positive integer value, received: ${value}`);
  }
  return parsed;
}

function optionalString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
