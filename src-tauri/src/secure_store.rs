//! Windows DPAPI-backed storage for translation history and cache.
//!
//! These files intentionally do not use the renderer-side store plugin.  The
//! native boundary validates the record schema, applies size/retention limits,
//! encrypts with the current Windows user DPAPI key, and removes legacy
//! plaintext files after migration.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

const MAX_HISTORY_BYTES: usize = 32 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;
const MAX_HISTORY_RECORDS: usize = 200;
const MAX_CACHE_RECORDS: usize = 1_000;
const MAX_TEXT_CHARS: usize = 200_000;
const MAX_IMAGE_PREVIEW_CHARS: usize = 1_500_000;

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    schema_version: u32,
    encryption: String,
    ciphertext: String,
}

pub fn history_get(window: &WebviewWindow, app: &AppHandle) -> Result<Vec<Value>, String> {
    require_read_window(window)?;
    load_records(app, "history.secure.json", "history.json", MAX_HISTORY_BYTES, MAX_HISTORY_RECORDS)
}

pub fn history_add(window: &WebviewWindow, app: &AppHandle, record: Value) -> Result<(), String> {
    require_write_window(window)?;
    let record = sanitize_history_record(&record)?;
    let mut records = load_records(app, "history.secure.json", "history.json", MAX_HISTORY_BYTES, MAX_HISTORY_RECORDS)?;
    records.insert(0, record);
    records.truncate(MAX_HISTORY_RECORDS);
    save_records(app, "history.secure.json", &records, MAX_HISTORY_BYTES, MAX_HISTORY_RECORDS)
}

pub fn history_delete(window: &WebviewWindow, app: &AppHandle, id: String) -> Result<(), String> {
    require_read_window(window)?;
    if id.trim().is_empty() || id.len() > 128 {
        return Err("历史记录 ID 无效。".into());
    }
    let mut records = load_records(app, "history.secure.json", "history.json", MAX_HISTORY_BYTES, MAX_HISTORY_RECORDS)?;
    records.retain(|record| record.get("id").and_then(Value::as_str) != Some(id.as_str()));
    save_records(app, "history.secure.json", &records, MAX_HISTORY_BYTES, MAX_HISTORY_RECORDS)
}

pub fn history_clear(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    require_read_window(window)?;
    save_records(app, "history.secure.json", &[], MAX_HISTORY_BYTES, MAX_HISTORY_RECORDS)
}

pub fn cache_get(window: &WebviewWindow, app: &AppHandle) -> Result<Vec<Value>, String> {
    require_write_window(window)?;
    load_records(
        app,
        "translation-cache.secure.json",
        "translation-cache.json",
        MAX_CACHE_BYTES,
        MAX_CACHE_RECORDS,
    )
}

pub fn cache_put(window: &WebviewWindow, app: &AppHandle, records: Vec<Value>) -> Result<(), String> {
    require_write_window(window)?;
    save_records(
        app,
        "translation-cache.secure.json",
        &records,
        MAX_CACHE_BYTES,
        MAX_CACHE_RECORDS,
    )
}

pub fn cache_clear(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    require_write_window(window)?;
    save_records(
        app,
        "translation-cache.secure.json",
        &[],
        MAX_CACHE_BYTES,
        MAX_CACHE_RECORDS,
    )
}

fn require_read_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("该窗口不允许读取历史正文。".into())
    }
}

fn require_write_window(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "popup" | "capture") {
        Ok(())
    } else {
        Err("该窗口不允许访问翻译数据。".into())
    }
}

fn load_records(
    app: &AppHandle,
    secure_name: &str,
    legacy_name: &str,
    max_bytes: usize,
    max_records: usize,
) -> Result<Vec<Value>, String> {
    let path = data_path(app, secure_name)?;
    let legacy_path = data_path(app, legacy_name)?;
    let secure_exists = path.is_file();

    let raw_records = if secure_exists {
        let bytes = fs::read(&path).map_err(|_| "读取加密数据失败。".to_string())?;
        if bytes.len() > max_bytes.saturating_mul(2).saturating_add(4_096) {
            return Err("加密数据超过大小限制。".into());
        }
        let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|_| "加密数据格式无效。".to_string())?;
        if envelope.schema_version != 2 || envelope.encryption != "dpapi-current-user" {
            return Err("加密数据版本不受支持。".into());
        }
        let plaintext = decrypt(&envelope.ciphertext)?;
        if plaintext.len() > max_bytes {
            return Err("加密数据超过大小限制。".into());
        }
        parse_array(&plaintext)?
    } else if legacy_path.is_file() {
        let legacy_bytes = fs::read(&legacy_path).map_err(|_| "读取旧数据失败。".to_string())?;
        if legacy_bytes.len() > max_bytes {
            return Err("旧数据超过大小限制。".into());
        }
        let root: Value = serde_json::from_slice(&legacy_bytes).map_err(|_| "旧数据格式无效。".to_string())?;
        root.get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let (records, _) = sanitize_records(raw_records, secure_name, max_bytes, max_records)?;
    if !secure_exists && legacy_path.is_file() {
        save_records(app, secure_name, &records, max_bytes, max_records)?;
    }
    // A secure file is authoritative.  Remove any stale plaintext legacy file
    // as well, otherwise migration would leave sensitive data readable on disk.
    if legacy_path.is_file() {
        let _ = fs::remove_file(legacy_path);
    }
    Ok(records)
}

fn save_records(
    app: &AppHandle,
    name: &str,
    records: &[Value],
    max_bytes: usize,
    max_records: usize,
) -> Result<(), String> {
    let (records, _) = sanitize_records(records.to_vec(), name, max_bytes, max_records)?;
    let plaintext = serde_json::to_vec(&records).map_err(|_| "序列化数据失败。".to_string())?;
    if plaintext.len() > max_bytes {
        return Err("保存数据超过大小限制。".into());
    }
    let envelope = make_envelope(&plaintext)?;
    let bytes = serde_json::to_vec(&envelope).map_err(|_| "序列化加密数据失败。".to_string())?;
    let path = data_path(app, name)?;
    atomic_write(&path, &bytes)
}

fn parse_array(bytes: &[u8]) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "加密数据内容无效。".to_string())?;
    value
        .as_array()
        .cloned()
        .ok_or_else(|| "加密数据记录无效。".to_string())
}

fn sanitize_records(
    records: Vec<Value>,
    name: &str,
    max_bytes: usize,
    max_records: usize,
) -> Result<(Vec<Value>, bool), String> {
    let mut changed = records.len() > max_records;
    let mut sanitized = Vec::with_capacity(records.len().min(max_records));
    for record in records.into_iter().take(max_records) {
        let value = if name.starts_with("history") {
            sanitize_history_record(&record)
        } else {
            sanitize_cache_record(&record)
        };
        match value {
            Ok(value) => {
                if value != record {
                    changed = true;
                }
                sanitized.push(value);
            }
            Err(_) => changed = true,
        }
    }
    let bytes = serde_json::to_vec(&sanitized).map_err(|_| "序列化数据失败。".to_string())?;
    if bytes.len() > max_bytes {
        return Err("数据超过大小限制。".into());
    }
    Ok((sanitized, changed))
}

fn sanitize_history_record(value: &Value) -> Result<Value, String> {
    let object = value.as_object().ok_or_else(|| "历史记录格式无效。".to_string())?;
    let id = required_string(object, "id", 128)?;
    let kind = required_string(object, "kind", 16)?;
    if !matches!(kind.as_str(), "selection" | "capture") {
        return Err("历史记录类型无效。".into());
    }
    let original = required_text(object, "original")?;
    let translation = required_text(object, "translation")?;
    let from_lang = required_string(object, "fromLang", 32)?;
    let to_lang = required_string(object, "toLang", 32)?;
    let provider = required_string(object, "provider", 32)?;
    if !matches!(provider.as_str(), "deepseek" | "openai" | "claude" | "gemini" | "qwen" | "grok" | "minimax") {
        return Err("历史记录 Provider 无效。".into());
    }
    let model = required_string(object, "model", 200)?;
    let created_at = required_string(object, "createdAt", 64)?;
    let mut output = Map::new();
    output.insert("id".into(), Value::String(id));
    output.insert("kind".into(), Value::String(kind));
    output.insert("original".into(), Value::String(original));
    output.insert("translation".into(), Value::String(translation));
    output.insert("fromLang".into(), Value::String(from_lang));
    output.insert("toLang".into(), Value::String(to_lang));
    output.insert("provider".into(), Value::String(provider));
    output.insert("model".into(), Value::String(model));
    output.insert("createdAt".into(), Value::String(created_at));
    if let Some(ocr) = object.get("ocrMode").and_then(Value::as_str) {
        if matches!(ocr, "A" | "B" | "C") {
            output.insert("ocrMode".into(), Value::String(ocr.into()));
        }
    }
    if let Some(preview) = object.get("imagePreview").and_then(Value::as_str) {
        if preview.len() <= MAX_IMAGE_PREVIEW_CHARS
            && (preview.starts_with("data:image/jpeg;base64,") || preview.starts_with("data:image/png;base64,"))
        {
            output.insert("imagePreview".into(), Value::String(preview.into()));
        }
    }
    Ok(Value::Object(output))
}

fn sanitize_cache_record(value: &Value) -> Result<Value, String> {
    let object = value.as_object().ok_or_else(|| "缓存记录格式无效。".to_string())?;
    let cache_key = required_string(object, "cacheKey", 160)?;
    let source_hash = required_string(object, "sourceHash", 128)?;
    if source_hash.len() != 64 || !source_hash.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err("缓存哈希格式无效。".into());
    }
    let from_lang = required_string(object, "fromLang", 32)?;
    let to_lang = required_string(object, "toLang", 32)?;
    let translation = required_text(object, "translation")?;
    let created_at = required_string(object, "createdAt", 64)?;
    let last_hit_at = required_string(object, "lastHitAt", 64)?;
    let hit_count = object
        .get("hitCount")
        .and_then(Value::as_u64)
        .filter(|value| *value <= 1_000_000)
        .ok_or_else(|| "缓存命中次数无效。".to_string())?;
    let mut output = Map::new();
    output.insert("cacheKey".into(), Value::String(cache_key));
    output.insert("sourceHash".into(), Value::String(source_hash));
    output.insert("fromLang".into(), Value::String(from_lang));
    output.insert("toLang".into(), Value::String(to_lang));
    output.insert("translation".into(), Value::String(translation));
    output.insert("createdAt".into(), Value::String(created_at));
    output.insert("lastHitAt".into(), Value::String(last_hit_at));
    output.insert("hitCount".into(), Value::Number(hit_count.into()));
    Ok(Value::Object(output))
}

fn required_string(object: &Map<String, Value>, key: &str, max: usize) -> Result<String, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= max)
        .ok_or_else(|| format!("字段 {key} 无效。"))?;
    Ok(value.to_string())
}

fn required_text(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| value.len() <= MAX_TEXT_CHARS)
        .ok_or_else(|| format!("字段 {key} 无效。"))?;
    Ok(value.to_string())
}

fn data_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !matches!(
        name,
        "history.secure.json" | "history.json" | "translation-cache.secure.json" | "translation-cache.json"
    ) {
        return Err("安全存储文件名无效。".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "定位数据目录失败。".to_string())?;
    fs::create_dir_all(&dir).map_err(|_| "创建数据目录失败。".to_string())?;
    Ok(dir.join(name))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "安全存储状态不可用。".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary = path.with_file_name(format!(".{}.{}.tmp", path.file_name().and_then(|v| v.to_str()).unwrap_or("data"), stamp));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "写入临时数据失败。".to_string())?;
    file.write_all(bytes).map_err(|_| "写入临时数据失败。".to_string())?;
    file.sync_all().map_err(|_| "提交临时数据失败。".to_string())?;
    drop(file);
    if path.exists() {
        fs::remove_file(path).map_err(|_| "替换安全数据失败。".to_string())?;
    }
    fs::rename(&temporary, path).map_err(|_| "提交加密数据失败。".to_string())?;
    drop(guard);
    Ok(())
}

fn make_envelope(plaintext: &[u8]) -> Result<Envelope, String> {
    Ok(Envelope {
        schema_version: 2,
        encryption: "dpapi-current-user".to_string(),
        ciphertext: encrypt(plaintext)?,
    })
}

fn encrypt(plaintext: &[u8]) -> Result<String, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|_| "DPAPI 加密失败。".to_string())?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(STANDARD.encode(bytes))
    }
}

fn decrypt(ciphertext: &str) -> Result<Vec<u8>, String> {
    let encrypted = STANDARD
        .decode(ciphertext)
        .map_err(|_| "加密数据编码无效。".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|_| "DPAPI 解密失败。".to_string())?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(bytes)
    }
}
