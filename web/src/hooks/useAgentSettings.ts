import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { AgentSettingsPayload } from "../types";

type AgentSettingsOptions = {
  setStatus: (status: string) => void;
};

export function useAgentSettings({ setStatus }: AgentSettingsOptions) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgentSettingsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  async function openSettings() {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      setData(await api.settings(request.signal));
    } catch (loadError) {
      if (!request.signal.aborted) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  function closeSettings() {
    if (saving) return;
    requestRef.current?.abort();
    requestRef.current = null;
    setOpen(false);
  }

  async function saveSettings(model: string | null, reasoningEffort: string | null) {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setSaving(true);
    setError("");
    try {
      const payload = await api.updateSettings({ model, reasoningEffort }, request.signal);
      if (request.signal.aborted) return;
      setData(payload);
      setStatus("Codex 设置已保存，将从下一轮提问生效");
      setOpen(false);
    } catch (saveError) {
      if (!request.signal.aborted) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      }
    } finally {
      if (!request.signal.aborted) setSaving(false);
    }
  }

  return {
    settingsOpen: open,
    settingsData: data,
    settingsLoading: loading,
    settingsSaving: saving,
    settingsError: error,
    openSettings,
    closeSettings,
    saveSettings
  };
}
