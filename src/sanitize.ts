/** Shared redaction for anything that can be persisted, displayed as an
 * error, or included in a diagnostic export.  This is not used on translation
 * content itself; it is used only for metadata and error text. */
export function redactSensitive(value: string, maxLength = 300): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/\b(authorization|proxy-authorization|x-api-key|x-goog-api-key)\s*:\s*[^\s,;]+/gi, "$1: ***")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "secret=***")
    .replace(/[?&](key|token|secret|password|api[_-]?key)=[^&#\s]+/gi, "?$1=***")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-***")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza***")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "gh***")
    .replace(/[A-Za-z]:\\[^\s)]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function safeDiagnosticText(value: unknown, maxLength = 240): string | undefined {
  if (value === undefined || value === null) return undefined;
  return redactSensitive(String(value), maxLength);
}
