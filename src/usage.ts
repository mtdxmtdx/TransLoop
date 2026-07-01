import { load, type Store } from "@tauri-apps/plugin-store";
import type { OcrMode } from "./store";
import type { ProviderName } from "./providers/types";

export type UsageEntryKind = "main" | "selection" | "capture" | "test";
export type UsageStatus = "success" | "error" | "skipped";

export interface UsageRecord {
  id: string;
  fallbackGroupId: string;
  createdAt: string;
  entryKind: UsageEntryKind;
  provider: ProviderName;
  model: string;
  fromLang: string;
  toLang: string;
  ocrMode?: OcrMode;
  status: UsageStatus;
  errorKind?: string;
  errorSummary?: string;
  durationMs: number;
  isFallback: boolean;
  inputChars: number;
  outputChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd?: number;
}

export interface AddUsageInput extends Omit<UsageRecord, "id" | "createdAt"> {}

const USAGE_FILE = "usage.json";
const USAGE_KEY = "records";
const MAX_USAGE = 5000;
const MAX_AGE_DAYS = 90;

const MODEL_PRICES_USD_PER_1M: Record<string, { input: number; output: number }> = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "qwen3-vl-flash": { input: 0.25, output: 0.75 },
  "grok-2-vision-latest": { input: 2, output: 10 },
  "abab6.5s-chat": { input: 0.3, output: 0.3 },
};

let usageStorePromise: Promise<Store> | null = null;

async function getUsageStore(): Promise<Store> {
  if (!usageStorePromise) {
    usageStorePromise = load(USAGE_FILE, { autoSave: true, defaults: {} });
  }
  return usageStorePromise;
}

export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = MODEL_PRICES_USD_PER_1M[model];
  if (!price) return undefined;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export async function listUsage(): Promise<UsageRecord[]> {
  const store = await getUsageStore();
  const records = (await store.get<UsageRecord[]>(USAGE_KEY)) ?? [];
  return trimUsage(records).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addUsage(input: AddUsageInput): Promise<void> {
  const store = await getUsageStore();
  const records = (await store.get<UsageRecord[]>(USAGE_KEY)) ?? [];
  const record: UsageRecord = {
    id: createUsageId(),
    createdAt: new Date().toISOString(),
    ...input,
  };
  await store.set(USAGE_KEY, trimUsage([record, ...records]));
  await store.save();
}

export async function clearUsage(): Promise<void> {
  const store = await getUsageStore();
  await store.set(USAGE_KEY, []);
  await store.save();
}

export function createUsageGroupId(): string {
  return createUsageId().replace(/^usage-/, "usage-group-");
}

function trimUsage(records: UsageRecord[]): UsageRecord[] {
  const minTime = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return records
    .filter((record) => {
      const time = Date.parse(record.createdAt);
      return Number.isFinite(time) && time >= minTime;
    })
    .slice(0, MAX_USAGE);
}

function createUsageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `usage-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
