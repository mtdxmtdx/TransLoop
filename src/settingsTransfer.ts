import { APP_VERSION } from "./appInfo";
import { getDiagnosticSnapshot, listDiagnosticEvents, logDiagnosticEvent } from "./diagnostics";
import { createZip } from "./zip";
import { DEFAULT_SETTINGS, type AppSettings } from "./store";
import { PROVIDER_REGISTRY, type ProviderName } from "./providers/types";
import { listUsage, type UsageRecord } from "./usage";

export interface SettingsExportFile {
  schemaVersion: 1;
  appVersion: string;
  exportedAt: string;
  settings: SanitizedSettings;
}

type SanitizedSettings = Omit<AppSettings, "apiKey" | "recognizeApiKey"> & {
  apiKey?: "";
  recognizeApiKey?: "";
};

const PROVIDERS = new Set(PROVIDER_REGISTRY.map((item) => item.id));
const OCR_MODES = new Set(["A", "B", "C"]);
const LANGS = new Set(["auto", "zh", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru"]);

export function createSettingsExport(settings: AppSettings): SettingsExportFile {
  return {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: sanitizeSettings(settings),
  };
}

export function sanitizeSettings(settings: AppSettings): SanitizedSettings {
  const { apiKey: _apiKey, recognizeApiKey: _recognizeApiKey, ...rest } = settings;
  return {
    ...rest,
    apiKey: "",
    recognizeApiKey: "",
  };
}

export function parseImportedSettings(text: string): AppSettings {
  const parsed = JSON.parse(text) as Partial<SettingsExportFile> | Partial<AppSettings>;
  const source = "settings" in parsed ? parsed.settings : parsed;
  if (!source || typeof source !== "object") {
    throw new Error("导入文件格式不正确。");
  }
  return validateSettings(source as Partial<AppSettings>);
}

export async function createDiagnosticPackage(settings: AppSettings): Promise<Blob> {
  const [snapshot, diagnostics, usage] = await Promise.all([
    getDiagnosticSnapshot(),
    listDiagnosticEvents(),
    listUsage().catch(() => [] as UsageRecord[]),
  ]);
  const usageSummary = summarizeUsage(usage);
  const manifest = {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    privacy:
      "This package excludes API keys, source text, translations, screenshots, translation cache content, and history body content.",
  };
  await logDiagnosticEvent({
    level: "info",
    category: "diagnostics",
    message: "导出诊断包",
  });
  return createZip([
    { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    { name: "snapshot.json", content: JSON.stringify(snapshot, null, 2) },
    { name: "settings.redacted.json", content: JSON.stringify(sanitizeSettings(settings), null, 2) },
    { name: "diagnostics.json", content: JSON.stringify(diagnostics, null, 2) },
    { name: "usage-summary.json", content: JSON.stringify(usageSummary, null, 2) },
  ]);
}

function validateSettings(input: Partial<AppSettings>): AppSettings {
  const provider = validProvider(input.provider) ? input.provider : DEFAULT_SETTINGS.provider;
  const recognizeProvider = validProvider(input.recognizeProvider)
    ? input.recognizeProvider
    : DEFAULT_SETTINGS.recognizeProvider;
  const fallbackProviderOrder = Array.isArray(input.fallbackProviderOrder)
    ? input.fallbackProviderOrder.filter(validProvider)
    : DEFAULT_SETTINGS.fallbackProviderOrder;
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    provider,
    recognizeProvider,
    apiKey: "",
    recognizeApiKey: "",
    hotkey: validString(input.hotkey) ? input.hotkey! : DEFAULT_SETTINGS.hotkey,
    captureHotkey: typeof input.captureHotkey === "string"
      ? input.captureHotkey
      : DEFAULT_SETTINGS.captureHotkey,
    ocrMode: OCR_MODES.has(String(input.ocrMode))
      ? (input.ocrMode as AppSettings["ocrMode"])
      : DEFAULT_SETTINGS.ocrMode,
    fromLang: validLang(input.fromLang) ? input.fromLang! : DEFAULT_SETTINGS.fromLang,
    toLang: validTargetLang(input.toLang) ? input.toLang! : DEFAULT_SETTINGS.toLang,
    smartPrimaryTargetLang: validTargetLang(input.smartPrimaryTargetLang)
      ? input.smartPrimaryTargetLang!
      : DEFAULT_SETTINGS.smartPrimaryTargetLang,
    smartAlternateTargetLang: validTargetLang(input.smartAlternateTargetLang)
      ? input.smartAlternateTargetLang!
      : DEFAULT_SETTINGS.smartAlternateTargetLang,
    fallbackModels: Array.isArray(input.fallbackModels)
      ? input.fallbackModels.filter(validString)
      : DEFAULT_SETTINGS.fallbackModels,
    fallbackProviderOrder,
    providerConfigs: sanitizeProviderConfigs(input.providerConfigs),
    diagnosticLoggingEnabled:
      typeof input.diagnosticLoggingEnabled === "boolean"
        ? input.diagnosticLoggingEnabled
        : DEFAULT_SETTINGS.diagnosticLoggingEnabled,
  };
}

function sanitizeProviderConfigs(
  configs: AppSettings["providerConfigs"] | undefined,
): AppSettings["providerConfigs"] {
  if (!configs || typeof configs !== "object") return {};
  const out: AppSettings["providerConfigs"] = {};
  for (const [provider, config] of Object.entries(configs)) {
    if (!validProvider(provider) || !config) continue;
    out[provider] = {
      baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
      model: typeof config.model === "string" ? config.model : "",
    };
  }
  return out;
}

function validProvider(value: unknown): value is ProviderName {
  return typeof value === "string" && PROVIDERS.has(value as ProviderName);
}

function validLang(value: unknown): value is string {
  return typeof value === "string" && LANGS.has(value);
}

function validTargetLang(value: unknown): value is string {
  return validLang(value) && value !== "auto";
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
