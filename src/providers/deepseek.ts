import { fetch } from "@tauri-apps/plugin-http";
import type { ProviderConfig, StreamHandler, TranslationProvider } from "./types";
import { buildTranslateSystemPrompt, buildTranslateUserMessage } from "./types";

export function createDeepSeekProvider(cfg: ProviderConfig): TranslationProvider {
  const baseUrl = (cfg.baseUrl || "https://api.deepseek.com").replace(/\/$/, "");
  const model = cfg.model || "deepseek-v4-flash";

  return {
    name: "deepseek",
    supportVision: false,
    async translate(text, from, to, onChunk?: StreamHandler) {
      if (!cfg.apiKey) {
        throw new Error("DeepSeek API Key 未配置，请到设置中填写。");
      }
      const body = {
        model,
        temperature: 0.3,
        stream: true,
        // 关闭思考模式：v4-flash 走非思考分支
        thinking: { type: "disabled" },
        messages: [
          {
            role: "system",
            content: buildTranslateSystemPrompt(from, to),
          },
          { role: "user", content: buildTranslateUserMessage(text) },
        ],
      };
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`DeepSeek 请求失败 (${res.status}): ${detail.slice(0, 200)}`);
      }
      if (!res.body) {
        throw new Error("DeepSeek 返回为空（无响应体）");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

      // 解析一行 SSE 数据，提取 content 增量（忽略 reasoning_content 思考内容）。
      const consume = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        let parsed: {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          return; // 不完整或非 JSON 行，跳过
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
          // SSE 以空行分隔事件；按换行切分，保留最后一段未完整的内容到下一轮
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            consume(line);
          }
        }
        // 处理结尾残留
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
      } finally {
        reader.releaseLock();
      }

      const out = full.trim();
      if (!out) {
        throw new Error("DeepSeek 返回为空");
      }
      return out;
    },
  };
}
