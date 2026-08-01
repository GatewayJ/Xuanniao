import type { AgentModelOption, AgentSettingsPayload } from "./types";

const effortLabels: Record<string, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "Max",
  ultra: "Ultra"
};

export function effortLabel(value: string): string {
  return effortLabels[value] || value;
}

export function findEffectiveModel(
  models: AgentModelOption[],
  selected: string
): AgentModelOption | null {
  if (selected) return models.find((model) => model.model === selected || model.id === selected) || null;
  return models.find((model) => model.isDefault) || models[0] || null;
}

export function agentSettingsSummary(settings: AgentSettingsPayload | null): string | null {
  if (!settings || !settings.modelSelectionSupported) return null;
  const model = findEffectiveModel(settings.models, settings.model || "");
  const modelLabel = model?.displayName || settings.model || "Codex 默认模型";
  const effort = settings.reasoningEffort || model?.defaultReasoningEffort;
  return `${modelLabel} · ${effort ? effortLabel(effort) : "默认深度"}`;
}
