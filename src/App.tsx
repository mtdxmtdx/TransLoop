import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type AppSettings,
} from "./store";
import { createProvider } from "./providers";
import { SettingsModal } from "./SettingsModal";

const LANG_OPTIONS = [
  { value: "auto", label: "自动检测" },
  { value: "zh", label: "中文（简体）" },
  { value: "zh-TW", label: "中文（繁体）" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
  { value: "fr", label: "法文" },
  { value: "de", label: "德文" },
  { value: "es", label: "西班牙文" },
  { value: "ru", label: "俄文" },
];

const TARGET_LANGS = LANG_OPTIONS.filter((o) => o.value !== "auto");
const DEBOUNCE_MS = 600;

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; text: string }
  | { kind: "error"; message: string };

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const debounceRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    loadSettings()
      .then((s) => {
        setSettings(s);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const provider = useMemo(() => {
    return createProvider(settings.provider, {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
  }, [settings.provider, settings.apiKey, settings.baseUrl, settings.model]);

  async function runTranslate(text: string, s: AppSettings) {
    const seq = ++requestSeqRef.current;
    setPhase({ kind: "loading" });
    try {
      const onChunk = s.streamOutput
        ? (_delta: string, full: string) => {
            if (requestSeqRef.current !== seq) return;
            setPhase({ kind: "ok", text: full });
          }
        : undefined;
      const out = await provider.translate(text, s.fromLang, s.toLang, onChunk);
      if (requestSeqRef.current !== seq) return;
      setPhase({ kind: "ok", text: out });
    } catch (e) {
      if (requestSeqRef.current !== seq) return;
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  useEffect(() => {
    if (!loaded) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);

    const trimmed = input.trim();
    if (!trimmed) {
      requestSeqRef.current++; // cancel any in-flight
      setPhase({ kind: "idle" });
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      runTranslate(trimmed, settings);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, settings.fromLang, settings.toLang, settings.streamOutput, provider, loaded]);

  function handleSwap() {
    if (settings.fromLang === "auto") return;
    const next: AppSettings = {
      ...settings,
      fromLang: settings.toLang,
      toLang: settings.fromLang,
    };
    setSettings(next);
    saveSettings(next).catch(() => {});
    if (phase.kind === "ok") {
      setInput(phase.text);
    }
  }

  function handleLangChange(
    key: "fromLang" | "toLang",
    value: string,
  ) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next).catch(() => {});
  }

  function handleClear() {
    setInput("");
    setPhase({ kind: "idle" });
  }

  async function handleCopy() {
    if (phase.kind !== "ok") return;
    try {
      await navigator.clipboard.writeText(phase.text);
    } catch {
      /* ignore */
    }
  }

  function renderOutput() {
    switch (phase.kind) {
      case "idle":
        return <span className="placeholder">译文会出现在这里…</span>;
      case "loading":
        return (
          <span className="placeholder">
            翻译中
            <span className="loading-dot" />
            <span className="loading-dot" />
            <span className="loading-dot" />
          </span>
        );
      case "ok":
        return <span>{phase.text}</span>;
      case "error":
        return <span className="error-text">{phase.message}</span>;
    }
  }

  if (!loaded) {
    return (
      <div className="translator">
        <div className="panes">
          <div className="pane">
            <div className="pane-body placeholder">加载中…</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="translator">
      <header className="toolbar">
        <select
          className="lang-select"
          value={settings.fromLang}
          onChange={(e) => handleLangChange("fromLang", e.target.value)}
          aria-label="源语言"
        >
          {LANG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <button
          className="icon-btn swap"
          onClick={handleSwap}
          disabled={settings.fromLang === "auto"}
          title="交换语言"
          aria-label="交换语言"
        >
          ⇄
        </button>

        <select
          className="lang-select"
          value={settings.toLang}
          onChange={(e) => handleLangChange("toLang", e.target.value)}
          aria-label="目标语言"
        >
          {TARGET_LANGS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <div className="spacer" />

        <button
          className="icon-btn"
          onClick={() => setShowSettings(true)}
          title="设置"
          aria-label="设置"
        >
          ⚙
        </button>
      </header>

      <main className="panes">
        <section className="pane">
          <div className="pane-header">
            <span>原文</span>
            <div className="pane-actions">
              <span className="char-count">{input.length}</span>
              {input && (
                <button className="text-btn" onClick={handleClear}>
                  清空
                </button>
              )}
            </div>
          </div>
          <textarea
            className="pane-body input"
            placeholder="在此粘贴或输入要翻译的文字…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </section>

        <section className="pane">
          <div className="pane-header">
            <span>译文</span>
            <div className="pane-actions">
              {phase.kind === "ok" && (
                <button className="text-btn" onClick={handleCopy}>
                  复制
                </button>
              )}
            </div>
          </div>
          <div className="pane-body output">{renderOutput()}</div>
        </section>
      </main>

      <footer className="statusbar">
        <span>
          提示：在任意应用选中文字后按 <kbd>{settings.hotkey}</kbd> 唤起划词翻译；
          点击右上角 × 后窗口会隐藏到系统托盘，可由托盘图标重新唤出。
        </span>
      </footer>

      <SettingsModal
        open={showSettings}
        initial={settings}
        onClose={() => setShowSettings(false)}
        onSaved={(next) => {
          setSettings(next);
        }}
      />
    </div>
  );
}
