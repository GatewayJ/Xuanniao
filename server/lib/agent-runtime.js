import { normalizeAgentSettings } from "./agent-settings.js";
import { CodexAppServerRuntime } from "./codex-app-server-runtime.js";

const requiredRuntimeMethods = [
  "status",
  "start",
  "dispose",
  "runTurn",
  "listModels",
  "configure",
  "listPermissionRequests",
  "resolvePermissionRequest"
];

export function createAgentRuntime({ documentPath, cwd, env = process.env, settings }) {
  const agentSettings = settings === undefined
    ? runtimeAgentSettingsFromEnv(env)
    : normalizeAgentSettings(settings);
  const runtime = new CodexAppServerRuntime({
    documentPath,
    cwd,
    commandLine: env.XUANNIAO_CODEX_CMD ?? "codex app-server",
    timeoutMs: numberFromEnv(env.XUANNIAO_AGENT_TIMEOUT_MS, 600_000),
    model: agentSettings.model,
    reasoningEffort: agentSettings.reasoningEffort,
    permissionMode: agentSettings.permissionMode,
    contextMaxChars: integerFromEnv(env.XUANNIAO_AGENT_CONTEXT_MAX_CHARS, 1_500_000),
    snapshotCacheEntries: integerFromEnv(env.XUANNIAO_AGENT_SNAPSHOT_CACHE_ENTRIES, 32),
    env
  });
  return assertAgentRuntime(runtime);
}

export function runtimeAgentSettingsFromEnv(env = process.env) {
  return normalizeAgentSettings({
    model: optionalString(env.XUANNIAO_CODEX_MODEL),
    reasoningEffort: optionalString(env.XUANNIAO_CODEX_REASONING_EFFORT),
    permissionMode: optionalString(env.XUANNIAO_AGENT_PERMISSION_MODE)
  });
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
