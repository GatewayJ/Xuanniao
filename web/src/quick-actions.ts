import type { AgentSettingsPayload, NodeQuickAction } from "./types";

export const DEFAULT_NODE_QUICK_ACTIONS: ReadonlyArray<NodeQuickAction> = Object.freeze([
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

export function nodeQuickActions(settings: AgentSettingsPayload | null): ReadonlyArray<NodeQuickAction> {
  return settings?.quickActions ?? DEFAULT_NODE_QUICK_ACTIONS;
}
