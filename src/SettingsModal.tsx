import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SETTINGS,
  getProviderKey,
  loadSettings,
  saveSettings,
  setProviderKey,
  type AppSettings,
} from "./store";
import { PROVIDER_REGISTRY, type ProviderName } from "./providers/types";
import { HotkeyInput } from "./HotkeyInput";

interface Props {
  open: boolean;
  initial: AppSettings;
  onClose: () => void;
  onSaved: (next: AppSettings) => void;
}

type StatusKind = "idle" | "saving" | "success" | "error";

export function SettingsModal({ open, initial, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<AppSettings>(initial);
  // 按提供方缓存 API Key。输入框显示/编辑的是 keyMap[当前提供方]，
  // 因此切换提供方会自动切换到对应的 key，且各家分别保存。
  const [keyMap, setKeyMap] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: "idle",
    text: "",
  });
  const [autostart, setAutostart] = useState<boolean>(false);

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setStatus({ kind: "idle", text: "" });
    // 加载开机自启动状态
    invoke<boolean>("get_autostart_status")
      .then(setAutostart)
      .catch(() => setAutostart(false));
    // 预载所有提供方的 key，切换时无需等待、不闪烁。
    let cancelled = false;
    Promise.all(
      PROVIDER_REGISTRY.map(async (p) => [p.id, await getProviderKey(p.id)] as const),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [id, key] of entries) map[id] = key;
      // 用 initial 里已解析出的当前 key 覆盖，保证与刚打开时一致。
      map[initial.provider] = initial.apiKey;
      map[initial.recognizeProvider] = initial.recognizeApiKey;
      setKeyMap(map);
    });
    return () => {
      cancelled = true;
    };
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

  const recognizeMeta = useMemo(
    () => PROVIDER_REGISTRY.find((p) => p.id === draft.recognizeProvider),
    [draft.recognizeProvider],
  );

  // 模式 A 下实际处理图片的模型：协作时是识别模型，否则是翻译提供方。
  const visionMeta = draft.visionCollab ? recognizeMeta : providerMeta;

  // 仅支持多模态、且已实现的提供方可作为识别模型。
  const visionProviders = useMemo(
    () => PROVIDER_REGISTRY.filter((p) => p.supportVision && p.implemented),
    [],
  );

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setStatus({ kind: "idle", text: "" });
  }

  // 设置某提供方的 key（编辑输入框时调用）。
  function setKeyFor(provider: ProviderName, value: string) {
    setKeyMap((prev) => ({ ...prev, [provider]: value }));
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
    // 若该提供方的 key 尚未在缓存里，补取一次（预载兜底）。
    if (keyMap[next] === undefined) {
      getProviderKey(next).then((k) =>
        setKeyMap((prev) => (prev[next] === undefined ? { ...prev, [next]: k } : prev)),
      );
    }
  }

  function handleRecognizeProviderChange(next: ProviderName) {
    const meta = PROVIDER_REGISTRY.find((p) => p.id === next);
    setDraft((prev) => ({
      ...prev,
      recognizeProvider: next,
      recognizeBaseUrl: meta?.defaultBaseUrl ?? prev.recognizeBaseUrl,
      recognizeModel: meta?.defaultModel ?? prev.recognizeModel,
    }));
    setStatus({ kind: "idle", text: "" });
    if (keyMap[next] === undefined) {
      getProviderKey(next).then((k) =>
        setKeyMap((prev) => (prev[next] === undefined ? { ...prev, [next]: k } : prev)),
      );
    }
  }

  async function handleSave() {
    setStatus({ kind: "saving", text: "保存中…" });
    try {
      // 写入所有被编辑过的提供方 key（按家分别存储）。
      await Promise.all(
        Object.entries(keyMap).map(([provider, key]) =>
          setProviderKey(provider as ProviderName, key),
        ),
      );
      // draft 的当前生效 key 从缓存解析，保证 saveSettings 写对值。
      const next: AppSettings = {
        ...draft,
        apiKey: keyMap[draft.provider] ?? "",
        recognizeApiKey: keyMap[draft.recognizeProvider] ?? "",
      };
      await saveSettings(next);
      await invoke("reload_shortcuts");
      onSaved(next);
      // 保存成功后自动关闭设置窗口；失败时保持打开以展示错误。
      onClose();
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
          <div className="row">
            <div className="field">
              <label>划词翻译快捷键</label>
              <HotkeyInput
                value={draft.hotkey}
                onChange={(v) => update("hotkey", v)}
                placeholder="点击后按下快捷键，例 Alt+Q"
              />
              <span className="hint">
                选中文字后按下，例 <code>Alt+Q</code>。
              </span>
            </div>
            <div className="field">
              <label>截图翻译快捷键</label>
              <HotkeyInput
                value={draft.captureHotkey}
                onChange={(v) => update("captureHotkey", v)}
                allowEmpty
                placeholder="点击后按下快捷键，例 Alt+S"
              />
              <span className="hint">
                框选屏幕区域翻译，例 <code>Alt+S</code>。点 × 或按退格可清除以禁用。
              </span>
            </div>
          </div>

          <div className="field">
            <label>截图 OCR 模式</label>
            <select
              value={draft.ocrMode}
              onChange={(e) => update("ocrMode", e.target.value as AppSettings["ocrMode"])}
            >
              <option value="A">A · 多模态模型（识别+翻译一步完成，需联网，准确率最高）</option>
              <option value="B">B · Windows 系统 OCR（离线免费，再调用翻译接口）</option>
            </select>
            {draft.ocrMode === "A" && !visionMeta?.supportVision && (
              <span className="hint" style={{ color: "#d44" }}>
                {draft.visionCollab
                  ? "下方「识别模型」不支持图片输入，请改用 OpenAI / Claude / Gemini / Qwen3-VL / Grok。"
                  : "当前翻译提供方不支持图片输入。模式 A 请选择支持多模态的提供方（OpenAI / Claude / Gemini / Qwen3-VL / Grok），或开启多模型协作单独指定识别模型。"}
              </span>
            )}
            {draft.ocrMode === "B" && (
              <span className="hint">
                依赖系统已安装的 OCR 语言包；识别出的文字会按上面的「源/目标语言」再翻译。
              </span>
            )}
          </div>

          {draft.ocrMode === "A" && (
            <div className="field collab-block">
              <label className="toggle-row">
                <span>多模型协作（先识别，再翻译）</span>
                <input
                  type="checkbox"
                  checked={draft.visionCollab}
                  onChange={(e) => update("visionCollab", e.target.checked)}
                />
                <span className="toggle" />
              </label>
              <span className="hint">
                开启后：用下方「识别模型」识别图片文字，再交给上面的「翻译提供方」翻译。
                关闭则由翻译提供方一步完成识别+翻译。
              </span>

              {draft.visionCollab && (
                <div className="collab-sub">
                  <div className="field">
                    <label>识别模型（多模态）</label>
                    <select
                      value={draft.recognizeProvider}
                      onChange={(e) =>
                        handleRecognizeProviderChange(e.target.value as ProviderName)
                      }
                    >
                      {visionProviders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>识别模型 API Key</label>
                    <input
                      type="password"
                      value={keyMap[draft.recognizeProvider] ?? ""}
                      onChange={(e) => setKeyFor(draft.recognizeProvider, e.target.value)}
                      placeholder="sk-..."
                      spellCheck={false}
                    />
                  </div>
                  <div className="row">
                    <div className="field">
                      <label>识别模型 Base URL</label>
                      <input
                        type="text"
                        value={draft.recognizeBaseUrl}
                        onChange={(e) => update("recognizeBaseUrl", e.target.value)}
                        spellCheck={false}
                      />
                    </div>
                    <div className="field">
                      <label>识别模型 Model</label>
                      <input
                        type="text"
                        value={draft.recognizeModel}
                        onChange={(e) => update("recognizeModel", e.target.value)}
                        spellCheck={false}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

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
                该 Provider 暂未实现，调用会报错，请选择其他提供方。
              </span>
            )}
          </div>

          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={keyMap[draft.provider] ?? ""}
              onChange={(e) => setKeyFor(draft.provider, e.target.value)}
              placeholder="sk-..."
              spellCheck={false}
            />
            <span className="hint">
              按提供方分别保存，切换提供方会自动载入对应的 Key；写入系统凭据管理器（keyring），不以明文存放于配置文件。
            </span>
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

          <div className="field">
            <label className="toggle-row">
              <span>开机自启动</span>
              <input
                type="checkbox"
                checked={autostart}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setAutostart(enabled);
                  try {
                    await invoke("set_autostart", { enabled });
                  } catch (err) {
                    console.error("Failed to set autostart:", err);
                    setAutostart(!enabled);
                  }
                }}
              />
              <span className="toggle" />
            </label>
            <span className="hint">
              启用后 TransLoop 会在系统启动时自动运行，可在托盘菜单中快速切换。
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
