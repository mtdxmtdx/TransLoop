import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "./store";
import { createProvider } from "./providers";

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

export function Popup() {
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const requestIdRef = useRef(0);
  // 原文区域高度（像素），可通过拖动中间分隔条调整
  const [sourceHeight, setSourceHeight] = useState(80);
  const contentRef = useRef<HTMLDivElement>(null);
  const dividerDragRef = useRef<{ startY: number; startH: number } | null>(null);

  async function runTranslate(payload: PopupPayload) {
    const id = payload.requestId;
    requestIdRef.current = id;
    setState({ kind: "loading", source: payload.text });
    try {
      const settings = await loadSettings();
      const provider = createProvider(settings.provider, {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
      });
      const translation = await provider.translate(
        payload.text,
        settings.fromLang,
        settings.toLang,
        (_delta, full) => {
          // 流式增量：仅当仍是当前请求时逐字更新结果
          if (requestIdRef.current !== id) return;
          setState({ kind: "result", source: payload.text, translation: full });
        },
      );
      if (requestIdRef.current !== id) return;
      setState({ kind: "result", source: payload.text, translation });
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
  }, []);

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
            <div className="source" style={{ height: sourceHeight }}>
              {state.source}
            </div>
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
            <div className="source" style={{ height: sourceHeight }}>
              {state.source}
            </div>
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
            <div className="source" style={{ height: sourceHeight }}>
              {state.source}
            </div>
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
