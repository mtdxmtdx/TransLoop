import { load, type Store } from "@tauri-apps/plugin-store";
import type { OcrMode } from "./store";
import type { ProviderName } from "./providers/types";

export type HistoryKind = "selection" | "capture";

export interface TranslationHistoryRecord {
  id: string;
  kind: HistoryKind;
  original: string;
  translation: string;
  fromLang: string;
  toLang: string;
  provider: ProviderName;
  model: string;
  ocrMode?: OcrMode;
  imagePreview?: string;
  createdAt: string;
}

export interface AddHistoryInput {
  kind: HistoryKind;
  original: string;
  translation: string;
  fromLang: string;
  toLang: string;
  provider: ProviderName;
  model: string;
  ocrMode?: OcrMode;
  imagePreview?: string;
}

const HISTORY_FILE = "history.json";
const HISTORY_KEY = "records";
const MAX_HISTORY = 200;

let historyStorePromise: Promise<Store> | null = null;

async function getHistoryStore(): Promise<Store> {
  if (!historyStorePromise) {
    historyStorePromise = load(HISTORY_FILE, { autoSave: true, defaults: {} });
  }
  return historyStorePromise;
}

export async function listHistory(): Promise<TranslationHistoryRecord[]> {
  const store = await getHistoryStore();
  const records = (await store.get<TranslationHistoryRecord[]>(HISTORY_KEY)) ?? [];
  return records
    .filter((record) => record.original || record.translation)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addHistory(input: AddHistoryInput): Promise<void> {
  if (!input.original.trim() && !input.translation.trim()) return;

  const store = await getHistoryStore();
  const records = (await store.get<TranslationHistoryRecord[]>(HISTORY_KEY)) ?? [];
  const record: TranslationHistoryRecord = {
    id: createHistoryId(),
    ...input,
    createdAt: new Date().toISOString(),
  };

  const next = [record, ...records].slice(0, MAX_HISTORY);
  await store.set(HISTORY_KEY, next);
  await store.save();
}

export async function deleteHistory(id: string): Promise<void> {
  const store = await getHistoryStore();
  const records = (await store.get<TranslationHistoryRecord[]>(HISTORY_KEY)) ?? [];
  await store.set(
    HISTORY_KEY,
    records.filter((record) => record.id !== id),
  );
  await store.save();
}

export async function clearHistory(): Promise<void> {
  const store = await getHistoryStore();
  await store.set(HISTORY_KEY, []);
  await store.save();
}

function createHistoryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
