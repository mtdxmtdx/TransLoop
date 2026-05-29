import type { ProviderConfig, TranslationProvider } from "./types";

// Stage 3 will implement these (Claude messages API, Gemini generateContent,
// MiniMax chat). Until then they throw a clear error if selected.
function notImplemented(name: string): TranslationProvider["translate"] {
  return async () => {
    throw new Error(`${name} 适配器尚未实现，请暂时选择 DeepSeek 或 OpenAI 兼容的提供方。`);
  };
}

export function createClaudeProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "claude", supportVision: true, translate: notImplemented("Claude") };
}

export function createGeminiProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "gemini", supportVision: true, translate: notImplemented("Gemini") };
}

export function createMiniMaxProvider(_cfg: ProviderConfig): TranslationProvider {
  return { name: "minimax", supportVision: false, translate: notImplemented("MiniMax") };
}
