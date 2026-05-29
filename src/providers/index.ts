import type { ProviderConfig, ProviderName, TranslationProvider } from "./types";
import { PROVIDER_REGISTRY } from "./types";
import { createDeepSeekProvider } from "./deepseek";
import { createOpenAICompatProvider } from "./openai-compat";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";

/** Look up registry metadata for default base URL / model / vision support. */
function meta(name: ProviderName) {
  const m = PROVIDER_REGISTRY.find((p) => p.id === name);
  if (!m) throw new Error(`Unknown provider: ${name}`);
  return m;
}

export function createProvider(
  name: ProviderName,
  config: ProviderConfig,
): TranslationProvider {
  switch (name) {
    case "deepseek":
      return createDeepSeekProvider(config);
    case "openai":
    case "qwen":
    case "grok": {
      const m = meta(name);
      return createOpenAICompatProvider(config, {
        name,
        defaultBaseUrl: m.defaultBaseUrl,
        defaultModel: m.defaultModel,
        supportVision: m.supportVision,
      });
    }
    case "minimax": {
      // MiniMax speaks the OpenAI dialect but on a different path.
      const m = meta(name);
      return createOpenAICompatProvider(config, {
        name,
        defaultBaseUrl: m.defaultBaseUrl,
        defaultModel: m.defaultModel,
        supportVision: m.supportVision,
        chatPath: "/text/chatcompletion_v2",
      });
    }
    case "claude":
      return createClaudeProvider(config);
    case "gemini":
      return createGeminiProvider(config);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}

export * from "./types";
