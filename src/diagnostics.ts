import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "./appInfo";
import { redactSensitive } from "./sanitize";

export type DiagnosticLevel = "info" | "warn" | "error";

export interface DiagnosticEvent {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  category: string;
  message: string;
  appVersion: string;
  platform: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  errorKind?: string;
  errorSummary?: string;
}

export interface DiagnosticSnapshot {
  appVersion: string;
  platform: string;
  arch: string;
  tesseractAvailable: boolean;
  tesseractVersion?: string;
  tesseractError?: string;
}

export type DiagnosticEventInput = Omit<
  Partial<DiagnosticEvent>,
  "id" | "timestamp" | "appVersion" | "platform"
> & {
  level: DiagnosticLevel;
  category: string;
  message: string;
};

const DIAGNOSTICS_FILE = "diagnostics.json";
const DIAGNOSTICS_KEY = "events";
const MAX_EVENTS = 1500;
const MAX_AGE_DAYS = 14;

let storePromise: Promise<Store> | null = null;

async function getDiagnosticsStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(DIAGNOSTICS_FILE, { autoSave: true, defaults: {} });
  }
  return storePromise;
}

export async function logDiagnosticEvent(input: DiagnosticEventInput): Promise<void> {
  try {
    const store = await getDiagnosticsStore();
    const records = normalizeEvents(await store.get<unknown>(DIAGNOSTICS_KEY));
    const record: DiagnosticEvent = {
      id: createId(),
      timestamp: new Date().toISOString(),
      appVersion: APP_VERSION,
      platform: navigator.platform || "unknown",
      ...sanitizeEvent(input),
    };
    await store.set(DIAGNOSTICS_KEY, trimEvents([record, ...records]));
    await store.save();
  } catch {
    /* diagnostics must never break the user workflow */
  }
}

export async function listDiagnosticEvents(): Promise<DiagnosticEvent[]> {
  const store = await getDiagnosticsStore();
  const records = normalizeEvents(await store.get<unknown>(DIAGNOSTICS_KEY));
  const trimmed = trimEvents(records);
  if (trimmed.length !== records.length) {
    await store.set(DIAGNOSTICS_KEY, trimmed);
    await store.save();
  }
  return trimmed.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function clearDiagnosticEvents(): Promise<void> {
  const store = await getDiagnosticsStore();
  await store.set(DIAGNOSTICS_KEY, []);
  await store.save();
}

export async function getDiagnosticSnapshot(): Promise<DiagnosticSnapshot> {
  try {
    return await invoke<DiagnosticSnapshot>("diagnostic_snapshot");
  } catch (e) {
    return {
      appVersion: APP_VERSION,
      platform: navigator.platform || "unknown",
      arch: "unknown",
      tesseractAvailable: false,
      tesseractError: e instanceof Error ? e.message : String(e),
    };
  }
}

function trimEvents(records: DiagnosticEvent[]): DiagnosticEvent[] {
  const minTime = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return records
    .filter((record) => {
      const time = Date.parse(record.timestamp);
      return Number.isFinite(time) && time >= minTime;
    })
    .slice(0, MAX_EVENTS);
}

function sanitizeEvent(input: DiagnosticEventInput): DiagnosticEventInput {
  return {
    ...input,
    category: redactSensitive(input.category, 80),
    message: redactSensitive(input.message, 300),
    provider: input.provider ? redactSensitive(input.provider, 80) : undefined,
    model: input.model ? redactSensitive(input.model, 160) : undefined,
    errorSummary: input.errorSummary ? redactSensitive(input.errorSummary, 300) : undefined,
  };
}

function normalizeEvents(value: unknown): DiagnosticEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is DiagnosticEvent => isRecord(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id.slice(0, 128) : createId(),
      timestamp: typeof item.timestamp === "string" ? item.timestamp.slice(0, 64) : new Date().toISOString(),
      level: item.level === "warn" || item.level === "error" ? item.level : "info",
      category: redactSensitive(typeof item.category === "string" ? item.category : "unknown", 80),
      message: redactSensitive(typeof item.message === "string" ? item.message : "", 300),
      appVersion: APP_VERSION,
      platform: navigator.platform || "unknown",
      provider: typeof item.provider === "string" ? redactSensitive(item.provider, 80) : undefined,
      model: typeof item.model === "string" ? redactSensitive(item.model, 160) : undefined,
      durationMs: typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
        ? Math.max(0, Math.min(item.durationMs, 86_400_000))
        : undefined,
      errorKind: typeof item.errorKind === "string" ? redactSensitive(item.errorKind, 80) : undefined,
      errorSummary: typeof item.errorSummary === "string" ? redactSensitive(item.errorSummary, 300) : undefined,
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `diag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
