import type { ProviderConfig, ProviderName, TranslationProvider } from "./types";
import { createDeepSeekProvider } from "./deepseek";
import {
  createClaudeProvider,
  createGeminiProvider,
  createGrokProvider,
  createMiniMaxProvider,
  createOpenAIProvider,
  createQwenProvider,
} from "./stubs";

export function createProvider(
  name: ProviderName,
  config: ProviderConfig,
): TranslationProvider {
  switch (name) {
    case "deepseek":
      return createDeepSeekProvider(config);
    case "openai":
      return createOpenAIProvider(config);
    case "claude":
      return createClaudeProvider(config);
    case "gemini":
      return createGeminiProvider(config);
    case "qwen":
      return createQwenProvider(config);
    case "grok":
      return createGrokProvider(config);
    case "minimax":
      return createMiniMaxProvider(config);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}

export * from "./types";
