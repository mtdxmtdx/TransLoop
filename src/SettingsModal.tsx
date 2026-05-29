import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type AppSettings,
} from "./store";
import { PROVIDER_REGISTRY, type ProviderName } from "./providers/types";

interface Props {
  open: boolean;
  initial: AppSettings;
  onClose: () => void;
  onSaved: (next: AppSettings) => void;
}

type StatusKind = "idle" | "saving" | "success" | "error";

export function SettingsModal({ open, initial, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: "idle",
    text: "",
  });

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setStatus({ kind: "idle", text: "" });
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const providerMeta = useMemo(
    () => PROVIDER_REGISTRY.find((p) => p.id === draft.provider),
    [draft.provider],
  );

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setStatus({ kind: "idle", text: "" });
  }

  function handleProviderChange(next: ProviderName) {
    const meta = PROVIDER_REGISTRY.find((p) => p.id === next);
    setDraft((prev) => ({
      ...prev,
      provider: next,
      baseUrl: meta?.defaultBaseUrl ?? prev.baseUrl,
      model: meta?.defaultModel ?? prev.model,
    }));
    setStatus({ kind: "idle", text: "" });
  }

  async function handleSave() {
    setStatus({ kind: "saving", text: "保存中…" });
    try {
      await saveSettings(draft);
      await invoke("update_hotkey", { hotkey: draft.hotkey });
      setStatus({ kind: "success", text: "已保存。快捷键已生效。" });
      onSaved(draft);
    } catch (e) {
      setStatus({ kind: "error", text: `保存失败：${String(e)}` });
    }
  }

  function handleReset() {
    setDraft(DEFAULT_SETTINGS);
    setStatus({ kind: "idle", text: "" });
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭 (Esc)">
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>全局快捷键</label>
            <input
              type="text"
              value={draft.hotkey}
              onChange={(e) => update("hotkey", e.target.value)}
              placeholder="Alt+Q"
              spellCheck={false}
            />
            <span className="hint">
              组合键：Ctrl / Alt / Shift / Super 加字母数字，例 <code>Alt+Q</code>、
              <code>Ctrl+Shift+T</code>。
            </span>
          </div>

          <div className="field">
            <label>翻译提供方</label>
            <select
              value={draft.provider}
              onChange={(e) => handleProviderChange(e.target.value as ProviderName)}
            >
              {PROVIDER_REGISTRY.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.implemented ? "" : "（暂未启用）"}
                </option>
              ))}
            </select>
            {providerMeta && !providerMeta.implemented && (
              <span className="hint" style={{ color: "#d44" }}>
                该 Provider 仅占位，调用会报错。请选 DeepSeek。
              </span>
            )}
          </div>

          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => update("apiKey", e.target.value)}
              placeholder="sk-..."
              spellCheck={false}
            />
          </div>

          <div className="row">
            <div className="field">
              <label>Base URL</label>
              <input
                type="text"
                value={draft.baseUrl}
                onChange={(e) => update("baseUrl", e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>Model</label>
              <input
                type="text"
                value={draft.model}
                onChange={(e) => update("model", e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>

          <div className="field">
            <label className="toggle-row">
              <span>流式输出</span>
              <input
                type="checkbox"
                checked={draft.streamOutput}
                onChange={(e) => update("streamOutput", e.target.checked)}
              />
              <span className="toggle" />
            </label>
            <span className="hint">
              启用后译文会逐字显示；关闭后等待完整结果再一次性展示。
            </span>
          </div>
        </div>

        <div className="modal-footer">
          <button className="ghost" onClick={handleReset}>
            恢复默认
          </button>
          <div className="spacer" />
          {status.text && (
            <span
              className={`status ${
                status.kind === "error"
                  ? "error"
                  : status.kind === "success"
                    ? "success"
                    : ""
              }`}
            >
              {status.text}
            </span>
          )}
          <button className="primary" onClick={handleSave} disabled={status.kind === "saving"}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export async function loadOrDefault(): Promise<AppSettings> {
  try {
    return await loadSettings();
  } catch {
    return DEFAULT_SETTINGS;
  }
}
