import { createProvider } from "./providers";
import { PROVIDER_REGISTRY, type ProviderName, type VisionResult } from "./providers/types";
import type { AppSettings, OcrMode } from "./store";
import { getProviderKey } from "./store";
import { getCachedTranslation, setCachedTranslation } from "./translationCache";
import {
  addUsage,
  createUsageGroupId,
  estimateCostUsd,
  estimateTokens,
  type UsageEntryKind,
  type UsageStatus,
} from "./usage";

export type ProviderErrorKind =
  | "missing_key"
  | "unsupported"
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "empty_response"
  | "unknown";

export interface ProviderAttempt {
  provider: ProviderName;
  model: string;
  status: UsageStatus;
  durationMs: number;
  isFallback: boolean;
  errorKind?: ProviderErrorKind;
  errorSummary?: string;
}

export interface TranslationRunResult {
  text: string;
  provider: ProviderName;
  model: string;
  usedFallback: boolean;
  attempts: ProviderAttempt[];
  fromLang: string;
  toLang: string;
  cacheHit: boolean;
}

export interface ImageTranslationRunResult extends Omit<TranslationRunResult, "text"> {
  original: string;
  translation: string;
}

interface RuntimeCandidate {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  apiKey: string;
  isFallback: boolean;
}

interface RuntimeOptions {
  settings: AppSettings;
  entryKind: UsageEntryKind;
  ocrMode?: OcrMode;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECTIVITY_TEXT = "Hello";

export async function runTextTranslation(
  text: string,
  fromLang: string,
  toLang: string,
  options: RuntimeOptions & {
    onChunk?: (delta: string, full: string) => void;
  },
): Promise<TranslationRunResult> {
  const groupId = createUsageGroupId();
  const attempts: ProviderAttempt[] = [];
  const direction = resolveLanguageDirection(text, fromLang, toLang, options.settings);

  if (options.settings.translationCacheEnabled) {
    const cached = await getCachedTranslation(text, direction.fromLang, direction.toLang);
    if (cached) {
      await recordCacheHit({
        settings: options.settings,
        groupId,
        entryKind: options.entryKind,
        requestedFromLang: fromLang,
        requestedToLang: toLang,
        resolvedFromLang: direction.fromLang,
        resolvedToLang: direction.toLang,
        ocrMode: options.ocrMode,
        inputChars: text.length,
        outputChars: cached.translation.length,
      });
      return {
        text: cached.translation,
        provider: options.settings.provider,
        model: options.settings.model,
        usedFallback: false,
        attempts,
        fromLang: direction.fromLang,
        toLang: direction.toLang,
        cacheHit: true,
      };
    }
  }

  const candidates = await buildTextCandidates(options.settings);
  let lastError: Error | undefined;

  for (const candidate of candidates) {
    if (!candidate.apiKey) {
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        requestedFromLang: fromLang,
        requestedToLang: toLang,
        resolvedFromLang: direction.fromLang,
        resolvedToLang: direction.toLang,
        ocrMode: options.ocrMode,
        status: "skipped",
        durationMs: 0,
        inputChars: text.length,
        outputChars: 0,
        errorKind: "missing_key",
        errorSummary: "API Key 未配置，已跳过该候选。",
      });
      attempts.push(attempt);
      lastError = new Error(attempt.errorSummary);
      continue;
    }

    let active = true;
    const started = performance.now();
    try {
      const provider = createProvider(candidate.provider, {
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
      });
      const result = await withTimeout(
        provider.translate(text, direction.fromLang, direction.toLang, (delta, full) => {
          if (active) options.onChunk?.(delta, full);
        }),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        () => {
          active = false;
        },
      );
      active = false;
      const durationMs = Math.round(performance.now() - started);
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        requestedFromLang: fromLang,
        requestedToLang: toLang,
        resolvedFromLang: direction.fromLang,
        resolvedToLang: direction.toLang,
        ocrMode: options.ocrMode,
        status: "success",
        durationMs,
        inputChars: text.length,
        outputChars: result.length,
      });
      attempts.push(attempt);
      if (options.settings.translationCacheEnabled) {
        await setCachedTranslation({
          text,
          fromLang: direction.fromLang,
          toLang: direction.toLang,
          translation: result,
        }).catch(() => {});
      }
      return {
        text: result,
        provider: candidate.provider,
        model: candidate.model,
        usedFallback: candidate.isFallback,
        attempts,
        fromLang: direction.fromLang,
        toLang: direction.toLang,
        cacheHit: false,
      };
    } catch (e) {
      active = false;
      const durationMs = Math.round(performance.now() - started);
      const error = normalizeError(e);
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        requestedFromLang: fromLang,
        requestedToLang: toLang,
        resolvedFromLang: direction.fromLang,
        resolvedToLang: direction.toLang,
        ocrMode: options.ocrMode,
        status: "error",
        durationMs,
        inputChars: text.length,
        outputChars: 0,
        errorKind: error.kind,
        errorSummary: error.summary,
      });
      attempts.push(attempt);
      lastError = new Error(`${candidate.provider}/${candidate.model}: ${error.summary}`);
    }
  }

  throw new Error(lastError?.message ?? "没有可用的 Provider 候选。");
}

export async function runImageTranslation(
  imageDataUrl: string,
  fromLang: string,
  toLang: string,
  options: RuntimeOptions,
): Promise<ImageTranslationRunResult> {
  const groupId = createUsageGroupId();
  const attempts: ProviderAttempt[] = [];
  const direction = resolveLanguageDirection("", fromLang, toLang, options.settings);
  const candidates = await buildTextCandidates(options.settings);
  let lastError: Error | undefined;

  for (const candidate of candidates) {
    const meta = PROVIDER_REGISTRY.find((p) => p.id === candidate.provider);
    if (!candidate.apiKey || !meta?.supportVision) {
      const errorKind: ProviderErrorKind = !candidate.apiKey ? "missing_key" : "unsupported";
      const errorSummary = !candidate.apiKey
        ? "API Key 未配置，已跳过该候选。"
        : "该 Provider 不支持图片输入，已跳过该候选。";
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        requestedFromLang: fromLang,
        requestedToLang: toLang,
        resolvedFromLang: direction.fromLang,
        resolvedToLang: direction.toLang,
        ocrMode: options.ocrMode,
        status: "skipped",
        durationMs: 0,
        inputChars: 0,
        outputChars: 0,
        errorKind,
        errorSummary,
      });
      attempts.push(attempt);
      lastError = new Error(errorSummary);
      continue;
    }

    const started = performance.now();
    try {
      const provider = createProvider(candidate.provider, {
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
      });
      if (!provider.translateImage) throw new Error("该 Provider 不支持图片输入。");
      const result = await withTimeout(
        provider.translateImage(imageDataUrl, direction.fromLang, direction.toLang),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const outputChars = result.original.length + result.translation.length;
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        requestedFromLang: fromLang,
        requestedToLang: toLang,
        resolvedFromLang: direction.fromLang,
        resolvedToLang: direction.toLang,
        ocrMode: options.ocrMode,
        status: "success",
        durationMs: Math.round(performance.now() - started),
        inputChars: 0,
        outputChars,
      });
      attempts.push(attempt);
      return {
        original: result.original,
        translation: result.translation,
        provider: candidate.provider,
        model: candidate.model,
        usedFallback: candidate.isFallback,
        attempts,
        fromLang: direction.fromLang,
        toLang: direction.toLang,
        cacheHit: false,
      };
    } catch (e) {
      const error = normalizeError(e);
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        requestedFromLang: fromLang,
        requestedToLang: toLang,
        resolvedFromLang: direction.fromLang,
        resolvedToLang: direction.toLang,
        ocrMode: options.ocrMode,
        status: "error",
        durationMs: Math.round(performance.now() - started),
        inputChars: 0,
        outputChars: 0,
        errorKind: error.kind,
        errorSummary: error.summary,
      });
      attempts.push(attempt);
      lastError = new Error(`${candidate.provider}/${candidate.model}: ${error.summary}`);
    }
  }

  throw new Error(lastError?.message ?? "没有可用的图片 Provider 候选。");
}

export async function testProviderConnection(input: {
  provider: ProviderName;
  apiKey: string;
  baseUrl: string;
  model: string;
  fromLang?: string;
  toLang?: string;
}): Promise<ProviderAttempt> {
  const candidate: RuntimeCandidate = {
    provider: input.provider,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    model: input.model,
    isFallback: false,
  };
  const settings = {
    ...createMinimalSettings(candidate),
    fallbackEnabled: false,
  };
  try {
    const result = await runTextTranslation(
      CONNECTIVITY_TEXT,
      input.fromLang ?? "en",
      input.toLang ?? "zh",
      { settings, entryKind: "test", timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    return result.attempts[result.attempts.length - 1];
  } catch (e) {
    return {
      provider: input.provider,
      model: input.model,
      status: "error",
      durationMs: 0,
      isFallback: false,
      ...normalizeError(e),
      errorSummary: normalizeError(e).summary,
    };
  }
}

async function buildTextCandidates(settings: AppSettings): Promise<RuntimeCandidate[]> {
  const candidates: RuntimeCandidate[] = [];
  const add = (candidate: RuntimeCandidate) => {
    const key = `${candidate.provider}\n${candidate.baseUrl}\n${candidate.model}`;
    if (candidates.some((item) => `${item.provider}\n${item.baseUrl}\n${item.model}` === key)) {
      return;
    }
    candidates.push(candidate);
  };

  const primaryKey = settings.apiKey || (await getProviderKey(settings.provider));
  add({
    provider: settings.provider,
    apiKey: primaryKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    isFallback: false,
  });

  if (!settings.fallbackEnabled) return candidates;

  for (const model of settings.fallbackModels.map((item) => item.trim()).filter(Boolean)) {
    add({
      provider: settings.provider,
      apiKey: primaryKey,
      baseUrl: settings.baseUrl,
      model,
      isFallback: true,
    });
  }

  for (const providerName of settings.fallbackProviderOrder) {
    const meta = PROVIDER_REGISTRY.find((p) => p.id === providerName && p.implemented);
    if (!meta) continue;
    const config = settings.providerConfigs[providerName];
    add({
      provider: providerName,
      apiKey: await getProviderKey(providerName),
      baseUrl: config?.baseUrl || meta.defaultBaseUrl,
      model: config?.model || meta.defaultModel,
      isFallback: true,
    });
  }

  return candidates;
}

async function recordAttempt(input: {
  candidate: RuntimeCandidate;
  groupId: string;
  entryKind: UsageEntryKind;
  requestedFromLang: string;
  requestedToLang: string;
  resolvedFromLang: string;
  resolvedToLang: string;
  ocrMode?: OcrMode;
  status: UsageStatus;
  durationMs: number;
  inputChars: number;
  outputChars: number;
  errorKind?: ProviderErrorKind;
  errorSummary?: string;
}): Promise<ProviderAttempt> {
  const estimatedInputTokens = estimateTokens(input.inputChars);
  const estimatedOutputTokens = estimateTokens(input.outputChars);
  await addUsage({
    fallbackGroupId: input.groupId,
    entryKind: input.entryKind,
    provider: input.candidate.provider,
    model: input.candidate.model,
    fromLang: input.requestedFromLang,
    toLang: input.requestedToLang,
    resolvedFromLang: input.resolvedFromLang,
    resolvedToLang: input.resolvedToLang,
    cacheHit: false,
    ocrMode: input.ocrMode,
    status: input.status,
    errorKind: input.errorKind,
    errorSummary: input.errorSummary,
    durationMs: input.durationMs,
    isFallback: input.candidate.isFallback,
    inputChars: input.inputChars,
    outputChars: input.outputChars,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd: estimateCostUsd(
      input.candidate.model,
      estimatedInputTokens,
      estimatedOutputTokens,
    ),
  }).catch(() => {});
  return {
    provider: input.candidate.provider,
    model: input.candidate.model,
    status: input.status,
    durationMs: input.durationMs,
    isFallback: input.candidate.isFallback,
    errorKind: input.errorKind,
    errorSummary: input.errorSummary,
  };
}

async function recordCacheHit(input: {
  settings: AppSettings;
  groupId: string;
  entryKind: UsageEntryKind;
  requestedFromLang: string;
  requestedToLang: string;
  resolvedFromLang: string;
  resolvedToLang: string;
  ocrMode?: OcrMode;
  inputChars: number;
  outputChars: number;
}): Promise<void> {
  const estimatedInputTokens = estimateTokens(input.inputChars);
  const estimatedOutputTokens = estimateTokens(input.outputChars);
  await addUsage({
    fallbackGroupId: input.groupId,
    entryKind: input.entryKind,
    provider: input.settings.provider,
    model: input.settings.model,
    fromLang: input.requestedFromLang,
    toLang: input.requestedToLang,
    resolvedFromLang: input.resolvedFromLang,
    resolvedToLang: input.resolvedToLang,
    ocrMode: input.ocrMode,
    status: "cache_hit",
    cacheHit: true,
    durationMs: 0,
    isFallback: false,
    inputChars: input.inputChars,
    outputChars: input.outputChars,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd: 0,
  }).catch(() => {});
}

function normalizeError(e: unknown): { kind: ProviderErrorKind; summary: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const summary = raw.replace(/\s+/g, " ").trim().slice(0, 240) || "未知错误";
  const status = Number(summary.match(/\((\d{3})\)/)?.[1] ?? NaN);
  const lower = summary.toLowerCase();

  if (lower.includes("timeout") || summary.includes("超时")) {
    return { kind: "timeout", summary };
  }
  if (summary.includes("API Key") || summary.includes("未配置")) {
    return { kind: "missing_key", summary };
  }
  if (summary.includes("不支持") || lower.includes("unsupported")) {
    return { kind: "unsupported", summary };
  }
  if (status === 429 || lower.includes("rate limit")) {
    return { kind: "rate_limited", summary };
  }
  if (status >= 500) return { kind: "server_error", summary };
  if (status >= 400) return { kind: "client_error", summary };
  if (summary.includes("返回为空") || lower.includes("empty")) {
    return { kind: "empty_response", summary };
  }
  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("connection") ||
    summary.includes("套接字")
  ) {
    return { kind: "network", summary };
  }
  return { kind: "unknown", summary };
}

function resolveLanguageDirection(
  text: string,
  fromLang: string,
  toLang: string,
  settings: AppSettings,
): { fromLang: string; toLang: string } {
  if (!settings.smartDirectionEnabled || fromLang !== "auto") {
    return { fromLang, toLang };
  }
  const detected = detectSourceLanguage(text);
  const primary = settings.smartPrimaryTargetLang || toLang;
  const alternate = settings.smartAlternateTargetLang || toLang;
  return {
    fromLang: detected,
    toLang: sameLanguage(detected, primary) ? alternate : primary,
  };
}

function detectSourceLanguage(text: string): string {
  const sample = text.trim();
  if (!sample) return "auto";

  const counts = {
    zh: countMatches(sample, /[\u4e00-\u9fff]/g),
    ja: countMatches(sample, /[\u3040-\u30ff]/g),
    ko: countMatches(sample, /[\uac00-\ud7af]/g),
    ru: countMatches(sample, /[\u0400-\u04ff]/g),
    latin: countMatches(sample, /[A-Za-z]/g),
  };
  const letters = counts.zh + counts.ja + counts.ko + counts.ru + counts.latin;
  if (letters === 0) return "auto";
  if (counts.ja > 0) return "ja";
  if (counts.ko / letters > 0.3) return "ko";
  if (counts.ru / letters > 0.3) return "ru";
  if (counts.zh / letters > 0.2) return "zh";
  if (counts.latin / letters > 0.5) return "en";
  return "auto";
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function sameLanguage(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith("zh") && b.startsWith("zh")) return true;
  return false;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      onTimeout?.();
      reject(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

function createMinimalSettings(candidate: RuntimeCandidate): AppSettings {
  return {
    hotkey: "",
    captureHotkey: "",
    provider: candidate.provider,
    apiKey: candidate.apiKey,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    fromLang: "en",
    toLang: "zh",
    streamOutput: false,
    ocrMode: "A",
    visionCollab: false,
    recognizeProvider: candidate.provider,
    recognizeApiKey: candidate.apiKey,
    recognizeBaseUrl: candidate.baseUrl,
    recognizeModel: candidate.model,
    fallbackEnabled: false,
    fallbackModels: [],
    fallbackProviderOrder: [],
    providerConfigs: {},
    smartDirectionEnabled: false,
    smartPrimaryTargetLang: "zh",
    smartAlternateTargetLang: "en",
    translationCacheEnabled: false,
  };
}

export type { VisionResult };
