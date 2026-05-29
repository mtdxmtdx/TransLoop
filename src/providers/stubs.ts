import type { ProviderConfig, TranslationProvider } from "./types";

function notImplemented(name: string): TranslationProvider["translate"] {
  return async () => {
    throw new Error(`${name} 适配器尚未在阶段 1 实现，请暂时选择 DeepSeek。`);
  };
}

export function createOpenAIProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "openai", supportVision: true, translate: notImplemented("OpenAI") };
}

export function createClaudeProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "claude", supportVision: true, translate: notImplemented("Claude") };
}

export function createGeminiProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "gemini", supportVision: true, translate: notImplemented("Gemini") };
}

export function createQwenProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "qwen", supportVision: true, translate: notImplemented("Qwen") };
}

export function createGrokProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "grok", supportVision: true, translate: notImplemented("Grok") };
}

export function createMiniMaxProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "minimax", supportVision: false, translate: notImplemented("MiniMax") };
}
