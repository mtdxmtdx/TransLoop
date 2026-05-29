import { load, type Store } from "@tauri-apps/plugin-store";
import type { ProviderName } from "./providers/types";

export interface AppSettings {
  hotkey: string;
  provider: ProviderName;
  apiKey: string;
  baseUrl: string;
  model: string;
  fromLang: string;
  toLang: string;
  streamOutput: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: "Alt+Q",
  provider: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  fromLang: "auto",
  toLang: "zh",
  streamOutput: true,
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
