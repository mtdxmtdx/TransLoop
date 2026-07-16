import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  buildTranslateSystemPrompt,
  buildTranslateUserMessage,
  buildVisionRecognizeSystemPrompt,
  buildVisionTranslateSystemPrompt,
  type ProviderName,
} from "./providers/types";
import type { AppSettings } from "./store";
import type { ProviderAttempt, ProviderErrorKind } from "./translationRuntime";

export type NativeOperation = "text" | "vision_translate" | "vision_recognize" | "test";

interface NativeEvent {
  requestId: string;
  phase: "chunk" | "complete" | "error";
  delta?: string;
  text?: string;
  original?: string;
  translation?: string;
  provider?: ProviderName;
  model?: string;
  usedFallback?: boolean;
  attempts?: ProviderAttempt[];
  errorKind?: ProviderErrorKind;
  errorStatus?: number;
  errorSummary?: string;
}

export interface NativeTranslationResult {
  text?: string;
  original?: string;
  translation?: string;
  provider: ProviderName;
  model: string;
  usedFallback: boolean;
  attempts: ProviderAttempt[];
}

export class NativeProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly attempts: ProviderAttempt[];

  constructor(event: NativeEvent) {
    super(event.errorSummary || "Provider 请求失败。");
    this.name = "NativeProviderError";
    this.kind = event.errorKind ?? "unknown";
    this.status = event.errorStatus;
    this.attempts = event.attempts ?? [];
  }
}

interface NativeRequestInput {
  operation: NativeOperation;
  provider: ProviderName;
  baseUrl: string;
  model: string;
  settings: AppSettings;
  systemPrompt: string;
  userPrompt?: string;
  imageDataUrl?: string;
  onChunk?: (delta: string, full: string) => void;
}

export async function runNativeTranslation(
  input: NativeRequestInput,
): Promise<NativeTranslationResult> {
  const requestId = createRequestId();
  const request = {
    requestId,
    operation: input.operation,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    fallbackEnabled: input.operation === "text" ? input.settings.fallbackEnabled : false,
    fallbackModels: input.operation === "text" ? input.settings.fallbackModels : [],
    fallbackProviderOrder:
      input.operation === "text" ? input.settings.fallbackProviderOrder : [],
    providerConfigs: input.settings.providerConfigs,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    imageDataUrl: input.imageDataUrl,
  };

  let full = "";
  let finished = false;
  let resolveResult!: (value: NativeTranslationResult) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<NativeTranslationResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const unlisten = await listen<NativeEvent>("translation://event", (event) => {
    const payload = event.payload;
    if (payload.requestId !== requestId || finished) return;
    if (payload.phase === "chunk") {
      const delta = payload.delta ?? "";
      full += delta;
      input.onChunk?.(delta, full);
      return;
    }
    finished = true;
    if (payload.phase === "error") {
      rejectResult(new NativeProviderError(payload));
      return;
    }
    resolveResult({
      text: payload.text,
      original: payload.original,
      translation: payload.translation,
      provider: payload.provider ?? input.provider,
      model: payload.model ?? input.model,
      usedFallback: Boolean(payload.usedFallback),
      attempts: payload.attempts ?? [],
    });
  });

  try {
    await invoke("start_translation", { request });
    return await result;
  } finally {
    unlisten();
  }
}

export async function cancelNativeTranslation(requestId: string): Promise<void> {
  await invoke("cancel_translation", { requestId });
}

export async function runNativeTextTranslation(input: {
  text: string;
  fromLang: string;
  toLang: string;
  settings: AppSettings;
  entryKind: string;
  onChunk?: (delta: string, full: string) => void;
}): Promise<NativeTranslationResult> {
  return runNativeTranslation({
    operation: "text",
    provider: input.settings.provider,
    baseUrl: input.settings.baseUrl,
    model: input.settings.model,
    settings: input.settings,
    systemPrompt: buildTranslateSystemPrompt(input.fromLang, input.toLang),
    userPrompt: buildTranslateUserMessage(input.text),
    onChunk: input.onChunk,
  });
}

export async function runNativeVisionTranslation(input: {
  imageDataUrl: string;
  fromLang: string;
  toLang: string;
  settings: AppSettings;
  entryKind: string;
}): Promise<NativeTranslationResult> {
  return runNativeTranslation({
    operation: "vision_translate",
    provider: input.settings.provider,
    baseUrl: input.settings.baseUrl,
    model: input.settings.model,
    settings: input.settings,
    systemPrompt: buildVisionTranslateSystemPrompt(input.fromLang, input.toLang),
    userPrompt: "Extract and translate the text in this image.",
    imageDataUrl: input.imageDataUrl,
  });
}

export async function runNativeVisionRecognition(input: {
  imageDataUrl: string;
  fromLang: string;
  settings: AppSettings;
  entryKind: string;
}): Promise<NativeTranslationResult> {
  return runNativeTranslation({
    operation: "vision_recognize",
    provider: input.settings.recognizeProvider,
    baseUrl: input.settings.recognizeBaseUrl,
    model: input.settings.recognizeModel,
    settings: input.settings,
    systemPrompt: buildVisionRecognizeSystemPrompt(input.fromLang),
    userPrompt: "Transcribe the text in this image.",
    imageDataUrl: input.imageDataUrl,
  });
}

export async function testNativeProvider(input: {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  settings: AppSettings;
  fromLang?: string;
  toLang?: string;
}): Promise<ProviderAttempt> {
  try {
    const result = await runNativeTranslation({
      operation: "test",
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      settings: { ...input.settings, fallbackEnabled: false },
      systemPrompt: buildTranslateSystemPrompt(input.fromLang ?? "en", input.toLang ?? "zh"),
      userPrompt: buildTranslateUserMessage("Hello"),
    });
    return result.attempts[result.attempts.length - 1] ?? {
      provider: input.provider,
      model: input.model,
      status: "error",
      durationMs: 0,
      isFallback: false,
      errorKind: "unknown",
      errorSummary: "连接测试没有返回结果。",
    };
  } catch (error) {
    if (error instanceof NativeProviderError && error.attempts.length > 0) {
      return error.attempts[error.attempts.length - 1];
    }
    return {
      provider: input.provider,
      model: input.model,
      status: "error",
      durationMs: 0,
      isFallback: false,
      errorKind: error instanceof NativeProviderError ? error.kind : "unknown",
      errorSummary: error instanceof Error ? error.message : "连接测试失败。",
    };
  }
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export {
  buildVisionRecognizeSystemPrompt,
  buildVisionTranslateSystemPrompt,
};
