import type { ProviderName } from "./providers/types";
import type { AppSettings, OcrMode } from "./store";
import {
  NativeProviderError,
  runNativeTextTranslation,
  runNativeVisionRecognition,
  runNativeVisionTranslation,
  testNativeProvider,
} from "./nativeTranslation";
import { getCachedTranslation, setCachedTranslation } from "./translationCache";
import {
  addUsage,
  createUsageGroupId,
  estimateCostUsd,
  estimateTokens,
  type UsageEntryKind,
  type UsageStatus,
} from "./usage";
import { logDiagnosticEvent } from "./diagnostics";
import { redactSensitive } from "./sanitize";

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

interface RuntimeOptions {
  settings: AppSettings;
  entryKind: UsageEntryKind;
  ocrMode?: OcrMode;
}

const MAX_TEXT_CHARS = 50_000;

export async function runTextTranslation(
  text: string,
  fromLang: string,
  toLang: string,
  options: RuntimeOptions & { onChunk?: (delta: string, full: string) => void },
): Promise<TranslationRunResult> {
  if (text.length > MAX_TEXT_CHARS) throw new Error("翻译文本超过 50,000 字符限制。");
  const groupId = createUsageGroupId();
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
        attempts: [],
        fromLang: direction.fromLang,
        toLang: direction.toLang,
        cacheHit: true,
      };
    }
  }

  try {
    const result = await runNativeTextTranslation({
      text,
      fromLang: direction.fromLang,
      toLang: direction.toLang,
      settings: options.settings,
      entryKind: options.entryKind,
      onChunk: options.onChunk,
    });
    const output = result.text ?? "";
    await recordAttempts({
      attempts: result.attempts,
      groupId,
      entryKind: options.entryKind,
      settings: options.settings,
      requestedFromLang: fromLang,
      requestedToLang: toLang,
      resolvedFromLang: direction.fromLang,
      resolvedToLang: direction.toLang,
      ocrMode: options.ocrMode,
      inputChars: text.length,
      outputChars: output.length,
    });
    if (options.settings.translationCacheEnabled) {
      await setCachedTranslation({
        text,
        fromLang: direction.fromLang,
        toLang: direction.toLang,
        translation: output,
      }).catch(() => {});
    }
    return {
      text: output,
      provider: result.provider,
      model: result.model,
      usedFallback: result.usedFallback,
      attempts: result.attempts,
      fromLang: direction.fromLang,
      toLang: direction.toLang,
      cacheHit: false,
    };
  } catch (error) {
    const attempts = error instanceof NativeProviderError ? error.attempts : [];
    await recordAttempts({
      attempts,
      groupId,
      entryKind: options.entryKind,
      settings: options.settings,
      requestedFromLang: fromLang,
      requestedToLang: toLang,
      resolvedFromLang: direction.fromLang,
      resolvedToLang: direction.toLang,
      ocrMode: options.ocrMode,
      inputChars: text.length,
      outputChars: 0,
    });
    if (options.settings.diagnosticLoggingEnabled) {
      await logDiagnosticEvent({
        level: "error",
        category: "provider",
        message: "文本翻译 Provider 请求失败",
        provider: attempts[attempts.length - 1]?.provider,
        model: attempts[attempts.length - 1]?.model,
        errorKind: error instanceof NativeProviderError ? error.kind : "unknown",
        errorSummary: safeErrorMessage(error),
      });
    }
    throw new Error(safeErrorMessage(error));
  }
}

export async function runImageTranslation(
  imageDataUrl: string,
  fromLang: string,
  toLang: string,
  options: RuntimeOptions,
): Promise<ImageTranslationRunResult> {
  const groupId = createUsageGroupId();
  const direction = resolveLanguageDirection("", fromLang, toLang, options.settings);
  try {
    const result = await runNativeVisionTranslation({
      imageDataUrl,
      fromLang: direction.fromLang,
      toLang: direction.toLang,
      settings: options.settings,
      entryKind: options.entryKind,
    });
    const original = result.original ?? "";
    const translation = result.translation ?? "";
    await recordAttempts({
      attempts: result.attempts,
      groupId,
      entryKind: options.entryKind,
      settings: options.settings,
      requestedFromLang: fromLang,
      requestedToLang: toLang,
      resolvedFromLang: direction.fromLang,
      resolvedToLang: direction.toLang,
      ocrMode: options.ocrMode,
      inputChars: 0,
      outputChars: original.length + translation.length,
    });
    return {
      original,
      translation,
      provider: result.provider,
      model: result.model,
      usedFallback: result.usedFallback,
      attempts: result.attempts,
      fromLang: direction.fromLang,
      toLang: direction.toLang,
      cacheHit: false,
    };
  } catch (error) {
    const attempts = error instanceof NativeProviderError ? error.attempts : [];
    await recordAttempts({
      attempts,
      groupId,
      entryKind: options.entryKind,
      settings: options.settings,
      requestedFromLang: fromLang,
      requestedToLang: toLang,
      resolvedFromLang: direction.fromLang,
      resolvedToLang: direction.toLang,
      ocrMode: options.ocrMode,
      inputChars: 0,
      outputChars: 0,
    });
    throw new Error(safeErrorMessage(error));
  }
}

export async function runImageRecognition(
  imageDataUrl: string,
  fromLang: string,
  options: RuntimeOptions,
): Promise<string> {
  const groupId = createUsageGroupId();
  try {
    const result = await runNativeVisionRecognition({
      imageDataUrl,
      fromLang,
      settings: options.settings,
      entryKind: options.entryKind,
    });
    const text = result.text ?? "";
    await recordAttempts({
      attempts: result.attempts,
      groupId,
      entryKind: options.entryKind,
      settings: options.settings,
      requestedFromLang: fromLang,
      requestedToLang: options.settings.toLang,
      resolvedFromLang: fromLang,
      resolvedToLang: options.settings.toLang,
      ocrMode: options.ocrMode,
      inputChars: 0,
      outputChars: text.length,
    });
    return text;
  } catch (error) {
    const attempts = error instanceof NativeProviderError ? error.attempts : [];
    await recordAttempts({
      attempts,
      groupId,
      entryKind: options.entryKind,
      settings: options.settings,
      requestedFromLang: fromLang,
      requestedToLang: options.settings.toLang,
      resolvedFromLang: fromLang,
      resolvedToLang: options.settings.toLang,
      ocrMode: options.ocrMode,
      inputChars: 0,
      outputChars: 0,
    });
    throw new Error(safeErrorMessage(error));
  }
}

export async function testProviderConnection(input: {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  settings: AppSettings;
  fromLang?: string;
  toLang?: string;
}): Promise<ProviderAttempt> {
  return testNativeProvider(input);
}

async function recordAttempts(input: {
  attempts: ProviderAttempt[];
  groupId: string;
  entryKind: UsageEntryKind;
  settings: AppSettings;
  requestedFromLang: string;
  requestedToLang: string;
  resolvedFromLang: string;
  resolvedToLang: string;
  ocrMode?: OcrMode;
  inputChars: number;
  outputChars: number;
}): Promise<void> {
  await Promise.all(
    input.attempts.map((attempt) =>
      addUsage({
        fallbackGroupId: input.groupId,
        entryKind: input.entryKind,
        provider: attempt.provider,
        model: attempt.model,
        fromLang: input.requestedFromLang,
        toLang: input.requestedToLang,
        resolvedFromLang: input.resolvedFromLang,
        resolvedToLang: input.resolvedToLang,
        cacheHit: false,
        ocrMode: input.ocrMode,
        status: attempt.status,
        errorKind: attempt.errorKind,
        errorSummary: sanitizeErrorSummary(attempt.errorSummary),
        durationMs: attempt.durationMs,
        isFallback: attempt.isFallback,
        inputChars: attempt.status === "success" ? input.inputChars : input.inputChars,
        outputChars: attempt.status === "success" ? input.outputChars : 0,
        estimatedInputTokens: estimateTokens(input.inputChars),
        estimatedOutputTokens: estimateTokens(attempt.status === "success" ? input.outputChars : 0),
        estimatedCostUsd: estimateCostUsd(
          attempt.model,
          estimateTokens(input.inputChars),
          estimateTokens(attempt.status === "success" ? input.outputChars : 0),
        ),
      }).catch(() => {}),
    ),
  );
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
    estimatedInputTokens: estimateTokens(input.inputChars),
    estimatedOutputTokens: estimateTokens(input.outputChars),
    estimatedCostUsd: 0,
  }).catch(() => {});
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof NativeProviderError) return error.message;
  return "Provider 请求失败，请稍后重试。";
}

function sanitizeErrorSummary(value?: string): string | undefined {
  return value ? redactSensitive(value, 240) : undefined;
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
  return a.startsWith("zh") && b.startsWith("zh");
}
