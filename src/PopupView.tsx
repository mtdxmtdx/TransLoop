import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "./store";
import { addHistory } from "./history";
import { runTextTranslation } from "./translationRuntime";

type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

type ViewState =
  | { kind: "idle" }
  | { kind: "loading"; source: string }
  | { kind: "result"; source: string; translation: string }
  | { kind: "error"; source: string; message: string };

interface PopupPayload {
  text: string;
  requestId: number;
}

const RESIZE_EDGES: Array<{ cls: string; dir: ResizeDirection }> = [
  { cls: "n", dir: "North" },
  { cls: "s", dir: "South" },
  { cls: "e", dir: "East" },
  { cls: "w", dir: "West" },
  { cls: "ne", dir: "NorthEast" },
  { cls: "nw", dir: "NorthWest" },
  { cls: "se", dir: "SouthEast" },
  { cls: "sw", dir: "SouthWest" },
];

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

export function Popup() {
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const [draftSource, setDraftSource] = useState("");
  const [targetLang, setTargetLang] = useState("zh");
  const [isPinned, setIsPinned] = useState(false);
  const requestIdRef = useRef(0);
  // 原文区域高度（像素），可通过拖动中间分隔条调整
  const [sourceHeight, setSourceHeight] = useState(80);
  const contentRef = useRef<HTMLDivElement>(null);
  const dividerDragRef = useRef<{ startY: number; startH: number } | null>(null);

  async function runTranslate(payload: PopupPayload, targetOverride?: string) {
    const id = payload.requestId;
    requestIdRef.current = id;
    setDraftSource(payload.text);
    setState({ kind: "loading", source: payload.text });
    try {
      const settings = await loadSettings();
      const effectiveSettings = targetOverride ? { ...settings, toLang: targetOverride } : settings;
      setTargetLang(effectiveSettings.toLang);
      const result = await runTextTranslation(
        payload.text,
        effectiveSettings.fromLang,
        effectiveSettings.toLang,
        {
          settings: effectiveSettings,
          entryKind: "selection",
          onChunk:
        (_delta, full) => {
          // 流式增量：仅当仍是当前请求时逐字更新结果
          if (requestIdRef.current !== id) return;
          setState({ kind: "result", source: payload.text, translation: full });
          },
        },
      );
      if (requestIdRef.current !== id) return;
      const translation = result.text;
      setState({ kind: "result", source: payload.text, translation });
      addHistory({
        kind: "selection",
        original: payload.text,
        translation,
        fromLang: result.fromLang,
        toLang: result.toLang,
        provider: result.provider,
        model: result.model,
      }).catch(() => {});
    } catch (e) {
      if (requestIdRef.current !== id) return;
      setState({
        kind: "error",
        source: payload.text,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<PopupPayload>("popup://text", (event) => {
      if (isPinned && state.kind !== "idle") return;
      runTranslate(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_popup").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [isPinned, state.kind]);

  function handleClose() {
    invoke("hide_popup").catch(() => {});
  }

  function handleHeaderPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".close-btn")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }

  function handleResizePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    dir: ResizeDirection,
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    getCurrentWindow().startResizeDragging(dir).catch(() => {});
  }

  // 拖动中间分隔条：向上拖增大原文区，向下拖缩小
  function handleDividerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dividerDragRef.current = { startY: e.clientY, startH: sourceHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleDividerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dividerDragRef.current;
    if (!drag) return;
    const delta = drag.startY - e.clientY; // 向上为正
    const contentH = contentRef.current?.clientHeight ?? 0;
    // 给译文区域留出至少 48px，原文区域最小 32px
    const maxH = Math.max(32, contentH - 48);
    const next = Math.min(maxH, Math.max(32, drag.startH + delta));
    setSourceHeight(next);
  }

  function handleDividerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    dividerDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }

  async function retranslateDraftSource() {
    if (state.kind === "idle") return;
    const text = draftSource.trim();
    if (!text) return;
    await runTranslate({
      text,
      requestId: requestIdRef.current + 1,
    }, targetLang);
  }

  async function handleTargetLangChange(next: string) {
    setTargetLang(next);
    if (state.kind === "idle") return;
    const text = draftSource.trim();
    if (!text) return;
    await runTranslate(
      {
        text,
        requestId: requestIdRef.current + 1,
      },
      next,
    );
  }

  const sourceText = state.kind === "idle" ? "" : draftSource;
  const translationText = state.kind === "result" ? state.translation : "";

  return (
    <div className="popup">
      <div className="header" onPointerDown={handleHeaderPointerDown}>
        <span className="brand">TransLoop</span>
        <button
          className="close-btn"
          onClick={handleClose}
          title="关闭 (Esc)"
          aria-label="关闭"
        >
          ×
        </button>
      </div>
      <div className="content" ref={contentRef}>
        {state.kind !== "idle" && (
          <div className="popup-actions">
            <button className="text-btn" onClick={() => setIsPinned((prev) => !prev)}>
              {isPinned ? "取消固定" : "固定"}
            </button>
            <select
              className="popup-lang-select"
              value={targetLang}
              onChange={(e) => handleTargetLangChange(e.target.value)}
              disabled={state.kind === "loading"}
              title="目标语言"
            >
              {TARGET_LANG_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className="text-btn" onClick={() => copyText(sourceText)}>
              复制原文
            </button>
            <button
              className="text-btn"
              onClick={retranslateDraftSource}
              disabled={!draftSource.trim() || state.kind === "loading"}
            >
              重新翻译
            </button>
            <button
              className="text-btn"
              onClick={() => copyText(translationText)}
              disabled={!translationText}
            >
              复制译文
            </button>
          </div>
        )}
        {state.kind === "idle" && (
          <div className="body" style={{ opacity: 0.6 }}>
            等待选中文字…
          </div>
        )}
        {state.kind === "loading" && (
          <>
            <div className="body">
              翻译中
              <span className="loading-dot" />
              <span className="loading-dot" />
              <span className="loading-dot" />
            </div>
            <div
              className="divider"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              title="拖动调整原文显示区域"
            />
            <textarea
              className="source source-editor"
              style={{ height: sourceHeight }}
              value={draftSource}
              onChange={(e) => setDraftSource(e.target.value)}
              spellCheck={false}
              title="可编辑原文，修改后点击重新翻译"
            />
          </>
        )}
        {state.kind === "result" && (
          <>
            <div className="body">{state.translation}</div>
            <div
              className="divider"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              title="拖动调整原文显示区域"
            />
            <textarea
              className="source source-editor"
              style={{ height: sourceHeight }}
              value={draftSource}
              onChange={(e) => setDraftSource(e.target.value)}
              spellCheck={false}
              title="可编辑原文，修改后点击重新翻译"
            />
          </>
        )}
        {state.kind === "error" && (
          <>
            <div className="body error">{state.message}</div>
            <div
              className="divider"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              title="拖动调整原文显示区域"
            />
            <textarea
              className="source source-editor"
              style={{ height: sourceHeight }}
              value={draftSource}
              onChange={(e) => setDraftSource(e.target.value)}
              spellCheck={false}
              title="可编辑原文，修改后点击重新翻译"
            />
          </>
        )}
      </div>
      {RESIZE_EDGES.map(({ cls, dir }) => (
        <div
          key={cls}
          className={`resize-handle ${cls}`}
          onPointerDown={(e) => handleResizePointerDown(e, dir)}
        />
      ))}
    </div>
  );
}
