import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL(".", import.meta.url).pathname.replace(/^\//, "").replaceAll("/", "\\");
const read = (file) => readFileSync(`${root}${file}`, "utf8");
const failures = [];

const sourceFiles = [
  "src",
  "src-tauri/src",
].flatMap((dir) => {
  try {
    return execFileSync("rg", ["--files", dir], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
});

const source = sourceFiles.map((file) => read(`\\${file.replaceAll("/", "\\")}`)).join("\n");
const assertNotFound = (pattern, label) => {
  if (pattern.test(source)) failures.push(label);
};

assertNotFound(/@tauri-apps\/plugin-http|save_and_launch_installer|dangerouslySetInnerHTML/, "发现已禁止的网络/HTML/安装器 API");
assertNotFound(/invoke\(\s*["']get_secret["']/, "WebView 仍可读取完整 Secret");
assertNotFound(/migrate_legacy_secrets[\s\S]{0,80}catch\(\(\)\s*=>\s*\{\s*\}\)/, "旧版凭证迁移错误被静默忽略");
assertNotFound(/try_lock\(\)/, "请求取消仍使用非强制 try_lock");
if (/"csp"\s*:\s*null/.test(read("\\src-tauri\\tauri.conf.json"))) failures.push("生产 CSP 为空");
if (!/redirect\(reqwest::redirect::Policy::none\(\)\)/.test(read("\\src-tauri\\src\\provider.rs"))) failures.push("Provider 未禁用重定向");
if (!/verify_manifest/.test(read("\\src-tauri\\src\\update.rs"))) failures.push("更新器缺少签名清单校验");
if (!/option_env!\("TRANSLOOP_UPDATE_PUBLIC_KEY_HEX"\)/.test(read("\\src-tauri\\src\\update.rs"))) failures.push("更新公钥未通过构建环境注入");
if (!existsSync(`${root}\\release-assets.mjs`) || !existsSync(`${root}\\.github\\workflows\\release.yml`)) failures.push("缺少签名 Release 发布流程");
if (existsSync(`${root}\\.env`) || existsSync(`${root}\\.env.local`)) failures.push("仓库目录存在本地 .env 文件");

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("Security static checks passed.");
