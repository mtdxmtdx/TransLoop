import { invoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "./appInfo";
import { logDiagnosticEvent } from "./diagnostics";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadFileName: string;
  publishedAt: string;
  notes: string;
  verificationAvailable: boolean;
}

export interface VerifiedUpdate {
  version: string;
  fileName: string;
  size: number;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const started = performance.now();
  try {
    const result = await invoke<UpdateCheckResult>("check_for_updates");
    await logDiagnosticEvent({
      level: "info",
      category: "update",
      message: `更新检查完成：${APP_VERSION} -> ${result.latestVersion}`,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  } catch {
    await logDiagnosticEvent({
      level: "error",
      category: "update",
      message: "更新检查失败",
      durationMs: Math.round(performance.now() - started),
      errorSummary: "更新检查失败",
    });
    throw new Error("更新检查失败。");
  }
}

export async function downloadAndLaunchVerifiedUpdate(version: string): Promise<VerifiedUpdate> {
  const verified = await invoke<VerifiedUpdate>("download_verified_update", { version });
  await invoke("launch_verified_update", { version: verified.version });
  return verified;
}
