import { load, type Store } from "@tauri-apps/plugin-store";
import type { ProviderName } from "./providers/types";

/** OCR 模式：A = 多模态模型一步识别+翻译；B = Windows 系统离线 OCR 后再翻译。 */
export type OcrMode = "A" | "B";

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

export async function loadSettings(): Promise<AppSettings> {
  const store = await getStore();
  const saved = (await store.get<Partial<AppSettings>>(SETTINGS_KEY)) ?? {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getStore();
  await store.set(SETTINGS_KEY, settings);
  await store.save();
}
