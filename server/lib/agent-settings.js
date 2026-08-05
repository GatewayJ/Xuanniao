const settingsVersion = 2;
export const DEFAULT_AGENT_PERMISSION_MODE = "request-approval";
export const AGENT_PERMISSION_MODES = Object.freeze([
  "request-approval",
  "auto-review",
  "full-access",
  "custom"
]);
const agentPermissionModes = new Set(AGENT_PERMISSION_MODES);

export class AgentSettingsValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AgentSettingsValidationError";
    this.code = code;
    this.statusCode = 400;
  }
}

export function normalizeAgentSettings(value, fallback = {}) {
  const candidate = value && typeof value === "object" ? value : {};
  return {
    version: settingsVersion,
    model: optionalSetting(candidate.model, fallback.model),
    reasoningEffort: optionalSetting(candidate.reasoningEffort, fallback.reasoningEffort),
    permissionMode: normalizeAgentPermissionMode(
      candidate.permissionMode,
      fallback.permissionMode
    )
  };
}

export function parseAgentSettingsUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentSettingsValidationError("settings must be an object", "INVALID_SETTINGS");
  }
  return {
    version: settingsVersion,
    model: parseOptionalSetting(value.model, "model"),
    reasoningEffort: parseOptionalSetting(value.reasoningEffort, "reasoningEffort"),
    permissionMode: normalizeAgentPermissionMode(value.permissionMode)
  };
}

export function normalizeAgentPermissionMode(value, fallback = DEFAULT_AGENT_PERMISSION_MODE) {
  const normalized = cleanString(value) || cleanString(fallback) || DEFAULT_AGENT_PERMISSION_MODE;
  if (!agentPermissionModes.has(normalized)) {
    throw new AgentSettingsValidationError(
      `Unsupported permission mode: ${normalized}`,
      "INVALID_PERMISSION_MODE"
    );
  }
  return normalized;
}

export function normalizeModelCatalog(value) {
  if (!Array.isArray(value)) return [];
  const models = [];
  const seen = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || candidate.hidden === true) continue;
    const model = cleanString(candidate.model) || cleanString(candidate.id);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push({
      id: cleanString(candidate.id) || model,
      model,
      displayName: cleanString(candidate.displayName) || model,
      description: cleanString(candidate.description),
      isDefault: candidate.isDefault === true,
      defaultReasoningEffort: cleanString(candidate.defaultReasoningEffort),
      supportedReasoningEfforts: normalizeReasoningEfforts(candidate.supportedReasoningEfforts)
    });
  }
  return models;
}

export function validateAgentSettingsSelection(settings, catalog) {
  const normalized = parseAgentSettingsUpdate(settings);
  const models = normalizeModelCatalog(catalog);
  const selectedModel = normalized.model
    ? models.find((candidate) => candidate.model === normalized.model || candidate.id === normalized.model)
    : models.find((candidate) => candidate.isDefault) || models[0] || null;

  if (normalized.model && !selectedModel) {
    throw new AgentSettingsValidationError(
      `Codex model is not available: ${normalized.model}`,
      "MODEL_NOT_AVAILABLE"
    );
  }

  if (normalized.reasoningEffort && selectedModel) {
    const supported = new Set(selectedModel.supportedReasoningEfforts.map((option) => option.reasoningEffort));
    if (!supported.has(normalized.reasoningEffort)) {
      throw new AgentSettingsValidationError(
        `${selectedModel.displayName} does not support reasoning effort: ${normalized.reasoningEffort}`,
        "REASONING_EFFORT_NOT_SUPPORTED"
      );
    }
  } else if (normalized.reasoningEffort && !selectedModel) {
    throw new AgentSettingsValidationError(
      "Cannot validate reasoning effort because Codex returned no available models",
      "MODEL_CATALOG_EMPTY"
    );
  }

  return {
    ...normalized,
    model: normalized.model ? selectedModel.model : null
  };
}

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  const efforts = [];
  const seen = new Set();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const reasoningEffort = cleanString(candidate.reasoningEffort);
    if (!reasoningEffort || seen.has(reasoningEffort)) continue;
    seen.add(reasoningEffort);
    efforts.push({
      reasoningEffort,
      description: cleanString(candidate.description)
    });
  }
  return efforts;
}

function parseOptionalSetting(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new AgentSettingsValidationError(`${field} must be a string or null`, "INVALID_SETTINGS");
  }
  const normalized = value.trim();
  if (normalized.length > 200) {
    throw new AgentSettingsValidationError(`${field} is too long`, "INVALID_SETTINGS");
  }
  return normalized || null;
}

function optionalSetting(value, fallback) {
  if (value === null) return null;
  return cleanString(value) || cleanString(fallback);
}

function cleanString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
