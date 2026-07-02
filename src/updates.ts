import { fetch } from "@tauri-apps/plugin-http";
import { APP_VERSION, GITHUB_RELEASES_URL, GITHUB_REPO } from "./appInfo";
import { logDiagnosticEvent } from "./diagnostics";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadUrl: string;
  downloadFileName: string;
  publishedAt: string;
  notes: string;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const started = performance.now();
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "TransLoop",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub Releases 请求失败（${response.status}）`);
    }
    const release = (await response.json()) as GitHubRelease;
    const latestVersion = normalizeVersion(release.tag_name ?? "");
    if (!latestVersion) throw new Error("未能解析最新版本号。");
    const asset = pickDownloadAsset(release);
    const downloadUrl = asset?.browser_download_url ?? release.html_url ?? GITHUB_RELEASES_URL;
    const result: UpdateCheckResult = {
      currentVersion: APP_VERSION,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, APP_VERSION) > 0,
      releaseUrl: release.html_url ?? GITHUB_RELEASES_URL,
      downloadUrl,
      downloadFileName: asset?.name ?? `TransLoop_${latestVersion}_x64-setup.exe`,
      publishedAt: release.published_at ?? "",
      notes: release.body ?? "",
    };
    await logDiagnosticEvent({
      level: "info",
      category: "update",
      message: `更新检查完成：${APP_VERSION} -> ${latestVersion}`,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logDiagnosticEvent({
      level: "error",
      category: "update",
      message: "更新检查失败",
      durationMs: Math.round(performance.now() - started),
      errorSummary: message,
    });
    throw new Error(message);
  }
}

function pickDownloadAsset(
  release: GitHubRelease,
): { name?: string; browser_download_url?: string } | undefined {
  const assets = release.assets ?? [];
  return (
    assets.find((asset) => asset.name?.toLowerCase().endsWith(".exe")) ??
    assets.find((asset) => asset.name?.toLowerCase().includes("setup")) ??
    assets[0]
  );
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
