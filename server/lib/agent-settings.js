const settingsVersion = 3;
const maxQuickActions = 12;
const maxQuickActionLabelLength = 40;
const maxQuickActionPromptLength = 8_000;
export const DEFAULT_AGENT_PERMISSION_MODE = "request-approval";
export const DEFAULT_NODE_QUICK_ACTIONS = Object.freeze([
  Object.freeze({
    id: "expand",
    label: "发散",
    prompt: "请基于当前节点发散 3 个值得继续探索的子方向。每个方向说明为什么重要、适合验证什么，以及建议优先级。"
  }),
  Object.freeze({
    id: "critique",
    label: "审查",
    prompt: "请审查当前节点：列出关键假设、主要风险、可能反例、缺失证据，并给出最应该先追问的一个问题。"
  }),
  Object.freeze({
    id: "decide",
    label: "收敛",
    prompt: "请把当前节点收敛成一个决策建议：给出推荐选择、理由、取舍、仍不确定的点和下一步动作。"
  }),
  Object.freeze({
    id: "task",
    label: "转任务",
    prompt: "请把当前节点转成可执行任务：拆成步骤、验收标准、依赖项、风险和建议负责人角色。"
  })
]);
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
    ),
    quickActions: normalizeNodeQuickActions(candidate.quickActions, fallback.quickActions)
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
    permissionMode: normalizeAgentPermissionMode(value.permissionMode),
    quickActions: parseNodeQuickActions(value.quickActions)
  };
}

export function normalizeNodeQuickActions(value, fallback) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(fallback)
      ? fallback
      : DEFAULT_NODE_QUICK_ACTIONS;
  const actions = [];
  const seen = new Set();
  for (const candidate of source.slice(0, maxQuickActions)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const id = cleanString(candidate.id);
    const label = cleanString(candidate.label);
    const prompt = cleanString(candidate.prompt);
    if (!id || !label || !prompt || seen.has(id)) continue;
    if (id.length > 100 || label.length > maxQuickActionLabelLength || prompt.length > maxQuickActionPromptLength) continue;
    seen.add(id);
    actions.push({ id, label, prompt });
  }
  return actions;
}

export function parseNodeQuickActions(value) {
  if (value === undefined) return normalizeNodeQuickActions(DEFAULT_NODE_QUICK_ACTIONS);
  if (!Array.isArray(value)) {
    throw new AgentSettingsValidationError("quickActions must be an array", "INVALID_QUICK_ACTIONS");
  }
  if (value.length > maxQuickActions) {
    throw new AgentSettingsValidationError(
      `quickActions cannot contain more than ${maxQuickActions} items`,
      "INVALID_QUICK_ACTIONS"
    );
  }

  const seen = new Set();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new AgentSettingsValidationError(`quickActions[${index}] must be an object`, "INVALID_QUICK_ACTIONS");
    }
    const id = requiredQuickActionString(candidate.id, `quickActions[${index}].id`, 100);
    const label = requiredQuickActionString(
      candidate.label,
      `quickActions[${index}].label`,
      maxQuickActionLabelLength
    );
    const prompt = requiredQuickActionString(
      candidate.prompt,
      `quickActions[${index}].prompt`,
      maxQuickActionPromptLength
    );
    if (seen.has(id)) {
      throw new AgentSettingsValidationError(`Duplicate quick action id: ${id}`, "INVALID_QUICK_ACTIONS");
    }
    seen.add(id);
    return { id, label, prompt };
  });
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

function requiredQuickActionString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentSettingsValidationError(`${field} must be a non-empty string`, "INVALID_QUICK_ACTIONS");
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentSettingsValidationError(`${field} is too long`, "INVALID_QUICK_ACTIONS");
  }
  return normalized;
}

function optionalSetting(value, fallback) {
  if (value === null) return null;
  return cleanString(value) || cleanString(fallback);
}

function cleanString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
