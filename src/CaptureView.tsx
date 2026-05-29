import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "./store";
import { createProvider } from "./providers";

interface CropPayload {
  dataUrl: string;
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

export function CaptureView() {
  const [crop, setCrop] = useState<string>("");
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const runSeq = useRef(0);

  async function run(dataUrl: string) {
    const seq = ++runSeq.current;
    setCrop(dataUrl);
    setState({ kind: "running", stage: "识别中…" });
    try {
      const settings = await loadSettings();
      const provider = createProvider(settings.provider, {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
      });

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
          const recognized = (
            await recognizer.recognizeImage(dataUrl, settings.fromLang)
          ).trim();
          if (runSeq.current !== seq) return;
          if (!recognized) {
            setState({
              kind: "error",
              message: "识别模型未返回文字。可尝试框选更清晰的区域。",
            });
            return;
          }
          setState({ kind: "running", stage: "翻译中…" });
          const translation = await provider.translate(
            recognized,
            settings.fromLang,
            settings.toLang,
            (_d, full) => {
              if (runSeq.current !== seq) return;
              setState({ kind: "result", original: recognized, translation: full });
            },
          );
          if (runSeq.current !== seq) return;
          setState({ kind: "result", original: recognized, translation });
        } else {
          // 单模型：一步识别 + 翻译。
          if (!provider.translateImage) {
            throw new Error(
              "当前提供方不支持图片输入。请在设置中改用 OpenAI / Qwen-VL / Grok，或切换到 OCR 模式 B。",
            );
          }
          const res = await provider.translateImage(
            dataUrl,
            settings.fromLang,
            settings.toLang,
          );
          if (runSeq.current !== seq) return;
          setState({
            kind: "result",
            original: res.original,
            translation: res.translation,
          });
        }
      } else {
        // Mode B: Windows OCR → translate the recognised text.
        const tag =
          settings.fromLang === "auto"
            ? undefined
            : OCR_LANG_TAG[settings.fromLang];
        const recognized = (await invoke<string>("ocr_windows", {
          image: dataUrl,
          lang: tag ?? null,
        })).trim();
        if (runSeq.current !== seq) return;
        if (!recognized) {
          setState({
            kind: "error",
            message: "未识别到文字。可尝试框选更清晰的区域，或切换到 OCR 模式 A。",
          });
          return;
        }
        setState({ kind: "running", stage: "翻译中…" });
        const translation = await provider.translate(
          recognized,
          settings.fromLang,
          settings.toLang,
          (_d, full) => {
            if (runSeq.current !== seq) return;
            setState({ kind: "result", original: recognized, translation: full });
          },
        );
        if (runSeq.current !== seq) return;
        setState({ kind: "result", original: recognized, translation });
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
    try {
      await navigator.clipboard.writeText(state.translation);
    } catch {
      /* ignore */
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
          <div className="capture-pane-title">原文</div>
          <div className="capture-pane-body">
            {state.kind === "result" ? (
              state.original ? (
                state.original
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
              <button className="text-btn" onClick={copyTranslation}>
                复制
              </button>
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
