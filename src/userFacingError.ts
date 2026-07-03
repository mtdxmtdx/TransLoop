export type ErrorContext =
  | "translation"
  | "ocr"
  | "tesseract"
  | "provider_test"
  | "update"
  | "settings"
  | "diagnostics";

export function toUserFacingError(error: unknown, context: ErrorContext): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, " ").trim();
  const lower = message.toLowerCase();
  const status = Number(
    message.match(/\((\d{3})\)/)?.[1] ??
      message.match(/\b(?:http|status|code)\s*:?\s*(\d{3})\b/i)?.[1] ??
      NaN,
  );

  if (!message) return fallbackFor(context);
  if (message.includes("API Key") || message.includes("未配置") || lower.includes("api key")) {
    return "API Key 未配置或不可用。请在设置页为当前 Provider 填写 API Key 后重试。";
  }
  if (lower.includes("timeout") || message.includes("超时")) {
    return "请求超时。请检查网络连接、Provider 状态，或稍后重试。";
  }
  if (
    status === 429 ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    message.includes("限流")
  ) {
    return "Provider 返回限流。请稍后重试，或切换备用模型 / Provider。";
  }
  if (status >= 500) {
    return `Provider 服务端异常（${status}）。请稍后重试，或启用自动降级。`;
  }
  if (status >= 400) {
    return `Provider 请求被拒绝（${status}）。请检查 API Key、Base URL 和模型名是否正确。`;
  }
  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("connection") ||
    lower.includes("dns") ||
    lower.includes("failed to connect") ||
    message.includes("套接字") ||
    message.includes("网络")
  ) {
    return "网络连接失败。请确认当前网络可访问 Provider 或 GitHub Releases。";
  }
  if (message.includes("不支持图片") || lower.includes("unsupported")) {
    return "当前 Provider 或模型不支持图片输入。请改用支持视觉的模型，或切换到 OCR 模式 B/C。";
  }
  if (message.includes("未找到 Tesseract") || message.includes("启动 Tesseract 失败")) {
    return "未找到 Tesseract OCR。请先安装 Tesseract，并确认 tesseract 命令在 PATH 中。";
  }
  if (message.includes("Tesseract OCR 识别失败")) {
    return `Tesseract OCR 识别失败。请确认语言包已安装，或切换其他 OCR 模式。${appendRaw(message)}`;
  }
  if (message.includes("无可用的系统 OCR 语言包")) {
    return "Windows OCR 语言包不可用。请安装对应系统语言包，或切换到 OCR 模式 A/C。";
  }
  if (message.includes("未识别到文字") || message.includes("未返回文字")) {
    return message;
  }
  if (context === "update") {
    return `更新检查或下载失败。请稍后重试，或打开发布页手动下载。${appendRaw(message)}`;
  }
  if (context === "settings") {
    return `设置导入/导出失败。请确认文件格式正确后重试。${appendRaw(message)}`;
  }
  if (context === "diagnostics") {
    return `诊断包导出失败。请稍后重试。${appendRaw(message)}`;
  }
  return message.slice(0, 260);
}

function appendRaw(message: string): string {
  return message ? `（${message.slice(0, 160)}）` : "";
}

function fallbackFor(context: ErrorContext): string {
  if (context === "ocr" || context === "tesseract") return "OCR 处理失败，请重试或切换 OCR 模式。";
  if (context === "update") return "更新检查或下载失败，请稍后重试。";
  if (context === "provider_test") return "Provider 连接测试失败，请检查配置后重试。";
  return "操作失败，请稍后重试。";
}
