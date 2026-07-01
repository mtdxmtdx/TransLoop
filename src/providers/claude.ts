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

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

/**
 * Anthropic Claude (Messages API). Differs from OpenAI: separate top-level
 * `system`, `x-api-key` + `anthropic-version` headers, and an SSE stream of
 * `content_block_delta` events. Vision uses an `image` content block with
 * base64 source.
 */
export function createClaudeProvider(cfg: ProviderConfig): TranslationProvider {
  const baseUrl = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const model = cfg.model || "claude-sonnet-4-6";

  function headers(): Record<string, string> {
    if (!cfg.apiKey) {
      throw new Error("Claude API Key 未配置，请到设置中填写。");
    }
    return {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      // Allow calling the API directly from a non-browser webview context.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  async function post(body: unknown): Promise<Response> {
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Claude 请求失败 (${res.status}): ${detail.slice(0, 200)}`);
    }
    return res;
  }

  return {
    name: "claude",
    supportVision: true,

    async translate(text, from, to, onChunk?: StreamHandler) {
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: buildTranslateSystemPrompt(from, to),
        messages: [{ role: "user", content: buildTranslateUserMessage(text) }],
      };
      const res = await post(body);
      if (!res.body) throw new Error("Claude 返回为空（无响应体）");

      let full = "";
      await consumeSSE(res.body, (payload) => {
        let evt: {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        try {
          evt = JSON.parse(payload);
        } catch {
          return;
        }
        if (evt.type === "content_block_delta" && evt.delta?.text) {
          full += evt.delta.text;
          onChunk?.(evt.delta.text, full);
        }
      });
      const out = full.trim();
      if (!out) throw new Error("Claude 返回为空");
      return out;
    },

    async translateImage(imageDataUrl, from, to): Promise<VisionResult> {
      const { mediaType, base64 } = splitDataUrl(imageDataUrl);
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system: buildVisionTranslateSystemPrompt(from, to),
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: "Extract and translate the text in this image." },
            ],
          },
        ],
      };
      const res = await post(body);
      const json = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const content = json.content?.map((c) => c.text ?? "").join("") ?? "";
      return parseVisionContent(content);
    },

    async recognizeImage(imageDataUrl, from): Promise<string> {
      const { mediaType, base64 } = splitDataUrl(imageDataUrl);
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system: buildVisionRecognizeSystemPrompt(from),
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: "Transcribe the text in this image." },
            ],
          },
        ],
      };
      const res = await post(body);
      const json = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      return (json.content?.map((c) => c.text ?? "").join("") ?? "").trim();
    },
  };
}
