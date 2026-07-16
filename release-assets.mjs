import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const [installerArg, outputArg] = process.argv.slice(2);
if (!installerArg) {
  console.error("Usage: node release-assets.mjs <installer.exe> [output-directory]");
  process.exit(2);
}

const installerPath = resolve(installerArg);
if (!existsSync(installerPath) || !statSync(installerPath).isFile()) {
  throw new Error("installer 不存在或不是文件。");
}

const fileName = basename(installerPath);
if (!/^TransLoop_[0-9A-Za-z.-]+_x64-setup\.exe$/.test(fileName)) {
  throw new Error("安装包文件名不符合 TransLoop 版本命名规则。");
}

const installer = readFileSync(installerPath);
if (installer.length === 0 || installer.length > 250 * 1024 * 1024) {
  throw new Error("安装包大小无效。");
}

const privateKeyMaterial = process.env.TRANSLOOP_UPDATE_SIGNING_PRIVATE_KEY ??
  (process.env.TRANSLOOP_UPDATE_SIGNING_PRIVATE_KEY_B64
    ? Buffer.from(process.env.TRANSLOOP_UPDATE_SIGNING_PRIVATE_KEY_B64, "base64").toString("utf8")
    : "");
if (!privateKeyMaterial.trim()) {
  throw new Error("未提供 TRANSLOOP_UPDATE_SIGNING_PRIVATE_KEY CI Secret。");
}

const privateKey = createPrivateKey({ key: privateKeyMaterial, format: "pem", type: "pkcs8" });
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("更新签名私钥必须是 Ed25519 PKCS#8 密钥。");
}
const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const derivedPublicKey = publicKeyDer.subarray(-32).toString("hex");
const expectedPublicKey = (process.env.TRANSLOOP_UPDATE_PUBLIC_KEY_HEX ?? "").trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(expectedPublicKey) || expectedPublicKey !== derivedPublicKey) {
  throw new Error("签名私钥与 TRANSLOOP_UPDATE_PUBLIC_KEY_HEX 不匹配。");
}

const hash = createHash("sha256").update(installer).digest("hex");
const manifest = `${hash}  ${fileName}\n`;
const signature = sign(null, Buffer.from(manifest, "utf8"), privateKey).toString("base64");
const outputDir = resolve(outputArg ?? dirname(installerPath));
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, "SHA256SUMS"), manifest, { encoding: "utf8" });
writeFileSync(resolve(outputDir, "SHA256SUMS.sig"), `${signature}\n`, { encoding: "utf8" });

console.log(`SHA256SUMS created for ${fileName}: ${hash}`);
