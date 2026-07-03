import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "./store";
import { createProvider } from "./providers";
import { normalizeRecognizedText } from "./providers/openai-compat";
import { addHistory } from "./history";
import { runImageTranslation, runTextTranslation } from "./translationRuntime";
import { logDiagnosticEvent } from "./diagnostics";

interface CropPayload {
  dataUrl: string;
}

interface OcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OcrLine {
  text: string;
  words: OcrWord[];
}

interface OcrResult {
  text: string;
  lines: OcrLine[];
}

type ViewState =
  | { kind: "idle" }
  | { kind: "running"; stage: string }
  | { kind: "result"; original: string; translation: string }
  | { kind: "error"; message: string };

/** Map our language codes to Windows OCR BCP-47 tags (mode B). */
const OCR_LANG_TAG: Record<string, string> = {
  zh: "zh-Hans",
  "zh-TW": "zh-Hant",
  en: "en",
  ja: "ja",
  ko: "ko",
  fr: "fr",
  de: "de",
  es: "es",
  ru: "ru",
};

const OCR_MODE_LABEL: Record<string, string> = {
  A: "多模态 OCR",
  B: "Windows OCR",
  C: "Tesseract OCR",
};

const TARGET_LANG_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "zh-TW", label: "繁中" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
  { value: "fr", label: "法文" },
  { value: "de", label: "德文" },
  { value: "es", label: "西语" },
  { value: "ru", label: "俄文" },
];

export function CaptureView() {
  const [crop, setCrop] = useState<string>("");
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const [targetLang, setTargetLang] = useState("zh");
  const runSeq = useRef(0);

  async function translateRecognizedText(
    text: string,
    settings: Awaited<ReturnType<typeof loadSettings>>,
    seq: number,
    imagePreview?: string,
    targetOverride?: string,
  ) {
    const effectiveSettings = targetOverride
      ? { ...settings, toLang: targetOverride, smartDirectionEnabled: false }
      : settings;
    setTargetLang(effectiveSettings.toLang);
    setState({ kind: "running", stage: "翻译中…" });
    const result = await runTextTranslation(
      text,
      effectiveSettings.fromLang,
      effectiveSettings.toLang,
      {
        settings: effectiveSettings,
        entryKind: "capture",
        ocrMode: effectiveSettings.ocrMode,
        onChunk: (_d, full) => {
          if (runSeq.current !== seq) return;
          setState({ kind: "result", original: text, translation: full });
        },
      },
    );
    if (runSeq.current !== seq) return;
    const translation = result.text;
    setState({ kind: "result", original: text, translation });
    addHistory({
      kind: "capture",
      original: text,
      translation,
      fromLang: result.fromLang,
      toLang: result.toLang,
      provider: result.provider,
      model: result.model,
      ocrMode: effectiveSettings.ocrMode,
      imagePreview,
    }).catch(() => {});
  }

  async function run(dataUrl: string) {
    const seq = ++runSeq.current;
    setCrop(dataUrl);
    setState({ kind: "running", stage: "识别中…" });
    try {
      const settings = await loadSettings();
      setTargetLang(settings.toLang);
      const imagePreview = await makeImagePreview(dataUrl);
      if (settings.ocrMode === "A") {
        if (settings.visionCollab) {
          // 多模型协作：识别模型 OCR → 翻译提供方翻译。
          const recognizer = createProvider(settings.recognizeProvider, {
            apiKey: settings.recognizeApiKey,
            baseUrl: settings.recognizeBaseUrl,
            model: settings.recognizeModel,
          });
          if (!recognizer.recognizeImage) {
            throw new Error(
              "识别模型不支持图片输入。请在设置中将「识别模型」改为 OpenAI / Qwen-VL / Grok。",
            );
          }
          const recognized = normalizeRecognizedText(
            await recognizer.recognizeImage(dataUrl, settings.fromLang),
          );
          if (runSeq.current !== seq) return;
          if (!recognized) {
            setState({
              kind: "error",
              message: "识别模型未返回文字。可尝试框选更清晰的区域。",
            });
            return;
          }
          await translateRecognizedText(recognized, settings, seq, imagePreview);
        } else {
          // 单模型：一步识别 + 翻译。
          if (false) {
            throw new Error(
              "当前提供方不支持图片输入。请在设置中改用 OpenAI / Qwen-VL / Grok，或切换到 OCR 模式 B。",
            );
          }
          const res = await runImageTranslation(
            dataUrl,
            settings.fromLang,
            settings.toLang,
            {
              settings,
              entryKind: "capture",
              ocrMode: settings.ocrMode,
            },
          );
          if (runSeq.current !== seq) return;
          setState({
            kind: "result",
            original: res.original,
            translation: res.translation,
          });
          addHistory({
            kind: "capture",
            original: res.original,
            translation: res.translation,
            fromLang: res.fromLang,
            toLang: res.toLang,
            provider: res.provider,
            model: res.model,
            ocrMode: settings.ocrMode,
            imagePreview,
          }).catch(() => {});
        }
      } else {
        // Mode B/C: local OCR → normalize recognised text → translate.
        const tag =
          settings.fromLang === "auto"
            ? undefined
            : OCR_LANG_TAG[settings.fromLang];
        const command = settings.ocrMode === "C" ? "ocr_tesseract" : "ocr_windows";
        const rawOcr = await invoke<OcrResult>(command, {
          image: dataUrl,
          lang: tag ?? null,
        });
        const recognized = postProcessOcr(rawOcr).trim();
        if (runSeq.current !== seq) return;
        if (!recognized) {
          setState({
            kind: "error",
            message: `未识别到文字。当前为 ${OCR_MODE_LABEL[settings.ocrMode]}，可尝试框选更清晰的区域，或切换其他 OCR 模式。`,
          });
          return;
        }
        setState({ kind: "running", stage: "整理并翻译中…" });
        await translateRecognizedText(recognized, settings, seq, imagePreview);
      }
    } catch (e) {
      if (runSeq.current !== seq) return;
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<CropPayload>("capture://crop", (event) => {
      run(event.payload.dataUrl);
    }).then((fn) => {
      unlisten = fn;
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") invoke("hide_capture").catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleClose() {
    invoke("hide_capture").catch(() => {});
  }

  function handleHeaderPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".close-btn")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }

  async function copyTranslation() {
    if (state.kind !== "result") return;
    await copyText(state.translation);
  }

  async function copyOriginal() {
    if (state.kind !== "result") return;
    await copyText(state.original);
  }

  async function retranslateOriginal() {
    if (state.kind !== "result") return;
    const original = state.original.trim();
    if (!original) return;
    const seq = ++runSeq.current;
    try {
      const settings = await loadSettings();
      const imagePreview = crop ? await makeImagePreview(crop) : undefined;
      await translateRecognizedText(original, settings, seq, imagePreview, targetLang);
    } catch (e) {
      if (runSeq.current !== seq) return;
      const message = e instanceof Error ? e.message : String(e);
      const settings = await loadSettings().catch(() => null);
      if (settings?.diagnosticLoggingEnabled) {
        logDiagnosticEvent({
          level: "error",
          category: "ocr",
          message: "截图翻译失败",
          errorSummary: message,
        });
      }
      setState({
        kind: "error",
        message,
      });
    }
  }

  function updateOriginal(next: string) {
    if (state.kind !== "result") return;
    setState({ ...state, original: next });
  }

  async function handleTargetLangChange(next: string) {
    setTargetLang(next);
    if (state.kind !== "result") return;
    const original = state.original.trim();
    if (!original) return;
    const seq = ++runSeq.current;
    try {
      const settings = await loadSettings();
      const imagePreview = crop ? await makeImagePreview(crop) : undefined;
      await translateRecognizedText(original, settings, seq, imagePreview, next);
    } catch (e) {
      if (runSeq.current !== seq) return;
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="capture-win">
      <div className="header" onPointerDown={handleHeaderPointerDown}>
        <span className="brand">TransLoop · 截图翻译</span>
        <button
          className="close-btn"
          onClick={handleClose}
          title="关闭 (Esc)"
          aria-label="关闭"
        >
          ×
        </button>
      </div>

      {crop && (
        <div className="capture-thumb">
          <img src={crop} alt="截图" />
        </div>
      )}

      <div className="capture-panes">
        <section className="capture-pane">
          <div className="capture-pane-title">
            <span>原文</span>
            {state.kind === "result" && (
              <div className="capture-actions">
                <button className="text-btn" onClick={copyOriginal}>
                  复制原文
                </button>
                <button
                  className="text-btn"
                  onClick={retranslateOriginal}
                  disabled={!state.original.trim()}
                  title="使用当前编辑后的原文重新翻译"
                >
                  重新翻译
                </button>
              </div>
            )}
          </div>
          <div className="capture-pane-body">
            {state.kind === "result" ? (
              state.original ? (
                <textarea
                  className="capture-editor"
                  value={state.original}
                  onChange={(e) => updateOriginal(e.target.value)}
                  spellCheck={false}
                  title="可编辑原文，修改后点击重新翻译"
                />
              ) : (
                <span className="muted">（模型未单独返回原文）</span>
              )
            ) : state.kind === "running" ? (
              <span className="muted">{state.stage}</span>
            ) : (
              <span className="muted">等待截图…</span>
            )}
          </div>
        </section>
        <section className="capture-pane">
          <div className="capture-pane-title">
            <span>译文</span>
            {state.kind === "result" && (
              <div className="capture-actions">
                <select
                  className="popup-lang-select capture-lang-select"
                  value={targetLang}
                  onChange={(e) => handleTargetLangChange(e.target.value)}
                  title="目标语言"
                >
                  {TARGET_LANG_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button className="text-btn" onClick={copyTranslation}>
                  复制译文
                </button>
              </div>
            )}
          </div>
          <div className="capture-pane-body">
            {state.kind === "result" && state.translation}
            {state.kind === "running" && (
              <span className="muted">
                {state.stage}
                <span className="loading-dot" />
                <span className="loading-dot" />
                <span className="loading-dot" />
              </span>
            )}
            {state.kind === "error" && (
              <span className="error-text">{state.message}</span>
            )}
            {state.kind === "idle" && <span className="muted">译文会出现在这里…</span>}
          </div>
        </section>
      </div>
    </div>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

function postProcessOcr(result: OcrResult): string {
  const lines = normalizeOcrLines(result);
  if (lines.length === 0) return "";

  const structured = rebuildParagraphs(lines);
  return normalizeListMarkers(structured).trim();
}

function normalizeOcrLines(result: OcrResult): OcrLine[] {
  const source =
    result.lines?.length > 0
      ? result.lines
      : result.text
          .split(/\r?\n/)
          .map((text) => ({ text, words: [] }));

  return source
    .map((line) => ({
      ...line,
      text: normalizeOcrText(line.text),
    }))
    .filter((line) => line.text.length > 0);
}

function normalizeOcrText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?，。；：！？、])/g, "$1")
    .trim();
}

function rebuildParagraphs(lines: OcrLine[]): string {
  const out: string[] = [];
  let previous: OcrLine | undefined;

  for (const line of lines) {
    if (previous && shouldInsertParagraphBreak(previous, line)) {
      out.push("");
    }
    out.push(line.text);
    previous = line;
  }

  return mergeSoftWrappedLines(out).join("\n");
}

function shouldInsertParagraphBreak(previous: OcrLine, current: OcrLine): boolean {
  const prevBox = lineBox(previous);
  const currBox = lineBox(current);
  if (!prevBox || !currBox) return false;

  const gap = currBox.y - (prevBox.y + prevBox.height);
  const typicalHeight = Math.max(prevBox.height, currBox.height, 1);
  return gap > typicalHeight * 0.8;
}

function lineBox(line: OcrLine): { x: number; y: number; width: number; height: number } | null {
  if (!line.words || line.words.length === 0) return null;
  const left = Math.min(...line.words.map((word) => word.x));
  const top = Math.min(...line.words.map((word) => word.y));
  const right = Math.max(...line.words.map((word) => word.x + word.width));
  const bottom = Math.max(...line.words.map((word) => word.y + word.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function mergeSoftWrappedLines(lines: string[]): string[] {
  const merged: string[] = [];

  for (const line of lines) {
    if (line === "") {
      if (merged[merged.length - 1] !== "") merged.push("");
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous && shouldMergeLine(previous, line)) {
      merged[merged.length - 1] = `${previous} ${line}`;
    } else {
      merged.push(line);
    }
  }

  return merged;
}

function shouldMergeLine(previous: string, current: string): boolean {
  if (isListLike(previous) || isListLike(current)) return false;
  if (/[。！？.!?;；:：]$/.test(previous)) return false;
  if (/[-–—]$/.test(previous)) return true;
  return previous.length >= 18 && current.length >= 8;
}

function isListLike(line: string): boolean {
  return /^([\-*•]|\d+[.)、]|[（(]?\d+[）)]|[a-zA-Z][.)])\s+/.test(line);
}

function normalizeListMarkers(text: string): string {
  return text.replace(/^([•·])\s*/gm, "- ");
}

async function makeImagePreview(dataUrl: string): Promise<string | undefined> {
  if (!dataUrl) return undefined;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 240;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(undefined);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => resolve(undefined);
    img.src = dataUrl;
  });
}
