import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderName } from "./providers/types";

/** OCR 模式：A = 多模态模型；B = Windows 系统 OCR；C = Tesseract 本地 OCR。 */
export type OcrMode = "A" | "B" | "C";

export interface AppSettings {
  hotkey: string;
  captureHotkey: string;
  provider: ProviderName;
  apiKey: string;
  baseUrl: string;
  model: string;
  fromLang: string;
  toLang: string;
  streamOutput: boolean;
  ocrMode: OcrMode;
  /** 多模型协作（仅模式 A）：先用识别模型 OCR，再用上面的翻译提供方翻译。 */
  visionCollab: boolean;
  recognizeProvider: ProviderName;
  recognizeApiKey: string;
  recognizeBaseUrl: string;
  recognizeModel: string;
  fallbackEnabled: boolean;
  fallbackModels: string[];
  fallbackProviderOrder: ProviderName[];
  providerConfigs: Partial<Record<ProviderName, { baseUrl: string; model: string }>>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: "Alt+Q",
  captureHotkey: "Alt+S",
  provider: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  fromLang: "auto",
  toLang: "zh",
  streamOutput: true,
  ocrMode: "A",
  visionCollab: false,
  recognizeProvider: "qwen",
  recognizeApiKey: "",
  recognizeBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  recognizeModel: "qwen3-vl-flash",
  fallbackEnabled: true,
  fallbackModels: [],
  fallbackProviderOrder: ["openai", "qwen", "claude", "gemini", "deepseek", "grok", "minimax"],
  providerConfigs: {},
};

const STORE_FILE = "settings.json";
const SETTINGS_KEY = "settings";

// API Key 不写入 settings.json，改存 OS keyring（见 Rust set_secret/get_secret）。
// 按「提供方」分别存储，keyring 条目名形如 `apikey.deepseek`、`apikey.openai`，
// 这样切换提供方时会自动取对应的 key。
function providerKeyName(provider: ProviderName): string {
  return `apikey.${provider}`;
}

let storePromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storePromise;
}

/** 读取某个提供方的 API Key（不存在返回空串）。 */
export async function getProviderKey(provider: ProviderName): Promise<string> {
  try {
    return (
      (await invoke<string | null>("get_secret", {
        key: providerKeyName(provider),
      })) ?? ""
    );
  } catch {
    return "";
  }
}

/** 写入某个提供方的 API Key（空串等同删除，Rust 侧处理）。 */
export async function setProviderKey(
  provider: ProviderName,
  value: string,
): Promise<void> {
  await invoke("set_secret", { key: providerKeyName(provider), value });
}

async function getSecret(key: string): Promise<string> {
  try {
    return (await invoke<string | null>("get_secret", { key })) ?? "";
  } catch {
    return "";
  }
}

async function setSecret(key: string, value: string): Promise<void> {
  await invoke("set_secret", { key, value });
}

/**
 * 一次性迁移旧版密钥到「按提供方」的 keyring 条目：
 * - settings.json 里残留的明文 apiKey / recognizeApiKey；
 * - 阶段 3 引入的按角色存储（keyring 条目 `apiKey` / `recognizeApiKey`）。
 * 迁移后会落到对应提供方名下，并清掉旧条目。
 */
async function migrateLegacyKeys(
  store: Store,
  saved: Partial<AppSettings>,
): Promise<void> {
  const provider = saved.provider ?? DEFAULT_SETTINGS.provider;
  const recognizeProvider =
    saved.recognizeProvider ?? DEFAULT_SETTINGS.recognizeProvider;

  // 1) settings.json 明文（更早版本）。
  let needsRewrite = false;
  const plainApi = saved.apiKey;
  if (typeof plainApi === "string" && plainApi) {
    if (!(await getProviderKey(provider))) await setProviderKey(provider, plainApi);
    delete saved.apiKey;
    needsRewrite = true;
  }
  const plainRec = saved.recognizeApiKey;
  if (typeof plainRec === "string" && plainRec) {
    if (!(await getProviderKey(recognizeProvider)))
      await setProviderKey(recognizeProvider, plainRec);
    delete saved.recognizeApiKey;
    needsRewrite = true;
  }
  if (needsRewrite) {
    await store.set(SETTINGS_KEY, saved);
    await store.save();
  }

  // 2) 阶段 3 的按角色 keyring 条目 → 按提供方。迁移完删除旧条目。
  const roleApi = await getSecret("apiKey");
  if (roleApi) {
    if (!(await getProviderKey(provider))) await setProviderKey(provider, roleApi);
    await setSecret("apiKey", "");
  }
  const roleRec = await getSecret("recognizeApiKey");
  if (roleRec) {
    if (!(await getProviderKey(recognizeProvider)))
      await setProviderKey(recognizeProvider, roleRec);
    await setSecret("recognizeApiKey", "");
  }
}

export async function loadSettings(): Promise<AppSettings> {
  const store = await getStore();
  const saved = (await store.get<Partial<AppSettings>>(SETTINGS_KEY)) ?? {};

  await migrateLegacyKeys(store, saved);

  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    fallbackModels: Array.isArray(saved.fallbackModels)
      ? saved.fallbackModels
      : DEFAULT_SETTINGS.fallbackModels,
    fallbackProviderOrder: Array.isArray(saved.fallbackProviderOrder)
      ? saved.fallbackProviderOrder
      : DEFAULT_SETTINGS.fallbackProviderOrder,
    providerConfigs: {
      ...DEFAULT_SETTINGS.providerConfigs,
      ...(saved.providerConfigs ?? {}),
    },
  };
  // 按当前选定的提供方解析出对应的 key 作为「当前生效值」。
  const [apiKey, recognizeApiKey] = await Promise.all([
    getProviderKey(merged.provider),
    getProviderKey(merged.recognizeProvider),
  ]);

  return { ...merged, apiKey, recognizeApiKey };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getStore();
  // 把当前生效的 key 写到对应提供方名下；settings.json 不落盘明文。
  await Promise.all([
    setProviderKey(settings.provider, settings.apiKey),
    setProviderKey(settings.recognizeProvider, settings.recognizeApiKey),
  ]);
  const persisted: AppSettings = {
    ...settings,
    providerConfigs: {
      ...settings.providerConfigs,
      [settings.provider]: {
        baseUrl: settings.baseUrl,
        model: settings.model,
      },
    },
    apiKey: "",
    recognizeApiKey: "",
  };
  await store.set(SETTINGS_KEY, persisted);
  await store.save();
}
