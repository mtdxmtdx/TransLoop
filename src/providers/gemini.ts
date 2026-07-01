import { fetch } from "@tauri-apps/plugin-http";
import type {
  ProviderConfig,
  StreamHandler,
  TranslationProvider,
  VisionResult,
} from "./types";
import {
  buildTranslateSystemPrompt,
  buildTranslateUserMessage,
  buildVisionRecognizeSystemPrompt,
  buildVisionTranslateSystemPrompt,
} from "./types";
import { parseVisionContent } from "./openai-compat";
import { consumeSSE, splitDataUrl } from "./sse";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function textOf(json: GeminiResponse): string {
  return (
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? ""
  );
}

/**
 * Google Gemini (generateContent). Uses a top-level `systemInstruction`, a
 * `contents` array of parts, the API key as a `?key=` query param, and SSE via
 * `:streamGenerateContent?alt=sse`. Vision uses an `inlineData` part.
 */
export function createGeminiProvider(cfg: ProviderConfig): TranslationProvider {
  const baseUrl = (
    cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/$/, "");
  const model = cfg.model || "gemini-2.0-flash";

  function requireKey(): string {
    if (!cfg.apiKey) {
      throw new Error("Gemini API Key 未配置，请到设置中填写。");
    }
    return cfg.apiKey;
  }

  function url(method: string, query = ""): string {
    const sep = query ? `&${query}` : "";
    return `${baseUrl}/models/${model}:${method}?key=${encodeURIComponent(requireKey())}${sep}`;
  }

  async function fail(res: Response): Promise<never> {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini 请求失败 (${res.status}): ${detail.slice(0, 200)}`);
  }

  return {
    name: "gemini",
    supportVision: true,

    async translate(text, from, to, onChunk?: StreamHandler) {
      const body = {
        systemInstruction: {
          parts: [{ text: buildTranslateSystemPrompt(from, to) }],
        },
        contents: [{ role: "user", parts: [{ text: buildTranslateUserMessage(text) }] }],
        generationConfig: { temperature: 0.3 },
      };
      const res = await fetch(url("streamGenerateContent", "alt=sse"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) await fail(res);
      if (!res.body) throw new Error("Gemini 返回为空（无响应体）");

      let full = "";
      await consumeSSE(res.body, (payload) => {
        let json: GeminiResponse;
        try {
          json = JSON.parse(payload);
        } catch {
          return;
        }
        const delta = textOf(json);
        if (delta) {
          full += delta;
          onChunk?.(delta, full);
        }
      });
      const out = full.trim();
      if (!out) throw new Error("Gemini 返回为空");
      return out;
    },

    async translateImage(imageDataUrl, from, to): Promise<VisionResult> {
      const { mediaType, base64 } = splitDataUrl(imageDataUrl);
      const body = {
        systemInstruction: {
          parts: [{ text: buildVisionTranslateSystemPrompt(from, to) }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: "Extract and translate the text in this image." },
              { inlineData: { mimeType: mediaType, data: base64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      };
      const res = await fetch(url("generateContent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) await fail(res);
      const json = (await res.json()) as GeminiResponse;
      return parseVisionContent(textOf(json));
    },

    async recognizeImage(imageDataUrl, from): Promise<string> {
      const { mediaType, base64 } = splitDataUrl(imageDataUrl);
      const body = {
        systemInstruction: {
          parts: [{ text: buildVisionRecognizeSystemPrompt(from) }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: "Transcribe the text in this image." },
              { inlineData: { mimeType: mediaType, data: base64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      };
      const res = await fetch(url("generateContent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) await fail(res);
      const json = (await res.json()) as GeminiResponse;
      return textOf(json).trim();
    },
  };
}
