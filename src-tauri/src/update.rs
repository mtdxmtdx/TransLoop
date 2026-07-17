//! Signed update discovery and installation.
//!
//! The WebView never receives an arbitrary URL, file name, or executable
//! bytes. Rust resolves the fixed repository, follows only explicitly trusted
//! GitHub asset redirects, verifies a signed checksum manifest, and rechecks
//! the installer before launching it.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewWindow};

const REPOSITORY: &str = "mtdxmtdx/TransLoop";
const MAX_INSTALLER_BYTES: usize = 250 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 1 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
const MAX_RELEASE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 4;
const UPDATE_CHECK_COOLDOWN: Duration = Duration::from_secs(30);

// The public half is injected at compile time.  The private half must exist
// only in the release CI secret, never in the repository or installer.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub download_file_name: String,
    pub published_at: String,
    pub notes: String,
    pub verification_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedUpdate {
    pub version: String,
    pub file_name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateState {
    verified: Arc<Mutex<Option<VerifiedInstaller>>>,
    last_check: Arc<Mutex<Option<Instant>>>,
    downloading: Arc<Mutex<bool>>,
}

#[derive(Debug, Clone)]
struct VerifiedInstaller {
    version: String,
    directory: PathBuf,
    path: PathBuf,
    file_name: String,
    sha256: String,
}

struct DownloadGuard {
    downloading: Arc<Mutex<bool>>,
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut downloading) = self.downloading.lock() {
            *downloading = false;
        }
    }
}

struct PendingFile {
    path: PathBuf,
    directory: PathBuf,
    file_name: String,
    armed: bool,
}

impl PendingFile {
    fn new(path: PathBuf, directory: PathBuf, file_name: String) -> Self {
        Self {
            path,
            directory,
            file_name,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn arm(&mut self) {
        self.armed = true;
    }
}

impl Drop for PendingFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_exact_file(&self.path, &self.directory, &self.file_name);
        }
    }
}

impl UpdateState {
    pub fn allow_check(&self) -> Result<(), String> {
        let mut last = self
            .last_check
            .lock()
            .map_err(|_| "更新状态不可用。".to_string())?;
        if last.is_some_and(|time| time.elapsed() < UPDATE_CHECK_COOLDOWN) {
            return Err("更新检查过于频繁，请稍后重试。".into());
        }
        *last = Some(Instant::now());
        Ok(())
    }

    fn begin_download(&self) -> Result<DownloadGuard, String> {
        let mut downloading = self
            .downloading
            .lock()
            .map_err(|_| "更新状态不可用。".to_string())?;
        if *downloading {
            return Err("已有更新正在下载，请稍候。".into());
        }
        *downloading = true;
        Ok(DownloadGuard {
            downloading: self.downloading.clone(),
        })
    }
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    assets: Option<Vec<Asset>>,
}

#[derive(Debug, Deserialize, Clone)]
struct Asset {
    name: Option<String>,
    browser_download_url: Option<String>,
}

pub async fn check_update_async(current_version: &str) -> Result<UpdateCheckResult> {
    let current_version = normalize_version(current_version).ok_or_else(|| anyhow!("当前版本号无效"))?;
    let release = fetch_latest_release().await?;
    let latest_version = normalize_version(release.tag_name.as_deref().unwrap_or_default())
        .ok_or_else(|| anyhow!("最新版本号无效"))?;
    let assets = release.assets.clone().unwrap_or_default();
    let installer_name = format!("TransLoop_{latest_version}_x64-setup.exe");
    let verification_available = update_public_key().is_ok()
        && find_asset(&assets, "SHA256SUMS").is_some()
        && find_asset(&assets, "SHA256SUMS.sig").is_some()
        && find_asset(&assets, &installer_name).is_some();
    Ok(UpdateCheckResult {
        current_version: current_version.clone(),
        latest_version: latest_version.clone(),
        has_update: compare_versions(&latest_version, &current_version) > 0,
        release_url: format!("https://github.com/{REPOSITORY}/releases/tag/v{latest_version}"),
        download_file_name: installer_name,
        published_at: release
            .published_at
            .unwrap_or_default()
            .chars()
            .take(64)
            .collect(),
        notes: release.body.unwrap_or_default().chars().take(32_000).collect(),
        verification_available,
    })
}

pub async fn download_verified(
    window: &WebviewWindow,
    app: &AppHandle,
    state: &UpdateState,
    version: String,
) -> Result<VerifiedUpdate, String> {
    require_main(window)?;
    let _guard = state.begin_download()?;
    download_verified_async(app, state, &version)
        .await
        .map_err(|_| "更新下载或校验失败。".to_string())
}

async fn download_verified_async(
    app: &AppHandle,
    state: &UpdateState,
    requested_version: &str,
) -> Result<VerifiedUpdate> {
    let requested = normalize_version(requested_version).ok_or_else(|| anyhow!("版本号无效"))?;
    let release = fetch_release(&requested).await?;
    let release_version = normalize_version(release.tag_name.as_deref().unwrap_or_default())
        .ok_or_else(|| anyhow!("Release 版本号无效"))?;
    if release_version != requested {
        return Err(anyhow!("Release 版本不匹配"));
    }
    let assets = release.assets.unwrap_or_default();
    let file_name = format!("TransLoop_{release_version}_x64-setup.exe");
    let dir = app.path().temp_dir()?.join("TransLoop").join("updates");
    fs::create_dir_all(&dir)?;
    let path = dir.join(&file_name);
    let temporary_name = format!(".{file_name}.download");
    let temporary = dir.join(&temporary_name);

    // A new attempt invalidates the in-memory launch authorization.  Only a
    // stale temporary file for this normalized version is removed here.  An
    // existing final installer is preserved until its replacement has passed
    // signature and SHA-256 verification and has been fully written.
    *state
        .verified
        .lock()
        .map_err(|_| anyhow!("更新状态不可用"))? = None;
    remove_exact_file(&temporary, &dir, &temporary_name)?;

    let installer = find_asset(&assets, &file_name).ok_or_else(|| anyhow!("缺少安装包"))?;
    let manifest_asset = find_asset(&assets, "SHA256SUMS").ok_or_else(|| anyhow!("缺少 SHA256 清单"))?;
    let signature_asset = find_asset(&assets, "SHA256SUMS.sig").ok_or_else(|| anyhow!("缺少清单签名"))?;
    let installer_url = trusted_url(installer.browser_download_url.as_deref().unwrap_or_default())?;
    let manifest_url = trusted_url(manifest_asset.browser_download_url.as_deref().unwrap_or_default())?;
    let signature_url = trusted_url(signature_asset.browser_download_url.as_deref().unwrap_or_default())?;
    let client = client()?;
    let manifest = fetch_asset_bytes(&client, &manifest_url, MAX_MANIFEST_BYTES).await?;
    let signature_bytes = fetch_asset_bytes(&client, &signature_url, MAX_SIGNATURE_BYTES).await?;
    verify_manifest(&manifest, &signature_bytes)?;
    let expected_hash = expected_hash(&manifest, &file_name)?;

    let bytes = fetch_asset_bytes(&client, &installer_url, MAX_INSTALLER_BYTES).await?;
    if bytes.is_empty() {
        return Err(anyhow!("安装包大小无效"));
    }
    let actual_hash = hash_bytes(&bytes);
    if actual_hash != expected_hash {
        return Err(anyhow!("安装包 SHA-256 校验失败"));
    }

    let mut pending_temporary = PendingFile::new(
        temporary.clone(),
        dir.clone(),
        temporary_name,
    );
    pending_temporary.disarm();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    pending_temporary.arm();
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    remove_exact_file(&path, &dir, &file_name)?;
    fs::rename(&temporary, &path)?;
    pending_temporary.disarm();

    let mut pending_final = PendingFile::new(path.clone(), dir.clone(), file_name.clone());
    *state
        .verified
        .lock()
        .map_err(|_| anyhow!("更新状态不可用"))? = Some(VerifiedInstaller {
        version: release_version.clone(),
        directory: dir,
        path,
        file_name: file_name.clone(),
        sha256: expected_hash,
    });
    pending_final.disarm();
    Ok(VerifiedUpdate {
        version: release_version,
        file_name,
        size: bytes.len() as u64,
    })
}

pub fn launch_verified(window: &WebviewWindow, state: &UpdateState, version: String) -> Result<(), String> {
    require_main(window)?;
    let installer = state
        .verified
        .lock()
        .map_err(|_| "更新状态不可用。".to_string())?
        .take()
        .ok_or_else(|| "没有已验证的安装包。".to_string())?;
    if installer.version != normalize_version(&version).unwrap_or_default() {
        let _ = remove_verified_file(&installer);
        return Err("安装包版本不匹配。".into());
    }
    if !verified_path_is_safe(&installer) {
        return Err("已验证安装包路径无效。".into());
    }
    let bytes = match fs::read(&installer.path) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = remove_verified_file(&installer);
            return Err("读取已验证安装包失败。".into());
        }
    };
    if bytes.len() > MAX_INSTALLER_BYTES || hash_bytes(&bytes) != installer.sha256 {
        let _ = remove_verified_file(&installer);
        return Err("安装包在启动前校验失败。".into());
    }
    if std::process::Command::new(&installer.path).spawn().is_err() {
        let _ = remove_verified_file(&installer);
        return Err("启动安装包失败。".into());
    }
    Ok(())
}

fn verified_path_is_safe(installer: &VerifiedInstaller) -> bool {
    let expected_name = format!("TransLoop_{}_x64-setup.exe", installer.version);
    installer.file_name == expected_name
        && installer.path.parent() == Some(installer.directory.as_path())
        && installer.path.file_name().and_then(|value| value.to_str()) == Some(expected_name.as_str())
        && installer.directory.file_name().and_then(|value| value.to_str()) == Some("updates")
        && installer
            .directory
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some("TransLoop")
        && installer.path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("exe"))
            == Some(true)
}

fn remove_verified_file(installer: &VerifiedInstaller) -> Result<()> {
    if !verified_path_is_safe(installer) {
        return Err(anyhow!("拒绝删除非更新器管理的路径"));
    }
    remove_exact_file(&installer.path, &installer.directory, &installer.file_name)
}

fn remove_exact_file(path: &Path, directory: &Path, expected_name: &str) -> Result<()> {
    if path.parent() != Some(directory)
        || path.file_name().and_then(|value| value.to_str()) != Some(expected_name)
    {
        return Err(anyhow!("拒绝删除非更新器管理的路径"));
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("该操作只能由主窗口发起。".into())
    }
}

async fn fetch_latest_release() -> Result<Release> {
    let url = format!("https://api.github.com/repos/{REPOSITORY}/releases/latest");
    fetch_release_json(&url).await
}

async fn fetch_release(version: &str) -> Result<Release> {
    let tag = format!("v{version}");
    let url = format!("https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}");
    fetch_release_json(&url).await
}

async fn fetch_release_json(url: &str) -> Result<Release> {
    let response = client()?
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "TransLoop")
        .send()
        .await?
        .error_for_status()?;
    let bytes = read_limited(response, MAX_RELEASE_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(Into::into)
}

fn client() -> Result<Client> {
    Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(Into::into)
}

async fn fetch_asset_bytes(client: &Client, initial: &str, max_bytes: usize) -> Result<Vec<u8>> {
    let mut current = Url::parse(initial)?;
    for _ in 0..=MAX_REDIRECTS {
        trusted_url(current.as_str())?;
        let response = client
            .get(current.clone())
            .header("User-Agent", "TransLoop")
            .send()
            .await?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| anyhow!("更新重定向地址无效"))?;
            current = current.join(location)?;
            continue;
        }
        return read_limited(response.error_for_status()?, max_bytes).await;
    }
    Err(anyhow!("更新重定向次数过多"))
}

async fn read_limited(mut response: Response, max_bytes: usize) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|length| length > max_bytes as u64) {
        return Err(anyhow!("更新响应过大"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(anyhow!("更新响应过大"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn trusted_url(value: &str) -> Result<String> {
    let url = Url::parse(value)?;
    // GitHub Release assets redirect to signed CDN URLs whose query contains
    // temporary authorization parameters.  The host allowlist below still
    // prevents arbitrary destinations, so query parameters are safe to carry
    // through without logging or interpreting them.
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !matches!(
            url.host_str(),
            Some("github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com")
        )
    {
        return Err(anyhow!("更新地址不受信任"));
    }
    Ok(url.to_string())
}

fn find_asset(assets: &[Asset], name: &str) -> Option<Asset> {
    assets.iter().find(|asset| asset.name.as_deref() == Some(name)).cloned()
}

fn verify_manifest(manifest: &[u8], signature_bytes: &[u8]) -> Result<()> {
    let key = update_public_key()?;
    let signature = parse_signature(signature_bytes)?;
    key.verify(manifest, &signature).map_err(|_| anyhow!("更新清单签名无效"))
}

fn update_public_key() -> Result<VerifyingKey> {
    let encoded = option_env!("TRANSLOOP_UPDATE_PUBLIC_KEY_HEX")
        .ok_or_else(|| anyhow!("更新公钥未配置"))?;
    let bytes = hex::decode(encoded).map_err(|_| anyhow!("更新公钥格式无效"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow!("更新公钥长度无效"))?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| anyhow!("更新公钥无效"))
}

fn parse_signature(value: &[u8]) -> Result<Signature> {
    if value.len() > MAX_SIGNATURE_BYTES {
        return Err(anyhow!("签名过大"));
    }
    let trimmed = std::str::from_utf8(value).unwrap_or_default().trim();
    if let Ok(bytes) = hex::decode(trimmed) {
        return Signature::from_slice(&bytes).map_err(|_| anyhow!("签名格式无效"));
    }
    let bytes = STANDARD.decode(trimmed).map_err(|_| anyhow!("签名格式无效"))?;
    Signature::from_slice(&bytes).map_err(|_| anyhow!("签名格式无效"))
}

fn expected_hash(manifest: &[u8], file_name: &str) -> Result<String> {
    for line in std::str::from_utf8(manifest)?.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or_default().to_ascii_lowercase();
        let name = parts.next().unwrap_or_default().trim_start_matches('*');
        if name == file_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(hash);
        }
    }
    Err(anyhow!("清单中没有匹配的安装包哈希"))
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn normalize_version(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches(['v', 'V']);
    if value.is_empty() || value.len() > 32 {
        return None;
    }
    let mut parts = value.splitn(2, '-');
    let core = parts.next()?;
    let pre = parts.next();
    let core_parts: Vec<&str> = core.split('.').collect();
    if core_parts.len() != 3
        || core_parts.iter().any(|part| part.is_empty() || part.parse::<u32>().is_err())
        || pre.is_some_and(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
    {
        return None;
    }
    Some(value.to_string())
}

fn compare_versions(a: &str, b: &str) -> i32 {
    let (a_core, a_pre) = a.split_once('-').map_or((a, None), |(core, pre)| (core, Some(pre)));
    let (b_core, b_pre) = b.split_once('-').map_or((b, None), |(core, pre)| (core, Some(pre)));
    for (left, right) in a_core.split('.').zip(b_core.split('.')) {
        let diff = left.parse::<u32>().unwrap_or(0) as i64 - right.parse::<u32>().unwrap_or(0) as i64;
        if diff != 0 { return diff.signum() as i32; }
    }
    match (a_pre, b_pre) {
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(left), Some(right)) => left.cmp(right) as i32,
        (None, None) => 0,
    }
}

#[allow(dead_code)]
fn _path_is_under(path: &Path, parent: &Path) -> bool {
    path.canonicalize().ok().zip(parent.canonicalize().ok()).is_some_and(|(path, parent)| path.starts_with(parent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_strict_versions() {
        assert_eq!(normalize_version("v1.0.0").as_deref(), Some("1.0.0"));
        assert!(normalize_version("1.0").is_none());
        assert!(normalize_version("1.0.0/evil").is_none());
    }

    #[test]
    fn rejects_untrusted_asset_hosts() {
        assert!(trusted_url("https://github.com/mtdxmtdx/TransLoop/releases/download/v1.0.0/a.exe").is_ok());
        assert!(trusted_url("https://evil.example/a.exe").is_err());
        assert!(trusted_url("http://github.com/a.exe").is_err());
        assert!(trusted_url("https://github.com/a.exe?redirect=evil").is_ok());
        assert!(trusted_url("https://release-assets.githubusercontent.com/asset.exe?token=temporary").is_ok());
        assert!(trusted_url("https://github.com:444/a.exe").is_err());
    }

    #[test]
    fn update_key_fails_closed_when_not_injected() {
        if option_env!("TRANSLOOP_UPDATE_PUBLIC_KEY_HEX").is_none() {
            assert!(update_public_key().is_err());
        } else {
            assert!(update_public_key().is_ok());
        }
    }

    #[test]
    fn cleanup_removes_only_the_exact_update_file() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("TransLoop").join("updates");
        fs::create_dir_all(&directory).unwrap();
        let expected_name = "TransLoop_1.0.0_x64-setup.exe";
        let expected = directory.join(expected_name);
        let neighbor = directory.join("keep-me.txt");
        let outside = root.path().join(expected_name);
        fs::write(&expected, b"bad update").unwrap();
        fs::write(&neighbor, b"neighbor").unwrap();
        fs::write(&outside, b"outside").unwrap();

        remove_exact_file(&expected, &directory, expected_name).unwrap();
        assert!(!expected.exists());
        assert!(neighbor.is_file());
        assert!(outside.is_file());

        assert!(remove_exact_file(&neighbor, &directory, expected_name).is_err());
        assert!(remove_exact_file(&outside, &directory, expected_name).is_err());
        assert!(neighbor.is_file());
        assert!(outside.is_file());

        fs::create_dir(&expected).unwrap();
        assert!(remove_exact_file(&expected, &directory, expected_name).is_err());
        assert!(expected.is_dir());
    }
}
