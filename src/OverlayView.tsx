import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface ImagePayload {
  dataUrl: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalize a drag (start → current) into a positive-size rect. */
function normalize(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

export function OverlayView() {
  const [src, setSrc] = useState<string>("");
  const [rect, setRect] = useState<Rect | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<ImagePayload>("capture://image", (event) => {
      setSrc(event.payload.dataUrl);
      setRect(null);
      dragStart.current = null;
      dragging.current = false;
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const cancel = useCallback(() => {
    invoke("cancel_capture").catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, [cancel]);

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragging.current = true;
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging.current || !dragStart.current) return;
    setRect(
      normalize(dragStart.current.x, dragStart.current.y, e.clientX, e.clientY),
    );
  }

  async function handlePointerUp() {
    if (!dragging.current) return;
    dragging.current = false;
    const r = rect;
    dragStart.current = null;
    if (!r || r.w < 4 || r.h < 4) {
      setRect(null);
      return; // treat as a stray click, keep overlay open
    }
    await cropAndFinish(r);
  }

  async function cropAndFinish(r: Rect) {
    const img = imgRef.current;
    if (!img) return cancel();

    // Map CSS-pixel selection to natural (physical) image pixels.
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const sx = Math.round(r.x * scaleX);
    const sy = Math.round(r.y * scaleY);
    const sw = Math.max(1, Math.round(r.w * scaleX));
    const sh = Math.max(1, Math.round(r.h * scaleY));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return cancel();
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/png");

    try {
      await invoke("finish_capture", { dataUrl });
    } catch {
      cancel();
    }
  }

  return (
    <div
      className="overlay-root"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {src && <img ref={imgRef} className="overlay-img" src={src} alt="" draggable={false} />}
      {!rect && <div className="overlay-dim" />}
      {rect && (
        <div
          className="overlay-selection"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <span className="overlay-dims">
            {Math.round(rect.w)} × {Math.round(rect.h)}
          </span>
        </div>
      )}
      {!rect && (
        <div className="overlay-hint">拖动框选要翻译的区域 · Esc 或右键取消</div>
      )}
    </div>
  );
}
