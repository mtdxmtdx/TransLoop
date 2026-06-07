import { fetch } from "@tauri-apps/plugin-http";
import type {
  ProviderConfig,
  StreamHandler,
  TranslationProvider,
  VisionResult,
} from "./types";
import {
  buildTranslateSystemPrompt,
  buildVisionRecognizeSystemPrompt,
  buildVisionTranslateSystemPrompt,
  describeLang,
} from "./types";

// 从 types 统一来源 re-export，保持 claude.ts / gemini.ts 现有导入路径不变。
export { describeLang };

interface CompatOptions {
  /** Provider id, e.g. "openai". */
  name: string;
  /** Fallback base URL when config omits one. */
  defaultBaseUrl: string;
  /** Fallback model when config omits one. */
  defaultModel: string;
  supportVision: boolean;
  /** Chat completions path. Defaults to "/chat/completions"; MiniMax v2 uses
   *  "/text/chatcompletion_v2". */
  chatPath?: string;
}

/**
 * Build a provider that speaks the OpenAI `/chat/completions` dialect.
 * Covers OpenAI, Qwen (compatible mode), Grok, MiniMax, and most中转代理.
 * - `translate`: streaming SSE, identical contract to the DeepSeek provider.
 * - `translateImage`: one-shot multimodal call (OCR mode A) that asks the model
 *   to return JSON `{ original, translation }`.
 */
export function createOpenAICompatProvider(
  cfg: ProviderConfig,
  opts: CompatOptions,
): TranslationProvider {
  const baseUrl = (cfg.baseUrl || opts.defaultBaseUrl).replace(/\/$/, "");
  const model = cfg.model || opts.defaultModel;
  const chatUrl = `${baseUrl}${opts.chatPath ?? "/chat/completions"}`;

  function authHeaders(accept: string): Record<string, string> {
    if (!cfg.apiKey) {
      throw new Error(`${opts.name} API Key 未配置，请到设置中填写。`);
    }
    return {
      "Content-Type": "application/json",
      Accept: accept,
      Authorization: `Bearer ${cfg.apiKey}`,
    };
  }

  const provider: TranslationProvider = {
    name: opts.name,
    supportVision: opts.supportVision,

    async translate(text, from, to, onChunk?: StreamHandler) {
      const body = {
        model,
        temperature: 0.3,
        stream: true,
        messages: [
          {
            role: "system",
            content: buildTranslateSystemPrompt(from, to),
          },
          { role: "user", content: text },
        ],
      };
      const res = await fetch(chatUrl, {
        method: "POST",
        headers: authHeaders("text/event-stream"),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `${opts.name} 请求失败 (${res.status}): ${detail.slice(0, 200)}`,
        );
      }
      if (!res.body) {
        throw new Error(`${opts.name} 返回为空（无响应体）`);
      }
      const full = await readSSE(res.body, onChunk);
      const out = full.trim();
      if (!out) throw new Error(`${opts.name} 返回为空`);
      return out;
    },
  };

  if (opts.supportVision) {
    provider.translateImage = async (
      imageDataUrl,
      from,
      to,
    ): Promise<VisionResult> => {
      const body = {
        model,
        temperature: 0.2,
        // Some compatible backends ignore this; parsing is defensive anyway.
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildVisionTranslateSystemPrompt(from, to),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract and translate the text in this image.",
              },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      };
      const res = await fetch(chatUrl, {
        method: "POST",
        headers: authHeaders("application/json"),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `${opts.name} 图片翻译失败 (${res.status}): ${detail.slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      return parseVisionContent(content);
    };

    // 多模型协作：仅识别原文（不翻译），交给另一个模型翻译。
    provider.recognizeImage = async (imageDataUrl, from): Promise<string> => {
      const body = {
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildVisionRecognizeSystemPrompt(from),
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe the text in this image." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      };
      const res = await fetch(chatUrl, {
        method: "POST",
        headers: authHeaders("application/json"),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `${opts.name} 图片识别失败 (${res.status}): ${detail.slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return (json.choices?.[0]?.message?.content ?? "").trim();
    };
  }

  return provider;
}

/** Read an OpenAI-style SSE stream, accumulating `choices[].delta.content`. */
export async function readSSE(
  body: ReadableStream<Uint8Array>,
  onChunk?: StreamHandler,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let parsed: { choices?: Array<{ delta?: { content?: string } }> };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = parsed.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      onChunk?.(delta, full);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        consume(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
  return full;
}

/** Parse the vision model's reply into {original, translation}, tolerant of
 *  markdown fences and non-JSON fallbacks. */
export function parseVisionContent(content: string): VisionResult {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as {
      original?: unknown;
      translation?: unknown;
    };
    const original = typeof obj.original === "string" ? obj.original : "";
    const translation =
      typeof obj.translation === "string" ? obj.translation : "";
    if (translation || original) {
      return { original, translation: translation || cleaned };
    }
  } catch {
    /* not JSON — fall through */
  }
  // Fallback: treat the whole reply as the translation.
  return { original: "", translation: cleaned };
}
