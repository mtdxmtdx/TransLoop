export interface TranslateResult {
  text: string;
  detectedSourceLang?: string;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/** 流式输出回调：每收到一段增量文本触发一次，delta 为本次增量，full 为已累积的完整译文。 */
export type StreamHandler = (delta: string, full: string) => void;

export interface TranslationProvider {
  name: string;
  supportVision: boolean;
  translate(
    text: string,
    from: string,
    to: string,
    onChunk?: StreamHandler,
  ): Promise<string>;
  translateImage?(base64: string, prompt: string): Promise<TranslateResult>;
}

export type ProviderName =
  | "deepseek"
  | "openai"
  | "claude"
  | "gemini"
  | "qwen"
  | "grok"
  | "minimax";

export interface ProviderMeta {
  id: ProviderName;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  supportVision: boolean;
  implemented: boolean;
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    supportVision: false,
    implemented: true,
  },
  {
    id: "openai",
    label: "OpenAI (GPT-4o)",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    supportVision: true,
    implemented: false,
  },
  {
    id: "claude",
    label: "Anthropic Claude",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    supportVision: true,
    implemented: false,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.0-flash",
    supportVision: true,
    implemented: false,
  },
  {
    id: "qwen",
    label: "Qwen / Qwen-VL",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    supportVision: true,
    implemented: false,
  },
  {
    id: "grok",
    label: "xAI Grok",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-2-latest",
    supportVision: true,
    implemented: false,
  },
  {
    id: "minimax",
    label: "MiniMax",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    defaultModel: "abab6.5s-chat",
    supportVision: false,
    implemented: false,
  },
];
