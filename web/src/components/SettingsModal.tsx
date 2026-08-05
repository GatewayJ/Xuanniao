import { useEffect, useMemo, useState } from "react";

import { effortLabel, findEffectiveModel, permissionModeLabel } from "../agent-settings-view";
import type { AgentModelOption, AgentPermissionMode, AgentSettingsPayload } from "../types";

type SettingsModalProps = {
  open: boolean;
  data: AgentSettingsPayload | null;
  loading: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (
    model: string | null,
    reasoningEffort: string | null,
    permissionMode: AgentPermissionMode
  ) => void;
};

export function SettingsModal({ open, data, loading, saving, error, onClose, onSave }: SettingsModalProps) {
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>("request-approval");

  useEffect(() => {
    if (!open || !data) return;
    const nextModel = data.model || "";
    const effectiveModel = findEffectiveModel(data.models, nextModel);
    const effortSupported = !data.reasoningEffort || !effectiveModel || effectiveModel.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === data.reasoningEffort
    );
    setModel(nextModel);
    setReasoningEffort(effortSupported ? data.reasoningEffort || "" : "");
    setPermissionMode(data.permissionMode);
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
  const selectedEffort = supportedEfforts.find((option) => option.reasoningEffort === reasoningEffort);
  const unavailableModel = Boolean(model && !effectiveModel);
  const modelSettingsChanged = Boolean(
    data && (model !== (data.model || "") || reasoningEffort !== (data.reasoningEffort || ""))
  );
  const canSave = Boolean(
    data?.permissionSelectionSupported &&
    !loading &&
    !saving &&
    (!modelSettingsChanged || (
      data.modelSelectionSupported &&
      !data.catalogError &&
      !unavailableModel
    ))
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
              <span><strong>Codex</strong><small>模型、推理与权限</small></span>
            </button>
          </nav>

          <form className="settingsContent" onSubmit={(event) => {
            event.preventDefault();
            if (canSave) onSave(model || null, reasoningEffort || null, permissionMode);
          }}>
            <div className="settingsIntro">
              <div>
                <span className="settingsEyebrow">Codex</span>
                <h3>模型、推理与权限</h3>
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
              <div className="settingsNotice">当前使用 ACP 兼容模式。请切换到原生 Codex transport 后再修改这些设置。</div>
            )}

            {data && (
              <section className="settingsSection permissionSettingsSection" aria-labelledby="permission-setting-label">
                <div className="settingsSectionHeading">
                  <div>
                    <h4 id="permission-setting-label">应如何批准 Codex 操作？</h4>
                    <p>控制 Codex 对文件系统和互联网的访问方式。</p>
                  </div>
                  <span>{permissionModeLabel(permissionMode)}</span>
                </div>
                <div className="permissionOptions" aria-disabled={!data.permissionSelectionSupported}>
                  <PermissionModeOption
                    mode="request-approval"
                    checked={permissionMode === "request-approval"}
                    title="请求批准"
                    description="编辑工作区外文件和使用互联网时始终询问"
                    icon="✋"
                    disabled={!data.permissionSelectionSupported}
                    onChange={setPermissionMode}
                  />
                  <PermissionModeOption
                    mode="auto-review"
                    checked={permissionMode === "auto-review"}
                    title="替我审批"
                    description="仅对检测到的风险操作请求批准"
                    icon="◇"
                    disabled={!data.permissionSelectionSupported}
                    onChange={setPermissionMode}
                  />
                  <PermissionModeOption
                    mode="full-access"
                    checked={permissionMode === "full-access"}
                    title="完全访问权限"
                    description="可不受限制地访问互联网和您电脑上的任何文件"
                    icon="!"
                    tone="danger"
                    disabled={!data.permissionSelectionSupported}
                    onChange={setPermissionMode}
                  />
                  <PermissionModeOption
                    mode="custom"
                    checked={permissionMode === "custom"}
                    title="自定义 (config.toml)"
                    description="使用 Codex config.toml 中定义的权限"
                    icon="⚙"
                    disabled={!data.permissionSelectionSupported}
                    onChange={setPermissionMode}
                  />
                </div>
              </section>
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
                  <div className="reasoningEffortControl">
                    <select
                      id="reasoning-effort"
                      aria-labelledby="effort-setting-label"
                      value={reasoningEffort}
                      onChange={(event) => setReasoningEffort(event.target.value)}
                    >
                      <option value="">
                        {effectiveModel?.defaultReasoningEffort
                          ? `模型默认（${effortLabel(effectiveModel.defaultReasoningEffort)}）`
                          : "模型默认"}
                      </option>
                      {supportedEfforts.map((option) => (
                        <option key={option.reasoningEffort} value={option.reasoningEffort}>
                          {effortLabel(option.reasoningEffort)}
                        </option>
                      ))}
                    </select>
                    <small>
                      {selectedEffort?.description
                        || (effectiveModel?.defaultReasoningEffort
                          ? `当前默认推理深度：${effortLabel(effectiveModel.defaultReasoningEffort)}`
                          : "由所选模型决定推理深度")}
                    </small>
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

type PermissionModeOptionProps = {
  mode: AgentPermissionMode;
  checked: boolean;
  title: string;
  description: string;
  icon: string;
  tone?: "default" | "danger";
  disabled: boolean;
  onChange: (mode: AgentPermissionMode) => void;
};

function PermissionModeOption({
  mode,
  checked,
  title,
  description,
  icon,
  tone = "default",
  disabled,
  onChange
}: PermissionModeOptionProps) {
  return (
    <label className={`permissionOption${checked ? " active" : ""}${tone === "danger" ? " danger" : ""}${disabled ? " disabled" : ""}`}>
      <input
        type="radio"
        name="codex-permission-mode"
        value={mode}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(mode)}
      />
      <span className="permissionOptionIcon" aria-hidden="true">{icon}</span>
      <span className="permissionOptionText"><strong>{title}</strong><small>{description}</small></span>
      <span className="permissionOptionCheck" aria-hidden="true">{checked ? "✓" : ""}</span>
    </label>
  );
}

function defaultModelDescription(models: AgentModelOption[]): string {
  const defaultModel = findEffectiveModel(models, "");
  return defaultModel ? `当前默认：${defaultModel.displayName}` : "使用 Codex 当前的默认模型";
}

function transportLabel(transport: string): string {
  return transport === "codex-app-server" ? "原生 Codex" : transport.toUpperCase();
}
