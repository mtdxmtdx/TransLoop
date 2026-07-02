import { useEffect, useState } from "react";
import { HotkeyInput } from "./HotkeyInput";
import { DEFAULT_SETTINGS, getProviderKey, saveSettings, setProviderKey, type AppSettings } from "./store";
import { PROVIDER_REGISTRY, type ProviderName } from "./providers/types";

interface Props {
  open: boolean;
  initial: AppSettings;
  onComplete: (next: AppSettings) => void;
  onClose?: () => void;
}

const LANG_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "zh-TW", label: "繁中" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
  { value: "fr", label: "法文" },
  { value: "de", label: "德文" },
  { value: "es", label: "西语" },
  { value: "ru", label: "俄文" },
];

export function OnboardingModal({ open, initial, onComplete, onClose }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setDraft(initial);
    getProviderKey(initial.provider).then(setApiKey).catch(() => setApiKey(""));
  }, [open, initial]);

  if (!open) return null;

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleProviderChange(provider: ProviderName) {
    const meta = PROVIDER_REGISTRY.find((item) => item.id === provider);
    setDraft((prev) => ({
      ...prev,
      provider,
      baseUrl: prev.providerConfigs[provider]?.baseUrl ?? meta?.defaultBaseUrl ?? prev.baseUrl,
      model: prev.providerConfigs[provider]?.model ?? meta?.defaultModel ?? prev.model,
    }));
    getProviderKey(provider).then(setApiKey).catch(() => setApiKey(""));
  }

  async function finish() {
    setSaving(true);
    const next: AppSettings = {
      ...draft,
      apiKey,
      onboardingCompleted: true,
    };
    try {
      await setProviderKey(next.provider, apiKey);
      await saveSettings(next);
      onComplete(next);
    } finally {
      setSaving(false);
    }
  }

  const canBack = step > 0;
  const canNext = step < 2;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="onboarding-panel" onClick={(e) => e.stopPropagation()}>
        <header className="onboarding-header">
          <div>
            <h2>TransLoop 初始设置</h2>
            <p>三步完成基础配置，之后都可以在设置里修改。</p>
          </div>
          <div className="onboarding-steps">
            {[0, 1, 2].map((item) => (
              <span key={item} className={item === step ? "active" : ""} />
            ))}
          </div>
        </header>

        <main className="onboarding-body">
          {step === 0 && (
            <section className="onboarding-step">
              <h3>Provider 与模型</h3>
              <div className="row">
                <div className="field">
                  <label>主翻译 Provider</label>
                  <select
                    value={draft.provider}
                    onChange={(e) => handleProviderChange(e.target.value as ProviderName)}
                  >
                    {PROVIDER_REGISTRY.filter((p) => p.implemented).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>模型</label>
                  <input
                    value={draft.model}
                    onChange={(e) => update("model", e.target.value)}
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="可先留空，稍后在设置里填写"
                  spellCheck={false}
                />
                <span className="hint">密钥保存在系统 keyring，不写入设置文件或诊断包。</span>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="onboarding-step">
              <h3>快捷键与 OCR</h3>
              <div className="row">
                <div className="field">
                  <label>划词翻译快捷键</label>
                  <HotkeyInput
                    value={draft.hotkey}
                    onChange={(value) => update("hotkey", value)}
                    placeholder={DEFAULT_SETTINGS.hotkey}
                  />
                </div>
                <div className="field">
                  <label>截图翻译快捷键</label>
                  <HotkeyInput
                    value={draft.captureHotkey}
                    onChange={(value) => update("captureHotkey", value)}
                    allowEmpty
                    placeholder={DEFAULT_SETTINGS.captureHotkey}
                  />
                </div>
              </div>
              <div className="field">
                <label>截图 OCR 模式</label>
                <select
                  value={draft.ocrMode}
                  onChange={(e) => update("ocrMode", e.target.value as AppSettings["ocrMode"])}
                >
                  <option value="A">A · 多模态模型</option>
                  <option value="B">B · Windows OCR</option>
                  <option value="C">C · Tesseract 本地 OCR</option>
                </select>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="onboarding-step">
              <h3>智能方向、缓存与隐私</h3>
              <div className="field">
                <label className="toggle-row">
                  <span>启用智能语言方向</span>
                  <input
                    type="checkbox"
                    checked={draft.smartDirectionEnabled}
                    onChange={(e) => update("smartDirectionEnabled", e.target.checked)}
                  />
                  <span className="toggle" />
                </label>
              </div>
              <div className="row">
                <div className="field">
                  <label>默认翻译成</label>
                  <select
                    value={draft.smartPrimaryTargetLang}
                    onChange={(e) => update("smartPrimaryTargetLang", e.target.value)}
                  >
                    {LANG_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>原文已是该语言时翻译成</label>
                  <select
                    value={draft.smartAlternateTargetLang}
                    onChange={(e) => update("smartAlternateTargetLang", e.target.value)}
                  >
                    {LANG_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="toggle-row">
                  <span>启用短期翻译缓存</span>
                  <input
                    type="checkbox"
                    checked={draft.translationCacheEnabled}
                    onChange={(e) => update("translationCacheEnabled", e.target.checked)}
                  />
                  <span className="toggle" />
                </label>
                <span className="hint">
                  诊断日志和设置导出不会包含 API Key、原文、译文或截图内容；翻译缓存只用于本机复用。
                </span>
              </div>
            </section>
          )}
        </main>

        <footer className="onboarding-footer">
          {onClose && (
            <button className="ghost" onClick={onClose}>
              稍后
            </button>
          )}
          <div className="spacer" />
          <button className="ghost" disabled={!canBack} onClick={() => setStep((prev) => prev - 1)}>
            上一步
          </button>
          {canNext ? (
            <button className="primary" onClick={() => setStep((prev) => prev + 1)}>
              下一步
            </button>
          ) : (
            <button className="primary" onClick={finish} disabled={saving}>
              {saving ? "保存中..." : "完成"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
