import { APP_VERSION } from "./appInfo";
import { getDiagnosticSnapshot, listDiagnosticEvents, logDiagnosticEvent } from "./diagnostics";
import { createZip } from "./zip";
import { normalizeSettings, type AppSettings } from "./store";
import { listUsage, type UsageRecord } from "./usage";

export interface SettingsExportFile {
  schemaVersion: 2;
  appVersion: string;
  exportedAt: string;
  settings: AppSettings;
}

const MAX_IMPORT_BYTES = 1_000_000;

export function createSettingsExport(settings: AppSettings): SettingsExportFile {
  return {
    schemaVersion: 2,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: sanitizeSettings(settings),
  };
}

export function sanitizeSettings(settings: AppSettings): AppSettings {
  // Rebuild a closed DTO instead of spreading a value that may have come from
  // an old or tampered settings file.
  return normalizeSettings(settings);
}

export function parseImportedSettings(text: string): AppSettings {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error("设置文件超过 1 MB 限制。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("设置文件不是有效 JSON。");
  }
  if (!isRecord(parsed)) throw new Error("导入文件格式不正确。");
  const source = "settings" in parsed ? parsed.settings : parsed;
  if (!isRecord(source)) throw new Error("导入文件格式不正确。");
  return normalizeSettings(source);
}

export async function createDiagnosticPackage(settings: AppSettings): Promise<Blob> {
  const [snapshot, diagnostics, usage] = await Promise.all([
    getDiagnosticSnapshot(),
    listDiagnosticEvents(),
    listUsage().catch(() => [] as UsageRecord[]),
  ]);
  const usageSummary = summarizeUsage(usage);
  const safeSnapshot = {
    ...snapshot,
    tesseractVersion: snapshot.tesseractVersion
      ? sanitizeDiagnosticText(snapshot.tesseractVersion)
      : undefined,
    tesseractError: snapshot.tesseractError
      ? sanitizeDiagnosticText(snapshot.tesseractError)
      : undefined,
  };
  const manifest = {
    schemaVersion: 2,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    privacy:
      "This package excludes API keys, source text, translations, screenshots, translation cache content, and history body content.",
  };
  await logDiagnosticEvent({ level: "info", category: "diagnostics", message: "导出诊断包" });
  return createZip([
    { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    { name: "snapshot.json", content: JSON.stringify(safeSnapshot, null, 2) },
    { name: "settings.redacted.json", content: JSON.stringify(sanitizeSettings(settings), null, 2) },
    { name: "diagnostics.json", content: JSON.stringify(diagnostics, null, 2) },
    { name: "usage-summary.json", content: JSON.stringify(usageSummary, null, 2) },
  ]);
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/[A-Za-z]:\\[^\s)]+/g, "[path]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeUsage(records: UsageRecord[]) {
  const byStatus: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  let totalCostUsd = 0;
  let fallbackCount = 0;
  let cacheHits = 0;
  for (const record of records) {
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    byProvider[record.provider] = (byProvider[record.provider] ?? 0) + 1;
    totalCostUsd += record.estimatedCostUsd ?? 0;
    if (record.isFallback) fallbackCount += 1;
    if (record.cacheHit || record.status === "cache_hit") cacheHits += 1;
  }
  return {
    recordCount: records.length,
    byStatus,
    byProvider,
    fallbackCount,
    cacheHits,
    estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
    recentWindowDays: 90,
  };
}
