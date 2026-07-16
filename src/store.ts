import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { PROVIDER_REGISTRY, type ProviderName } from "./providers/types";

/** OCR 模式：A = 多模态模型；B = Windows 系统 OCR；C = Tesseract 本地 OCR。 */
export type OcrMode = "A" | "B" | "C";

export interface AppSettings {
  hotkey: string;
  captureHotkey: string;
  provider: ProviderName;
  baseUrl: string;
  model: string;
  fromLang: string;
  toLang: string;
  streamOutput: boolean;
  ocrMode: OcrMode;
  /** 多模型协作（仅模式 A）：先用识别模型 OCR，再用上面的翻译提供方翻译。 */
  visionCollab: boolean;
  recognizeProvider: ProviderName;
  recognizeBaseUrl: string;
  recognizeModel: string;
  fallbackEnabled: boolean;
  fallbackModels: string[];
  fallbackProviderOrder: ProviderName[];
  providerConfigs: Partial<Record<ProviderName, { baseUrl: string; model: string }>>;
  smartDirectionEnabled: boolean;
  smartPrimaryTargetLang: string;
  smartAlternateTargetLang: string;
  translationCacheEnabled: boolean;
  onboardingCompleted: boolean;
  lastUpdateCheckAt?: string;
  diagnosticLoggingEnabled: boolean;
  privacyPolicyVersion: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: "Alt+Q",
  captureHotkey: "Alt+S",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  fromLang: "auto",
  toLang: "zh",
  streamOutput: true,
  ocrMode: "A",
  visionCollab: false,
  recognizeProvider: "qwen",
  recognizeBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  recognizeModel: "qwen3-vl-flash",
  fallbackEnabled: true,
  fallbackModels: [],
  fallbackProviderOrder: ["openai", "qwen", "claude", "gemini", "deepseek", "grok", "minimax"],
  providerConfigs: {},
  smartDirectionEnabled: true,
  smartPrimaryTargetLang: "zh",
  smartAlternateTargetLang: "en",
  translationCacheEnabled: true,
  onboardingCompleted: false,
  lastUpdateCheckAt: undefined,
  diagnosticLoggingEnabled: false,
  // 0 means the current policy has not been acknowledged in this profile.
  privacyPolicyVersion: 0,
};

const STORE_FILE = "settings.json";
const SETTINGS_KEY = "settings";

let storePromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storePromise;
}

/** 只返回密钥是否存在，不把密钥值暴露给 WebView。 */
export async function hasProviderKey(provider: ProviderName): Promise<boolean> {
  return invoke<boolean>("provider_secret_status", { provider });
}

/** 写入某个提供方的 API Key；空串等同删除。 */
export async function setProviderKey(provider: ProviderName, value: string): Promise<void> {
  if (value.length > 512) throw new Error("API Key 长度超过限制。");
  await invoke("set_provider_secret", { provider, value });
}

export async function loadSettings(): Promise<AppSettings> {
  // 迁移在 Rust 侧读取旧 settings.json/keyring，避免旧版明文密钥进入 WebView。
  try {
    await invoke("migrate_legacy_secrets");
  } catch {
    // Do not continue with defaults: doing so could make the user save over
    // a profile whose legacy credential migration has not completed safely.
    throw new Error("无法安全迁移旧版凭证，请重启应用后重试。");
  }
  const store = await getStore();
  const saved = await store.get<unknown>(SETTINGS_KEY);
  return normalizeSettings(saved);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getStore();
  // Never spread an object supplied by a renderer/importer.  Explicitly
  // rebuilding the DTO prevents legacy apiKey/token/password fields from
  // being reintroduced into settings.json.
  const persisted = normalizeSettings(settings);
  const withCurrentProviderConfig = {
    ...persisted,
    providerConfigs: {
      ...persisted.providerConfigs,
      [persisted.provider]: {
        baseUrl: persisted.baseUrl,
        model: persisted.model,
      },
    },
  };
  await store.set(SETTINGS_KEY, withCurrentProviderConfig);
  await store.save();
}

const PROVIDER_IDS = new Set(PROVIDER_REGISTRY.map((provider) => provider.id));
const LANGUAGES = new Set(["auto", "zh", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru"]);
const MAX_HOTKEY_LENGTH = 64;
const MAX_MODEL_LENGTH = 200;
const MAX_BASE_URL_LENGTH = 512;

/**
 * Convert data loaded from the store or an imported file into a closed
 * AppSettings DTO.  This function is deliberately allow-list based: a
 * TypeScript cast is not a runtime security boundary.
 */
export function normalizeSettings(input: unknown): AppSettings {
  const source = isRecord(input) ? input : {};
  const provider = validProvider(source.provider) ? source.provider : DEFAULT_SETTINGS.provider;
  const recognizeProvider = validProvider(source.recognizeProvider)
    ? source.recognizeProvider
    : DEFAULT_SETTINGS.recognizeProvider;
  const providerConfigs = normalizeProviderConfigs(source.providerConfigs);
  const providerMeta = PROVIDER_REGISTRY.find((item) => item.id === provider)!;
  const recognizeMeta = PROVIDER_REGISTRY.find((item) => item.id === recognizeProvider)!;

  return {
    hotkey: boundedString(source.hotkey, MAX_HOTKEY_LENGTH) ?? DEFAULT_SETTINGS.hotkey,
    captureHotkey:
      typeof source.captureHotkey === "string" && source.captureHotkey.length <= MAX_HOTKEY_LENGTH
        ? source.captureHotkey
        : DEFAULT_SETTINGS.captureHotkey,
    provider,
    baseUrl:
      normalizeProviderUrl(provider, source.baseUrl) ??
      providerMeta.defaultBaseUrl,
    model: boundedString(source.model, MAX_MODEL_LENGTH) ?? providerMeta.defaultModel,
    fromLang: validLanguage(source.fromLang) ? source.fromLang : DEFAULT_SETTINGS.fromLang,
    toLang: validTargetLanguage(source.toLang) ? source.toLang : DEFAULT_SETTINGS.toLang,
    streamOutput: booleanOrDefault(source.streamOutput, DEFAULT_SETTINGS.streamOutput),
    ocrMode: validOcrMode(source.ocrMode) ? source.ocrMode : DEFAULT_SETTINGS.ocrMode,
    visionCollab: booleanOrDefault(source.visionCollab, DEFAULT_SETTINGS.visionCollab),
    recognizeProvider,
    recognizeBaseUrl:
      normalizeProviderUrl(recognizeProvider, source.recognizeBaseUrl) ??
      recognizeMeta.defaultBaseUrl,
    recognizeModel:
      boundedString(source.recognizeModel, MAX_MODEL_LENGTH) ?? recognizeMeta.defaultModel,
    fallbackEnabled: booleanOrDefault(source.fallbackEnabled, DEFAULT_SETTINGS.fallbackEnabled),
    fallbackModels: stringArray(source.fallbackModels, MAX_MODEL_LENGTH, 20),
    fallbackProviderOrder: providerArray(source.fallbackProviderOrder, 7),
    providerConfigs,
    smartDirectionEnabled: booleanOrDefault(
      source.smartDirectionEnabled,
      DEFAULT_SETTINGS.smartDirectionEnabled,
    ),
    smartPrimaryTargetLang: validTargetLanguage(source.smartPrimaryTargetLang)
      ? source.smartPrimaryTargetLang
      : DEFAULT_SETTINGS.smartPrimaryTargetLang,
    smartAlternateTargetLang: validTargetLanguage(source.smartAlternateTargetLang)
      ? source.smartAlternateTargetLang
      : DEFAULT_SETTINGS.smartAlternateTargetLang,
    translationCacheEnabled: booleanOrDefault(
      source.translationCacheEnabled,
      DEFAULT_SETTINGS.translationCacheEnabled,
    ),
    onboardingCompleted: booleanOrDefault(
      source.onboardingCompleted,
      DEFAULT_SETTINGS.onboardingCompleted,
    ),
    lastUpdateCheckAt:
      typeof source.lastUpdateCheckAt === "string" && source.lastUpdateCheckAt.length <= 64
        ? source.lastUpdateCheckAt
        : undefined,
    diagnosticLoggingEnabled: booleanOrDefault(
      source.diagnosticLoggingEnabled,
      DEFAULT_SETTINGS.diagnosticLoggingEnabled,
    ),
    privacyPolicyVersion:
      typeof source.privacyPolicyVersion === "number" &&
      Number.isInteger(source.privacyPolicyVersion) &&
      source.privacyPolicyVersion >= 0 &&
      source.privacyPolicyVersion <= 100
        ? source.privacyPolicyVersion
        : DEFAULT_SETTINGS.privacyPolicyVersion,
  };
}

function normalizeProviderConfigs(value: unknown): AppSettings["providerConfigs"] {
  if (!isRecord(value)) return {};
  const result: AppSettings["providerConfigs"] = {};
  for (const [provider, rawConfig] of Object.entries(value).slice(0, PROVIDER_REGISTRY.length)) {
    if (!validProvider(provider) || !isRecord(rawConfig)) continue;
    const meta = PROVIDER_REGISTRY.find((item) => item.id === provider)!;
    const baseUrl = normalizeProviderUrl(provider, rawConfig.baseUrl) ?? meta.defaultBaseUrl;
    const model = boundedString(rawConfig.model, MAX_MODEL_LENGTH) ?? meta.defaultModel;
    result[provider] = { baseUrl, model };
  }
  return result;
}

function normalizeProviderUrl(provider: ProviderName, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE_URL_LENGTH) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    const expected = providerHostAllowed(provider, url.hostname);
    if (
      url.protocol !== "https:" ||
      !expected ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function providerHostAllowed(provider: ProviderName, hostname: string): boolean {
  if (provider === "qwen") {
    return hostname === "dashscope.aliyuncs.com" || hostname === "dashscope-intl.aliyuncs.com";
  }
  const base = PROVIDER_REGISTRY.find((item) => item.id === provider)?.defaultBaseUrl;
  return base ? hostname === new URL(base).hostname : false;
}

function validProvider(value: unknown): value is ProviderName {
  return typeof value === "string" && PROVIDER_IDS.has(value as ProviderName);
}

function validLanguage(value: unknown): value is string {
  return typeof value === "string" && LANGUAGES.has(value);
}

function validTargetLanguage(value: unknown): value is string {
  return validLanguage(value) && value !== "auto";
}

function validOcrMode(value: unknown): value is OcrMode {
  return value === "A" || value === "B" || value === "C";
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : undefined;
}

function stringArray(value: unknown, maxItemLength: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => boundedString(item, maxItemLength) !== undefined)
    .map((item) => item.trim())
    .slice(0, maxItems);
}

function providerArray(value: unknown, maxItems: number): ProviderName[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.fallbackProviderOrder];
  return value.filter(validProvider).slice(0, maxItems);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
