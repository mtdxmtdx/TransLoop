export interface TranslateResult {
  text: string;
  detectedSourceLang?: string;
}

/** OCR 模式 A 的结果：多模态模型一步返回识别原文 + 译文。 */
export interface VisionResult {
  /** 模型从图片中识别出的原文（可能为空，取决于模型）。 */
  original: string;
  /** 译文。 */
  translation: string;
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
  /**
   * OCR 模式 A：把整张图片交给多模态模型，一步完成识别 + 翻译。
   * `imageDataUrl` 形如 `data:image/png;base64,...`。
   */
  translateImage?(
    imageDataUrl: string,
    from: string,
    to: string,
  ): Promise<VisionResult>;
  /**
   * 多模型协作：仅用多模态模型识别图片中的文字（不翻译），返回纯文本原文。
   * 之后由另一个模型的 `translate()` 完成翻译。
   */
  recognizeImage?(imageDataUrl: string, from: string): Promise<string>;
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
    implemented: true,
  },
  {
    id: "claude",
    label: "Anthropic Claude",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    supportVision: true,
    implemented: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.0-flash",
    supportVision: true,
    implemented: true,
  },
  {
    id: "qwen",
    label: "Qwen3-VL (Flash)",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-vl-flash",
    supportVision: true,
    implemented: true,
  },
  {
    id: "grok",
    label: "xAI Grok",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-2-vision-latest",
    supportVision: true,
    implemented: true,
  },
  {
    id: "minimax",
    label: "MiniMax",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    defaultModel: "abab6.5s-chat",
    supportVision: false,
    implemented: true,
  },
];
