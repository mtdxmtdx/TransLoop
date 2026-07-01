import { useEffect, useMemo, useState } from "react";
import { clearUsage, listUsage, type UsageRecord } from "./usage";
import { PROVIDER_REGISTRY, type ProviderName } from "./providers/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

type StatusFilter = "all" | "success" | "error" | "skipped" | "cache_hit";
type EntryFilter = "all" | "main" | "selection" | "capture" | "test";

export function UsagePanel({ open, onClose }: Props) {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [days, setDays] = useState(7);
  const [provider, setProvider] = useState<ProviderName | "all">("all");
  const [entryKind, setEntryKind] = useState<EntryFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open]);

  const filtered = useMemo(() => {
    const minTime = Date.now() - days * 24 * 60 * 60 * 1000;
    return records.filter((record) => {
      if (Date.parse(record.createdAt) < minTime) return false;
      if (provider !== "all" && record.provider !== provider) return false;
      if (entryKind !== "all" && record.entryKind !== entryKind) return false;
      if (status !== "all" && record.status !== status) return false;
      return true;
    });
  }, [days, entryKind, provider, records, status]);

  const stats = useMemo(() => summarize(filtered), [filtered]);

  async function refresh() {
    setRecords(await listUsage());
  }

  async function handleClear() {
    await clearUsage();
    setRecords([]);
  }

  function exportCsv() {
    const header = [
      "createdAt",
      "entryKind",
      "provider",
      "model",
      "status",
      "durationMs",
      "isFallback",
      "cacheHit",
      "fromLang",
      "toLang",
      "resolvedFromLang",
      "resolvedToLang",
      "ocrMode",
      "inputChars",
      "outputChars",
      "estimatedInputTokens",
      "estimatedOutputTokens",
      "estimatedCostUsd",
      "errorKind",
      "errorSummary",
      "fallbackGroupId",
    ];
    const rows = filtered.map((record) =>
      header.map((key) => csvCell(String(record[key as keyof UsageRecord] ?? ""))).join(","),
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transloop-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="usage-panel" onClick={(e) => e.stopPropagation()}>
        <header className="usage-header">
          <div>
            <h2>用量</h2>
            <p>仅记录请求元数据，不保存原文、译文或截图内容。</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭">
            x
          </button>
        </header>

        <div className="usage-tools">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderName | "all")}
          >
            <option value="all">全部 Provider</option>
            {PROVIDER_REGISTRY.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select value={entryKind} onChange={(e) => setEntryKind(e.target.value as EntryFilter)}>
            <option value="all">全部入口</option>
            <option value="main">主窗口</option>
            <option value="selection">划词</option>
            <option value="capture">截图</option>
            <option value="test">测试</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="all">全部状态</option>
            <option value="success">成功</option>
            <option value="cache_hit">缓存命中</option>
            <option value="error">失败</option>
            <option value="skipped">跳过</option>
          </select>
          <button className="ghost" onClick={exportCsv} disabled={filtered.length === 0}>
            导出 CSV
          </button>
          <button className="ghost danger" onClick={handleClear} disabled={records.length === 0}>
            清空
          </button>
        </div>

        <section className="usage-stats">
          <Metric label="请求数" value={stats.total.toString()} />
          <Metric label="成功率" value={`${stats.successRate}%`} />
          <Metric label="平均耗时" value={`${stats.avgMs}ms`} />
          <Metric label="P95 耗时" value={`${stats.p95Ms}ms`} />
          <Metric label="降级次数" value={stats.fallbacks.toString()} />
          <Metric label="缓存命中" value={`${stats.cacheHits} / ${stats.cacheRate}%`} />
          <Metric label="估算费用" value={formatCost(stats.cost)} />
        </section>

        <section className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>入口</th>
                <th>Provider</th>
                <th>模型</th>
                <th>状态</th>
                <th>耗时</th>
                <th>Token</th>
                <th>费用</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => (
                <tr key={record.id}>
                  <td>{formatTime(record.createdAt)}</td>
                  <td>{entryLabel(record.entryKind)}</td>
                  <td>{record.provider}</td>
                  <td>{record.model}</td>
                  <td>
                    <span className={`usage-badge ${record.status}`}>{statusLabel(record)}</span>
                  </td>
                  <td>{record.durationMs}ms</td>
                  <td>
                    {record.estimatedInputTokens}/{record.estimatedOutputTokens}
                  </td>
                  <td>{formatCost(record.estimatedCostUsd)}</td>
                  <td title={record.errorSummary}>{record.errorSummary ?? ""}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="usage-empty">
                    暂无用量记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function summarize(records: UsageRecord[]) {
  const total = records.length;
  const successes = records.filter(
    (record) => record.status === "success" || record.status === "cache_hit",
  ).length;
  const cacheHits = records.filter(
    (record) => record.cacheHit || record.status === "cache_hit",
  ).length;
  const durations = records
    .filter((record) => record.durationMs > 0)
    .map((record) => record.durationMs)
    .sort((a, b) => a - b);
  const avgMs = durations.length
    ? Math.round(durations.reduce((sum, item) => sum + item, 0) / durations.length)
    : 0;
  const p95Ms = durations.length
    ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
    : 0;
  const cost = records.reduce((sum, record) => sum + (record.estimatedCostUsd ?? 0), 0);
  return {
    total,
    successRate: total ? Math.round((successes / total) * 100) : 0,
    avgMs,
    p95Ms,
    cost,
    fallbacks: records.filter((record) => record.isFallback).length,
    cacheHits,
    cacheRate: total ? Math.round((cacheHits / total) * 100) : 0,
  };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatCost(value?: number): string {
  if (!value) return "-";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function entryLabel(value: UsageRecord["entryKind"]): string {
  return {
    main: "主窗口",
    selection: "划词",
    capture: "截图",
    test: "测试",
  }[value];
}

function statusLabel(record: UsageRecord): string {
  if (record.status === "cache_hit") return "缓存命中";
  if (record.status === "success") return record.isFallback ? "降级成功" : "成功";
  if (record.status === "skipped") return "跳过";
  return record.isFallback ? "降级失败" : "失败";
}
