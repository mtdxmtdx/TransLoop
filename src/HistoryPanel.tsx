import { useEffect, useMemo, useState } from "react";
import {
  clearHistory,
  deleteHistory,
  listHistory,
  type TranslationHistoryRecord,
} from "./history";

interface Props {
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  selection: "划词",
  capture: "截图",
};

export function HistoryPanel({ open, onClose }: Props) {
  const [records, setRecords] = useState<TranslationHistoryRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listHistory().then((items) => {
      if (cancelled) return;
      setRecords(items);
      setSelectedId((current) => current || items[0]?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return records;
    return records.filter((record) =>
      [
        record.original,
        record.translation,
        record.provider,
        record.model,
        KIND_LABEL[record.kind],
      ]
        .join("\n")
        .toLowerCase()
        .includes(key),
    );
  }, [query, records]);

  const selected =
    filtered.find((record) => record.id === selectedId) ?? filtered[0] ?? null;

  async function handleDelete(id: string) {
    await deleteHistory(id);
    const next = records.filter((record) => record.id !== id);
    setRecords(next);
    setSelectedId(next[0]?.id || "");
  }

  async function handleClear() {
    await clearHistory();
    setRecords([]);
    setSelectedId("");
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="history-panel" onClick={(e) => e.stopPropagation()}>
        <header className="history-header">
          <div>
            <h2>翻译历史</h2>
            <p>{records.length} 条记录</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭 (Esc)">
            ×
          </button>
        </header>

        <div className="history-tools">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索原文、译文、模型…"
            spellCheck={false}
          />
          <button className="ghost" onClick={handleClear} disabled={records.length === 0}>
            清空全部
          </button>
        </div>

        <div className="history-content">
          <aside className="history-list">
            {filtered.length === 0 && (
              <div className="history-empty">暂无匹配记录</div>
            )}
            {filtered.map((record) => (
              <button
                key={record.id}
                className={`history-item ${selected?.id === record.id ? "active" : ""}`}
                onClick={() => setSelectedId(record.id)}
              >
                <span className="history-item-top">
                  <span>{KIND_LABEL[record.kind]}</span>
                  <time>{formatTime(record.createdAt)}</time>
                </span>
                <span className="history-item-text">{record.original}</span>
              </button>
            ))}
          </aside>

          <section className="history-detail">
            {selected ? (
              <>
                <div className="history-meta">
                  <span>{KIND_LABEL[selected.kind]}</span>
                  <span>
                    {selected.fromLang} → {selected.toLang}
                  </span>
                  <span>
                    {selected.provider} / {selected.model}
                  </span>
                  {selected.ocrMode && <span>OCR {selected.ocrMode}</span>}
                </div>

                {selected.imagePreview && (
                  <img
                    className="history-preview"
                    src={selected.imagePreview}
                    alt="截图缩略图"
                  />
                )}

                <div className="history-section">
                  <div className="history-section-title">
                    <span>原文</span>
                    <button className="text-btn" onClick={() => copyText(selected.original)}>
                      复制原文
                    </button>
                  </div>
                  <pre>{selected.original}</pre>
                </div>

                <div className="history-section">
                  <div className="history-section-title">
                    <span>译文</span>
                    <button
                      className="text-btn"
                      onClick={() => copyText(selected.translation)}
                    >
                      复制译文
                    </button>
                  </div>
                  <pre>{selected.translation}</pre>
                </div>

                <div className="history-footer">
                  <time>{formatFullTime(selected.createdAt)}</time>
                  <button className="text-btn danger" onClick={() => handleDelete(selected.id)}>
                    删除记录
                  </button>
                </div>
              </>
            ) : (
              <div className="history-empty">还没有翻译历史</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFullTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}
