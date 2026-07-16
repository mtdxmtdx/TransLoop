import { invoke } from "@tauri-apps/api/core";
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

export async function listHistory(): Promise<TranslationHistoryRecord[]> {
  const records = await invoke<TranslationHistoryRecord[]>("secure_history_get");
  return records
    .filter((record) => record.original || record.translation)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addHistory(input: AddHistoryInput): Promise<void> {
  if (!input.original.trim() && !input.translation.trim()) return;
  await invoke("secure_history_add", {
    record: { id: createHistoryId(), ...input, createdAt: new Date().toISOString() },
  });
}

export async function deleteHistory(id: string): Promise<void> {
  await invoke("secure_history_delete", { id });
}

export async function clearHistory(): Promise<void> {
  await invoke("secure_history_clear");
}

function createHistoryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
