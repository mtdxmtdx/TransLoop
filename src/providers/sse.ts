/**
 * Generic Server-Sent-Events line reader. Calls `onData` with each `data:`
 * payload string (one per SSE event line), letting the caller parse whatever
 * JSON shape its provider uses. `[DONE]` sentinels are skipped.
 *
 * OpenAI-compatible providers have their own copy in openai-compat.ts that
 * accumulates `choices[].delta.content`; this one is for the differently shaped
 * Anthropic / Gemini streams.
 */
export async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handle = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    onData(payload);
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
        handle(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer);
  } finally {
    reader.releaseLock();
  }
}

/** Split a `data:image/png;base64,XXXX` URL into media type + bare base64. */
export function splitDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) return { mediaType: m[1], base64: m[2] };
  // Fallback: assume PNG bare base64.
  return { mediaType: "image/png", base64: dataUrl.replace(/^data:[^,]*,/, "") };
}
