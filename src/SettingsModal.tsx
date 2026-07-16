import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SETTINGS,
  hasProviderKey,
  loadSettings,
  saveSettings,
  setProviderKey,
  type AppSettings,
} from "./store";
import { PROVIDER_REGISTRY, type ProviderName } from "./providers/types";
import { HotkeyInput } from "./HotkeyInput";
import { testProviderConnection, type ProviderAttempt } from "./translationRuntime";
import { clearTranslationCache } from "./translationCache";
import {
  checkForUpdates,
  downloadAndLaunchVerifiedUpdate,
  type UpdateCheckResult,
} from "./updates";
import { APP_VERSION } from "./appInfo";
import { downloadBlob, downloadText } from "./fileDownload";
import {
  createDiagnosticPackage,
  createSettingsExport,
  parseImportedSettings,
} from "./settingsTransfer";
import { logDiagnosticEvent } from "./diagnostics";
import { toUserFacingError } from "./userFacingError";

interface Props {
  open: boolean;
  initial: AppSettings;
  onClose: () => void;
  onSaved: (next: AppSettings) => void;
  onOpenUsage?: () => void;
  onOpenOnboarding?: () => void;
  onOpenPrivacy?: () => void;
}

type StatusKind = "idle" | "saving" | "success" | "error";

const SMART_LANG_OPTIONS = [
  { value: "zh", label: "中文（简体）" },
  { value: "zh-TW", label: "中文（繁体）" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
  { value: "fr", label: "法文" },
  { value: "de", label: "德文" },
  { value: "es", label: "西班牙文" },
  { value: "ru", label: "俄文" },
];

export function SettingsModal({
  open,
  initial,
  onClose,
  onSaved,
  onOpenUsage,
  onOpenOnboarding,
  onOpenPrivacy,
}: Props) {
  const [draft, setDraft] = useState<AppSettings>(initial);
  // 只缓存本次编辑中用户主动输入的密钥；已存在的密钥只显示状态。
  const [keyMap, setKeyMap] = useState<Record<string, string>>({});
  const [configuredMap, setConfiguredMap] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: "idle",
    text: "",
  });
  const [autostart, setAutostart] = useState<boolean>(false);
  const [testStatus, setTestStatus] = useState<{
    main?: ProviderAttempt;
    recognize?: ProviderAttempt;
    loading?: "main" | "recognize";
  }>({});
  const [updateStatus, setUpdateStatus] = useState<{
    loading: boolean;
    result?: UpdateCheckResult;
    error?: string;
  }>({ loading: false });
  const [downloadStatus, setDownloadStatus] = useState<{
    kind: "idle" | "downloading" | "success" | "error";
    text: string;
  }>({ kind: "idle", text: "" });

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setStatus({ kind: "idle", text: "" });
    setTestStatus({});
    setUpdateStatus({ loading: false });
    setDownloadStatus({ kind: "idle", text: "" });
    // 加载开机自启动状态
    invoke<boolean>("get_autostart_status")
      .then(setAutostart)
      .catch(() => setAutostart(false));
    // 只读取各 Provider 的 configured 状态，不读取密钥值。
    let cancelled = false;
    Promise.all(
      PROVIDER_REGISTRY.map(async (p) => [p.id, await hasProviderKey(p.id)] as const),
    ).then((entries) => {
      if (cancelled) return;
      setConfiguredMap(Object.fromEntries(entries));
      setKeyMap({});
    });
    return () => {
      cancelled = true;
      // Do not retain user-entered secrets while the modal is closed or
      // between provider-status refreshes.
      setKeyMap({});
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
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "baseUrl" || key === "model") {
        next.providerConfigs = {
          ...prev.providerConfigs,
          [prev.provider]: {
            baseUrl: key === "baseUrl" ? String(value) : prev.baseUrl,
            model: key === "model" ? String(value) : prev.model,
          },
        };
      }
      return next;
    });
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
      providerConfigs: {
        ...prev.providerConfigs,
        [prev.provider]: { baseUrl: prev.baseUrl, model: prev.model },
      },
      provider: next,
      baseUrl: prev.providerConfigs[next]?.baseUrl ?? meta?.defaultBaseUrl ?? prev.baseUrl,
      model: prev.providerConfigs[next]?.model ?? meta?.defaultModel ?? prev.model,
    }));
    setStatus({ kind: "idle", text: "" });
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
  }

  async function handleSave() {
    setStatus({ kind: "saving", text: "保存中…" });
    try {
      // 只写入本次被编辑过的密钥；空字符串表示用户明确删除。
      await Promise.all(
        Object.entries(keyMap).map(([provider, key]) =>
          setProviderKey(provider as ProviderName, key),
        ),
      );
      await saveSettings(draft);
      await invoke("reload_shortcuts");
      onSaved(draft);
      setKeyMap({});
      // 保存成功后自动关闭设置窗口；失败时保持打开以展示错误。
      onClose();
    } catch (e) {
      setStatus({ kind: "error", text: `保存失败：${toUserFacingError(e, "settings")}` });
    }
  }

  function handleReset() {
    setDraft(DEFAULT_SETTINGS);
    setStatus({ kind: "idle", text: "" });
  }

  async function handleTestMain() {
    setTestStatus((prev) => ({ ...prev, loading: "main" }));
    const attempt = await testProviderConnection({
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      model: draft.model,
      settings: draft,
      fromLang: draft.fromLang,
      toLang: draft.toLang,
    });
    setTestStatus((prev) => ({ ...prev, main: attempt, loading: undefined }));
  }

  async function handleTestRecognize() {
    setTestStatus((prev) => ({ ...prev, loading: "recognize" }));
    const attempt = await testProviderConnection({
      provider: draft.recognizeProvider,
      baseUrl: draft.recognizeBaseUrl,
      model: draft.recognizeModel,
      settings: draft,
      fromLang: draft.fromLang,
      toLang: draft.toLang,
    });
    setTestStatus((prev) => ({ ...prev, recognize: attempt, loading: undefined }));
  }

  function updateFallbackModels(value: string) {
    update(
      "fallbackModels",
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  function toggleFallbackProvider(provider: ProviderName, checked: boolean) {
    const current = draft.fallbackProviderOrder.filter((item) => item !== provider);
    update("fallbackProviderOrder", checked ? [...current, provider] : current);
  }

  function renderAttempt(attempt?: ProviderAttempt) {
    if (!attempt) return null;
    const ok = attempt.status === "success";
    return (
      <span className={`status ${ok ? "success" : "error"}`}>
        {ok
          ? `连接成功：${attempt.provider} / ${attempt.model}，${attempt.durationMs}ms`
          : `连接失败：${toUserFacingError(
              attempt.errorSummary ?? attempt.errorKind ?? "未知错误",
              "provider_test",
            )}`}
      </span>
    );
  }

  async function handleClearTranslationCache() {
    await clearTranslationCache();
    setStatus({ kind: "success", text: "翻译缓存已清空" });
  }

  async function handleCheckUpdate() {
    setUpdateStatus({ loading: true });
    try {
      const result = await checkForUpdates();
      update("lastUpdateCheckAt", new Date().toISOString());
      setUpdateStatus({ loading: false, result });
      setStatus({
        kind: "success",
        text: result.hasUpdate
          ? `发现新版本 ${result.latestVersion}`
          : `当前已是最新版本 ${result.currentVersion}`,
      });
    } catch (e) {
      const error = toUserFacingError(e, "update");
      setUpdateStatus({ loading: false, error });
      setStatus({ kind: "error", text: `检查更新失败：${error}` });
    }
  }

  async function handleDownloadUpdate() {
    const result = updateStatus.result;
    if (!result?.hasUpdate) {
      setDownloadStatus({ kind: "error", text: "当前没有可用的新版本。" });
      return;
    }
    if (!result.verificationAvailable) {
      setDownloadStatus({ kind: "error", text: "该版本缺少签名校验文件，已拒绝自动安装。" });
      return;
    }
    setDownloadStatus({ kind: "downloading", text: "正在下载安装包..." });
    try {
      const verified = await downloadAndLaunchVerifiedUpdate(result.latestVersion);
      const sizeMb = (verified.size / 1024 / 1024).toFixed(1);
      setDownloadStatus({
        kind: "success",
        text: `安装包已完成签名校验并启动：${verified.fileName}（${sizeMb} MB）`,
      });
      await logDiagnosticEvent({
        level: "info",
        category: "update",
        message: `安装包签名校验并启动完成：${verified.fileName}`,
      });
    } catch (e) {
      const message = toUserFacingError(e, "update");
      setDownloadStatus({
        kind: "error",
        text: `${message} 可打开发布页手动下载。`,
      });
      await logDiagnosticEvent({
        level: "error",
        category: "update",
        message: "安装包下载失败",
        errorSummary: message,
      });
    }
  }

  function handleOpenReleasePage() {
    const url = updateStatus.result?.releaseUrl;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  function handleExportSettings() {
    const exportFile = createSettingsExport(draft);
    downloadText(
      JSON.stringify(exportFile, null, 2),
      `transloop-settings-${new Date().toISOString().slice(0, 10)}.json`,
    );
    setStatus({ kind: "success", text: "设置已导出（不含 API Key）" });
  }

  async function handleImportSettings() {
    try {
      const text = await pickTextFile();
      const imported = parseImportedSettings(text);
      const next: AppSettings = imported;
      await saveSettings(next);
      await invoke("reload_shortcuts");
      setDraft(next);
      onSaved(next);
      setStatus({
        kind: "success",
        text: "设置已导入并生效，API Key 仍需在本机 keyring 中配置。",
      });
      await logDiagnosticEvent({
        level: "info",
        category: "settings",
        message: "导入设置成功",
      });
    } catch (e) {
      const message = toUserFacingError(e, "settings");
      setStatus({ kind: "error", text: `导入设置失败：${message}` });
      await logDiagnosticEvent({
        level: "error",
        category: "settings",
        message: "导入设置失败",
        errorSummary: message,
      });
    }
  }

  async function handleExportDiagnostics() {
    const ok = window.confirm(
      "诊断包会包含脱敏设置、诊断日志、用量汇总和环境检测结果；不会包含 API Key、原文、译文、截图或历史正文。是否继续？",
    );
    if (!ok) return;
    try {
      const blob = await createDiagnosticPackage(draft);
      downloadBlob(blob, `transloop-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`);
      setStatus({ kind: "success", text: "诊断包已导出。" });
    } catch (e) {
      const message = toUserFacingError(e, "diagnostics");
      setStatus({ kind: "error", text: `导出诊断包失败：${message}` });
      await logDiagnosticEvent({
        level: "error",
        category: "diagnostics",
        message: "导出诊断包失败",
        errorSummary: message,
      });
    }
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
              <option value="C">C · Tesseract 本地 OCR（离线兜底，需本机安装）</option>
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
            {draft.ocrMode === "C" && (
              <span className="hint">
                依赖本机已安装 Tesseract OCR，并确保 <code>tesseract</code> 命令在 PATH
                中；适合作为系统 OCR 不可用时的离线兜底。
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
                      placeholder={
                        configuredMap[draft.recognizeProvider]
                          ? "已配置（留空表示不修改）"
                          : "填写 API Key"
                      }
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
                        placeholder={recognizeMeta?.defaultModel ?? "模型名称"}
                        spellCheck={false}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <button
                      className="ghost"
                      onClick={handleTestRecognize}
                      disabled={testStatus.loading === "recognize"}
                    >
                      {testStatus.loading === "recognize" ? "测试中..." : "测试识别 Provider"}
                    </button>
                    {renderAttempt(testStatus.recognize)}
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
            <span className="hint">
              选择服务商，下方 Model 填写该商提供的具体模型名（切换服务商会自动填入一个常用默认值，可改）。
            </span>
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
              placeholder={
                configuredMap[draft.provider] ? "已配置（留空表示不修改）" : "填写 API Key"
              }
              spellCheck={false}
            />
            <span className="hint">
              密钥只在本次输入时短暂存在 WebView，实际请求和持久化均由 Rust/keyring 处理；留空表示保留现有密钥。
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
                placeholder={providerMeta?.defaultModel ?? "模型名称"}
                spellCheck={false}
              />
              <span className="hint">手动填写模型名，如 {providerMeta?.defaultModel ?? "对应服务商的模型 ID"}。</span>
            </div>
          </div>

          <div className="field">
            <button
              className="ghost"
              onClick={handleTestMain}
              disabled={testStatus.loading === "main"}
            >
              {testStatus.loading === "main" ? "测试中..." : "测试翻译 Provider"}
            </button>
            {renderAttempt(testStatus.main)}
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
          <div className="field fallback-block">
            <label className="toggle-row">
              <span>启用智能语言方向</span>
              <input
                type="checkbox"
                checked={draft.smartDirectionEnabled}
                onChange={(e) => update("smartDirectionEnabled", e.target.checked)}
              />
              <span className="toggle" />
            </label>
            <span className="hint">
              源语言为自动检测时生效：默认翻译到指定语言；如果原文已是该语言，则翻译到备用语言。
            </span>
            <div className="row">
              <div className="field">
                <label>默认翻译成</label>
                <select
                  value={draft.smartPrimaryTargetLang}
                  onChange={(e) => update("smartPrimaryTargetLang", e.target.value)}
                >
                  {SMART_LANG_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>如果原文已是该语言，则翻译成</label>
                <select
                  value={draft.smartAlternateTargetLang}
                  onChange={(e) => update("smartAlternateTargetLang", e.target.value)}
                >
                  {SMART_LANG_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="field fallback-block">
            <label className="toggle-row">
              <span>启用翻译缓存</span>
              <input
                type="checkbox"
                checked={draft.translationCacheEnabled}
                onChange={(e) => update("translationCacheEnabled", e.target.checked)}
              />
              <span className="toggle" />
            </label>
            <span className="hint">
              缓存保存译文和原文哈希，不保存原文正文；默认保留 24 小时，最多 1000 条。
            </span>
            <button className="ghost" onClick={handleClearTranslationCache}>
              清空翻译缓存
            </button>
          </div>

          <div className="field fallback-block">
            <label className="toggle-row">
              <span>启用自动降级</span>
              <input
                type="checkbox"
                checked={draft.fallbackEnabled}
                onChange={(e) => update("fallbackEnabled", e.target.checked)}
              />
              <span className="toggle" />
            </label>
            <span className="hint">
              主模型失败时先尝试备用模型，再按下方顺序尝试备用 Provider；缺少 API Key 的候选会自动跳过。
            </span>
            <label>备用模型</label>
            <textarea
              className="settings-textarea"
              value={draft.fallbackModels.join("\n")}
              onChange={(e) => updateFallbackModels(e.target.value)}
              placeholder="每行一个备用模型，例如 deepseek-chat"
              spellCheck={false}
            />
            <label>备用 Provider 顺序</label>
            <div className="provider-checks">
              {PROVIDER_REGISTRY.filter((p) => p.implemented).map((p) => (
                <label key={p.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.fallbackProviderOrder.includes(p.id)}
                    onChange={(e) => toggleFallbackProvider(p.id, e.target.checked)}
                  />
                  <span>{p.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="field fallback-block">
            <label className="toggle-row">
              <span>启用诊断日志</span>
              <input
                type="checkbox"
                checked={draft.diagnosticLoggingEnabled}
                onChange={(e) => update("diagnosticLoggingEnabled", e.target.checked)}
              />
              <span className="toggle" />
            </label>
            <span className="hint">
              仅记录运行状态、Provider/模型、耗时和错误摘要；不记录 API Key、原文、译文或截图。
            </span>
          </div>

          <div className="field fallback-block">
            <label>产品化工具</label>
            <div className="settings-actions">
              <button className="ghost" onClick={handleCheckUpdate} disabled={updateStatus.loading}>
                {updateStatus.loading ? "检查中..." : "检查更新"}
              </button>
              <button className="ghost" onClick={handleExportDiagnostics}>
                导出诊断包
              </button>
              <button className="ghost" onClick={handleExportSettings}>
                导出设置
              </button>
              <button className="ghost" onClick={handleImportSettings}>
                导入设置
              </button>
              {onOpenOnboarding && (
                <button className="ghost" onClick={onOpenOnboarding}>
                  打开首次引导
                </button>
              )}
              {onOpenPrivacy && (
                <button className="ghost" onClick={onOpenPrivacy}>
                  隐私政策
                </button>
              )}
            </div>
            <span className="hint">
              当前版本 <code>{APP_VERSION}</code>。设置导出不含 API Key；导入后如缺 Key，请在本页重新填写。
            </span>
            {updateStatus.result && (
              <div className="update-result">
                <strong>
                  {updateStatus.result.hasUpdate
                    ? `发现新版本 ${updateStatus.result.latestVersion}`
                    : "当前已是最新版本"}
                </strong>
                <span>
                  当前 {updateStatus.result.currentVersion}
                  {updateStatus.result.publishedAt
                    ? ` · 发布于 ${new Date(updateStatus.result.publishedAt).toLocaleDateString()}`
                    : ""}
                </span>
                {updateStatus.result.hasUpdate && (
                  <div className="update-actions">
                    <button
                      className="text-btn"
                      onClick={handleDownloadUpdate}
                      disabled={downloadStatus.kind === "downloading"}
                    >
                      {downloadStatus.kind === "downloading" ? "下载中..." : "下载新版安装包"}
                    </button>
                    <button className="text-btn" onClick={handleOpenReleasePage}>
                      打开发布页
                    </button>
                  </div>
                )}
                {downloadStatus.text && (
                  <span
                    className={
                      downloadStatus.kind === "error"
                        ? "status error"
                        : downloadStatus.kind === "success"
                          ? "status success"
                          : "status"
                    }
                  >
                    {downloadStatus.text}
                  </span>
                )}
              </div>
            )}
            {updateStatus.error && <span className="status error">{updateStatus.error}</span>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="ghost" onClick={handleReset}>
            恢复默认
          </button>
          {onOpenUsage && (
            <button className="ghost" onClick={onOpenUsage}>
              用量
            </button>
          )}
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

function pickTextFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error("未选择文件。"));
        return;
      }
      file.text().then(resolve).catch(reject);
    };
    input.click();
  });
}
