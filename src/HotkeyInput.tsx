import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Allow recording an empty value (clearing). Used by the capture hotkey. */
  allowEmpty?: boolean;
  placeholder?: string;
}

/** Map a KeyboardEvent.code to the main-key token the Rust parser accepts,
 *  or null if it's a modifier / unsupported key. */
function mainKeyFromCode(code: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^Numpad(\d)$/))) return m[1];
  if ((m = code.match(/^F([1-9]|1[0-2])$/))) return `F${m[1]}`;
  switch (code) {
    case "Space":
      return "Space";
    case "Enter":
    case "NumpadEnter":
      return "Enter";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    default:
      return null;
  }
}

/** Modifier tokens currently held, in a stable display order. */
function modifiers(e: React.KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");
  return mods;
}

/**
 * Click to focus, then press a key combination to record it. Global shortcuts
 * are suspended while recording so the current hotkey doesn't fire as you press
 * it, and restored on blur.
 */
export function HotkeyInput({ value, onChange, allowEmpty, placeholder }: Props) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState("");
  const [hint, setHint] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  function startRecording() {
    setRecording(true);
    setPreview("");
    setHint("");
    invoke("suspend_shortcuts").catch(() => {});
  }

  function stopRecording() {
    setRecording(false);
    setPreview("");
    setHint("");
    // Restore whatever shortcuts are currently saved/active.
    invoke("reload_shortcuts").catch(() => {});
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!recording) return;
    // Swallow everything so the modal's Esc-to-close and text entry don't fire.
    e.preventDefault();
    e.stopPropagation();

    if (e.code === "Escape") {
      // Cancel: keep the existing value.
      inputRef.current?.blur();
      return;
    }
    if (e.code === "Backspace" && allowEmpty && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      // Bare Backspace clears an optional hotkey.
      onChange("");
      inputRef.current?.blur();
      return;
    }

    const mods = modifiers(e);
    const main = mainKeyFromCode(e.code);

    if (!main) {
      // Only modifiers held so far — show them and wait for the main key.
      setPreview(mods.length ? `${mods.join("+")}+…` : "按下主键…");
      setHint("");
      return;
    }

    const isFunctionKey = /^F([1-9]|1[0-2])$/.test(main);
    if (mods.length === 0 && !isFunctionKey) {
      // A bare letter/digit would register globally — require a modifier.
      setPreview(main);
      setHint("请配合 Ctrl / Alt / Shift / Win 使用（功能键 F1–F12 可单独使用）");
      return;
    }

    const combo = [...mods, main].join("+");
    onChange(combo);
    inputRef.current?.blur();
  }

  const display = recording ? preview || "按下快捷键…" : value || "";

  return (
    <div className="hotkey-input">
      <input
        ref={inputRef}
        type="text"
        className={`hotkey-field${recording ? " recording" : ""}`}
        value={display}
        placeholder={placeholder}
        onFocus={startRecording}
        onBlur={stopRecording}
        onKeyDown={handleKeyDown}
        readOnly
        spellCheck={false}
        aria-label="录制快捷键"
      />
      {!recording && value && allowEmpty && (
        <button
          type="button"
          className="hotkey-clear"
          onClick={() => onChange("")}
          title="清除"
          aria-label="清除快捷键"
        >
          ×
        </button>
      )}
      {recording ? (
        <span className="hint">{hint || "正在录制…按 Esc 取消"}</span>
      ) : null}
    </div>
  );
}
