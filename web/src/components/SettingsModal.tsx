import { useEffect, useMemo, useState } from "react";

import type { AgentModelOption, AgentSettingsPayload } from "../types";

type SettingsModalProps = {
  open: boolean;
  data: AgentSettingsPayload | null;
  loading: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (model: string | null, reasoningEffort: string | null) => void;
};

const effortLabels: Record<string, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "Max",
  ultra: "Ultra"
};

export function SettingsModal({ open, data, loading, saving, error, onClose, onSave }: SettingsModalProps) {
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");

  useEffect(() => {
    if (!open || !data) return;
    const nextModel = data.model || "";
    const effectiveModel = findEffectiveModel(data.models, nextModel);
    const effortSupported = effectiveModel?.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === data.reasoningEffort
    );
    setModel(nextModel);
    setReasoningEffort(effortSupported ? data.reasoningEffort || "" : "");
  }, [open, data]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, saving, onClose]);

  const effectiveModel = useMemo(() => findEffectiveModel(data?.models || [], model), [data?.models, model]);
  const supportedEfforts = effectiveModel?.supportedReasoningEfforts || [];
  const unavailableModel = Boolean(model && !effectiveModel);
  const canSave = Boolean(
    data?.modelSelectionSupported &&
    !loading &&
    !saving &&
    !data.catalogError &&
    !unavailableModel
  );

  if (!open) return null;

  function selectModel(nextModel: string) {
    setModel(nextModel);
    const next = findEffectiveModel(data?.models || [], nextModel);
    if (reasoningEffort && !next?.supportedReasoningEfforts.some((option) => option.reasoningEffort === reasoningEffort)) {
      setReasoningEffort("");
    }
  }

  return (
    <div className="modalBackdrop settingsBackdrop" role="presentation" onMouseDown={onClose}>
      <section className="settingsModal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settingsHeader">
          <div>
            <span>偏好设置</span>
            <h2 id="settings-title">设置</h2>
          </div>
          <button type="button" className="settingsCloseButton" aria-label="关闭设置" onClick={onClose}>×</button>
        </header>

        <div className="settingsLayout">
          <nav className="settingsNav" aria-label="设置分类">
            <button type="button" className="active" aria-current="page">
              <span className="settingsNavIcon">C</span>
              <span><strong>Codex</strong><small>模型与推理</small></span>
            </button>
          </nav>

          <form className="settingsContent" onSubmit={(event) => {
            event.preventDefault();
            if (canSave) onSave(model || null, reasoningEffort || null);
          }}>
            <div className="settingsIntro">
              <div>
                <span className="settingsEyebrow">Codex</span>
                <h3>模型与推理深度</h3>
                <p>设置会用于下一轮提问，正在执行的任务不会中断。</p>
              </div>
              {data && <span className="settingsTransport">{transportLabel(data.transport)}</span>}
            </div>

            {loading && <div className="settingsLoading">正在读取 Codex 可用模型…</div>}
            {error && <div className="settingsError" role="alert">{error}</div>}
            {data?.catalogError && (
              <div className="settingsError" role="alert">无法读取模型列表：{data.catalogError}</div>
            )}
            {data && !data.modelSelectionSupported && (
              <div className="settingsNotice">当前使用 ACP 兼容模式。请切换到原生 Codex transport 后再选择模型。</div>
            )}

            {data && data.modelSelectionSupported && (
              <>
                <section className="settingsSection" aria-labelledby="model-setting-label">
                  <div className="settingsSectionHeading">
                    <div>
                      <h4 id="model-setting-label">模型</h4>
                      <p>模型列表由当前 Codex 自动提供。</p>
                    </div>
                    <span>{model ? effectiveModel?.displayName || model : "Codex 默认"}</span>
                  </div>
                  <div className="modelOptions">
                    <ModelOption
                      checked={!model}
                      title="跟随 Codex 默认"
                      description={defaultModelDescription(data.models)}
                      badge="推荐"
                      onChange={() => selectModel("")}
                    />
                    {unavailableModel && (
                      <ModelOption
                        checked
                        title={model}
                        description="此模型已不在当前 Codex 的可用列表中，请重新选择。"
                        badge="不可用"
                        invalid
                        onChange={() => {}}
                      />
                    )}
                    {data.models.map((option) => (
                      <ModelOption
                        key={option.model}
                        checked={model === option.model}
                        title={option.displayName}
                        description={option.description || option.model}
                        badge={option.isDefault ? "默认" : null}
                        onChange={() => selectModel(option.model)}
                      />
                    ))}
                  </div>
                </section>

                <section className="settingsSection" aria-labelledby="effort-setting-label">
                  <div className="settingsSectionHeading">
                    <div>
                      <h4 id="effort-setting-label">推理深度</h4>
                      <p>更高深度适合复杂任务，但通常需要更长时间。</p>
                    </div>
                    <span>{reasoningEffort ? effortLabel(reasoningEffort) : "模型默认"}</span>
                  </div>
                  <div className="effortOptions" role="radiogroup" aria-labelledby="effort-setting-label">
                    <label className={!reasoningEffort ? "effortOption active" : "effortOption"}>
                      <input type="radio" name="reasoning-effort" checked={!reasoningEffort} onChange={() => setReasoningEffort("")} />
                      <strong>默认</strong>
                      <small>{effectiveModel?.defaultReasoningEffort ? `当前为${effortLabel(effectiveModel.defaultReasoningEffort)}` : "由模型决定"}</small>
                    </label>
                    {supportedEfforts.map((option) => (
                      <label key={option.reasoningEffort} className={reasoningEffort === option.reasoningEffort ? "effortOption active" : "effortOption"}>
                        <input
                          type="radio"
                          name="reasoning-effort"
                          checked={reasoningEffort === option.reasoningEffort}
                          onChange={() => setReasoningEffort(option.reasoningEffort)}
                        />
                        <strong>{effortLabel(option.reasoningEffort)}</strong>
                        <small>{option.description || option.reasoningEffort}</small>
                      </label>
                    ))}
                  </div>
                </section>
              </>
            )}

            <footer className="settingsFooter">
              <p>{saving ? "正在保存…" : "设置保存在本机，仅影响后续 Codex 回合。"}</p>
              <div>
                <button type="button" className="ghostButton" disabled={saving} onClick={onClose}>取消</button>
                <button type="submit" className="primaryButton" disabled={!canSave}>保存设置</button>
              </div>
            </footer>
          </form>
        </div>
      </section>
    </div>
  );
}

type ModelOptionProps = {
  checked: boolean;
  title: string;
  description: string;
  badge: string | null;
  invalid?: boolean;
  onChange: () => void;
};

function ModelOption({ checked, title, description, badge, invalid = false, onChange }: ModelOptionProps) {
  return (
    <label className={`modelOption${checked ? " active" : ""}${invalid ? " invalid" : ""}`}>
      <input type="radio" name="codex-model" checked={checked} onChange={onChange} />
      <span className="modelOptionMark" aria-hidden="true" />
      <span className="modelOptionText"><strong>{title}</strong><small>{description}</small></span>
      {badge && <span className="modelOptionBadge">{badge}</span>}
    </label>
  );
}

function findEffectiveModel(models: AgentModelOption[], selected: string): AgentModelOption | null {
  if (selected) return models.find((model) => model.model === selected || model.id === selected) || null;
  return models.find((model) => model.isDefault) || models[0] || null;
}

function defaultModelDescription(models: AgentModelOption[]): string {
  const defaultModel = findEffectiveModel(models, "");
  return defaultModel ? `当前默认：${defaultModel.displayName}` : "使用 Codex 当前的默认模型";
}

function effortLabel(value: string): string {
  return effortLabels[value] || value;
}

function transportLabel(transport: string): string {
  return transport === "codex-app-server" ? "原生 Codex" : transport.toUpperCase();
}
