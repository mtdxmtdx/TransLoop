import { createProvider } from "./providers";
import { PROVIDER_REGISTRY, type ProviderName, type VisionResult } from "./providers/types";
import type { AppSettings, OcrMode } from "./store";
import { getProviderKey } from "./store";
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
  const candidates = await buildTextCandidates(options.settings);
  let lastError: Error | undefined;

  for (const candidate of candidates) {
    if (!candidate.apiKey) {
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        fromLang,
        toLang,
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
        provider.translate(text, fromLang, toLang, (delta, full) => {
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
        fromLang,
        toLang,
        ocrMode: options.ocrMode,
        status: "success",
        durationMs,
        inputChars: text.length,
        outputChars: result.length,
      });
      attempts.push(attempt);
      return {
        text: result,
        provider: candidate.provider,
        model: candidate.model,
        usedFallback: candidate.isFallback,
        attempts,
      };
    } catch (e) {
      active = false;
      const durationMs = Math.round(performance.now() - started);
      const error = normalizeError(e);
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        fromLang,
        toLang,
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
        fromLang,
        toLang,
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
        provider.translateImage(imageDataUrl, fromLang, toLang),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const outputChars = result.original.length + result.translation.length;
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        fromLang,
        toLang,
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
      };
    } catch (e) {
      const error = normalizeError(e);
      const attempt = await recordAttempt({
        candidate,
        groupId,
        entryKind: options.entryKind,
        fromLang,
        toLang,
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
  fromLang: string;
  toLang: string;
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
    fromLang: input.fromLang,
    toLang: input.toLang,
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
  };
}

export type { VisionResult };
