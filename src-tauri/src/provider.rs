//! Native Provider gateway.
//!
//! Provider credentials and network requests deliberately live on the Rust side
//! of the application.  The WebView only submits a bounded request description
//! and receives structured events; it never receives a key or a raw provider
//! response body.

use std::collections::{HashMap, VecDeque};
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::Entry;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const KEYRING_SERVICE: &str = "com.transloop.app";
const EVENT_NAME: &str = "translation://event";
const MAX_TEXT_CHARS: usize = 50_000;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_CHARS: usize = 30 * 1024 * 1024;
const MAX_OUTPUT_CHARS: usize = 200_000;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_FALLBACK_MODELS: usize = 20;
const MAX_FALLBACK_PROVIDERS: usize = 7;
const MAX_API_KEY_BYTES: usize = 512;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRequest {
    pub request_id: String,
    pub operation: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub fallback_enabled: bool,
    pub fallback_models: Vec<String>,
    pub fallback_provider_order: Vec<String>,
    pub provider_configs: HashMap<String, PublicProviderConfig>,
    pub system_prompt: String,
    pub user_prompt: Option<String>,
    pub image_data_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProviderConfig {
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAttempt {
    pub provider: String,
    pub model: String,
    pub status: String,
    pub duration_ms: u64,
    pub is_fallback: bool,
    pub error_kind: Option<String>,
    pub error_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationEvent {
    pub request_id: String,
    pub phase: String,
    pub delta: Option<String>,
    pub text: Option<String>,
    pub original: Option<String>,
    pub translation: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub used_fallback: bool,
    pub attempts: Vec<ProviderAttempt>,
    pub error_kind: Option<String>,
    pub error_status: Option<u16>,
    pub error_summary: Option<String>,
}

#[derive(Debug, Clone)]
struct Candidate {
    provider: String,
    base_url: String,
    model: String,
    is_fallback: bool,
}

#[derive(Debug)]
struct Failure {
    kind: String,
    status: Option<u16>,
    summary: String,
}

impl Failure {
    fn missing_key() -> Self {
        Self {
            kind: "missing_key".into(),
            status: None,
            summary: "API Key 未配置。".into(),
        }
    }

    fn unsupported() -> Self {
        Self {
            kind: "unsupported".into(),
            status: None,
            summary: "当前 Provider 不支持此操作。".into(),
        }
    }

    fn from_status(status: StatusCode) -> Self {
        let code = status.as_u16();
        let kind = if code == 429 {
            "rate_limited"
        } else if code >= 500 {
            "server_error"
        } else if code >= 400 {
            "client_error"
        } else {
            "unknown"
        };
        Self {
            kind: kind.into(),
            status: Some(code),
            summary: match kind {
                "rate_limited" => "Provider 请求被限流。".into(),
                "server_error" => "Provider 服务端异常。".into(),
                "client_error" => "Provider 拒绝了请求。".into(),
                _ => "Provider 请求失败。".into(),
            },
        }
    }

    fn network() -> Self {
        Self {
            kind: "network".into(),
            status: None,
            summary: "网络连接失败。".into(),
        }
    }

    fn timeout() -> Self {
        Self {
            kind: "timeout".into(),
            status: None,
            summary: "请求超时。".into(),
        }
    }

    fn empty() -> Self {
        Self {
            kind: "empty_response".into(),
            status: None,
            summary: "Provider 返回为空。".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActiveRequest {
    pub window_label: String,
    pub handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    // A request ID is supplied by the renderer, so it is not sufficient as a
    // cleanup identity.  This token prevents an old task from removing a new
    // request that reused the same ID.
    pub token: Arc<()>,
}

impl ActiveRequest {
    pub fn abort(&self) {
        let mut handle = self
            .handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(handle) = handle.take() {
            handle.abort();
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProviderState {
    pub active: Arc<Mutex<HashMap<String, ActiveRequest>>>,
    pub rate_windows: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
    reservations: Arc<AtomicUsize>,
}

impl ProviderState {
    pub fn reserve(&self, max: usize) -> bool {
        self.reservations
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < max).then_some(value + 1)
            })
            .is_ok()
    }

    pub fn release(&self) {
        let _ = self
            .reservations
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                Some(value.saturating_sub(1))
            });
    }

    pub fn cancel_window(&self, window_label: &str) {
        let existing: Vec<String> = self
            .active
            .lock()
            .map(|items| {
                items
                    .iter()
                    .filter(|(_, item)| item.window_label == window_label)
                    .map(|(id, _)| id.clone())
                    .collect()
            })
                .unwrap_or_default();
        if let Ok(mut items) = self.active.lock() {
            for id in existing {
                if let Some(item) = items.remove(&id) {
                    self.release();
                    item.abort();
                }
            }
        }
    }

    pub fn allow(&self, provider: &str, operation: &str) -> bool {
        let (limit, burst) = match operation {
            "vision_translate" | "vision_recognize" => (4usize, 1usize),
            "test" => (3usize, 1usize),
            _ => (20usize, 3usize),
        };
        let key = format!("{provider}:{operation}");
        let now = Instant::now();
        let mut windows = match self.rate_windows.lock() {
            Ok(value) => value,
            Err(_) => return false,
        };
        let history = windows.entry(key).or_default();
        while history
            .front()
            .is_some_and(|time| now.duration_since(*time) >= Duration::from_secs(60))
        {
            history.pop_front();
        }
        let interval = Duration::from_secs_f64(60.0 / limit as f64);
        let allowed = history.len() < limit
            && (history.len() < burst
                || history
                    .back()
                    .is_some_and(|last| now.duration_since(*last) >= interval));
        if allowed {
            history.push_back(now);
        }
        allowed
    }
}

pub fn validate_request(request: &TranslationRequest) -> Result<(), String> {
    if request.request_id.trim().is_empty()
        || request.request_id.len() > 128
        || !request.request_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("请求 ID 无效。".into());
    }
    if !matches!(request.operation.as_str(), "text" | "vision_translate" | "vision_recognize" | "test") {
        return Err("请求操作无效。".into());
    }
    if request.system_prompt.len() > 20_000
        || request
            .user_prompt
            .as_ref()
            .is_some_and(|v| v.len() > MAX_TEXT_CHARS + 20_000)
    {
        return Err("翻译请求内容过大。".into());
    }
    if request.fallback_models.len() > MAX_FALLBACK_MODELS
        || request.fallback_provider_order.len() > MAX_FALLBACK_PROVIDERS
        || request.provider_configs.len() > MAX_FALLBACK_PROVIDERS
    {
        return Err("备用 Provider 配置过多。".into());
    }
    for model in &request.fallback_models {
        if !valid_model(model) {
            return Err("备用模型名无效。".into());
        }
    }
    for provider in &request.fallback_provider_order {
        if !is_provider(provider) {
            return Err("备用 Provider 无效。".into());
        }
    }
    for (provider, config) in &request.provider_configs {
        if config.base_url.len() > 512 || config.model.len() > 200 {
            return Err("备用 Provider 配置过大。".into());
        }
        validate_provider_config(provider, &config.base_url, &config.model)?;
    }
    if let Some(data_url) = &request.image_data_url {
        let (_, bytes) = split_image_data_url(data_url).map_err(|_| "图片数据格式无效。".to_string())?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("图片大小超过 20 MB 限制。".into());
        }
    }
    if request.user_prompt.is_none() && request.image_data_url.is_none() {
        return Err("翻译输入为空。".into());
    }
    validate_provider_config(&request.provider, &request.base_url, &request.model)?;
    Ok(())
}

pub async fn run_request(
    app: AppHandle,
    window_label: String,
    request: TranslationRequest,
    state: Arc<ProviderState>,
) {
    let candidates = build_candidates(&request);
    let mut attempts = Vec::new();
    let mut last_failure: Option<Failure> = None;

    for candidate in candidates {
        if matches!(request.operation.as_str(), "vision_translate" | "vision_recognize")
            && !supports_vision(&candidate.provider)
        {
            let failure = Failure::unsupported();
            attempts.push(attempt_from_failure(&candidate, 0, &failure, "skipped"));
            last_failure = Some(failure);
            continue;
        }

        let key = match provider_key(&candidate.provider) {
            Ok(entry) => match entry.get_password() {
                Ok(value) if !value.is_empty() => zeroize::Zeroizing::new(value),
                Ok(_) | Err(keyring::Error::NoEntry) => {
                    let failure = Failure::missing_key();
                    attempts.push(attempt_from_failure(&candidate, 0, &failure, "skipped"));
                    last_failure = Some(failure);
                    continue;
                }
                Err(_) => {
                    let failure = Failure::network();
                    attempts.push(attempt_from_failure(&candidate, 0, &failure, "error"));
                    last_failure = Some(failure);
                    continue;
                }
            },
            Err(_) => {
                let failure = Failure::unknown();
                attempts.push(attempt_from_failure(&candidate, 0, &failure, "error"));
                last_failure = Some(failure);
                continue;
            }
        };

        if !state.allow(&candidate.provider, &request.operation) {
            let failure = Failure {
                kind: "rate_limited".into(),
                status: Some(429),
                summary: "本地请求频率已达上限，请稍后重试。".into(),
            };
            attempts.push(attempt_from_failure(&candidate, 0, &failure, "error"));
            last_failure = Some(failure);
            continue;
        }

        let started = Instant::now();
        let emit_chunk = |delta: String| {
            emit(
                &app,
                &window_label,
                TranslationEvent {
                    request_id: request.request_id.clone(),
                    phase: "chunk".into(),
                    delta: Some(delta),
                    text: None,
                    original: None,
                    translation: None,
                    provider: Some(candidate.provider.clone()),
                    model: Some(candidate.model.clone()),
                    used_fallback: candidate.is_fallback,
                    attempts: attempts.clone(),
                    error_kind: None,
                    error_status: None,
                    error_summary: None,
                },
            );
        };
        let result = tokio::time::timeout(
            REQUEST_TIMEOUT,
            call_candidate(&request, &candidate, &key, &emit_chunk),
        )
        .await;

        match result {
            Ok(Ok(output)) => {
                let duration = started.elapsed().as_millis() as u64;
                let attempt = ProviderAttempt {
                    provider: candidate.provider.clone(),
                    model: candidate.model.clone(),
                    status: "success".into(),
                    duration_ms: duration,
                    is_fallback: candidate.is_fallback,
                    error_kind: None,
                    error_summary: None,
                };
                attempts.push(attempt);
                emit(
                    &app,
                    &window_label,
                    success_event(&request, &candidate, output, attempts.clone()),
                );
                return;
            }
            Ok(Err(failure)) => {
                let duration = started.elapsed().as_millis() as u64;
                attempts.push(attempt_from_failure(&candidate, duration, &failure, "error"));
                last_failure = Some(failure);
            }
            Err(_) => {
                let failure = Failure::timeout();
                let duration = started.elapsed().as_millis() as u64;
                attempts.push(attempt_from_failure(&candidate, duration, &failure, "error"));
                last_failure = Some(failure);
            }
        }
    }

    let failure = last_failure.unwrap_or_else(Failure::empty);
    emit(
        &app,
        &window_label,
        TranslationEvent {
            request_id: request.request_id,
            phase: "error".into(),
            delta: None,
            text: None,
            original: None,
            translation: None,
            provider: None,
            model: None,
            used_fallback: false,
            attempts,
            error_kind: Some(failure.kind),
            error_status: failure.status,
            error_summary: Some(failure.summary),
        },
    );
}

fn build_candidates(request: &TranslationRequest) -> Vec<Candidate> {
    let mut result = Vec::new();
    let mut add = |provider: String, base_url: String, model: String, is_fallback: bool| {
        if provider.trim().is_empty() || model.trim().is_empty() || base_url.trim().is_empty() {
            return;
        }
        if validate_provider_config(&provider, &base_url, &model).is_err() {
            return;
        }
        if result.iter().any(|item: &Candidate| {
            item.provider == provider && item.base_url == base_url && item.model == model
        }) {
            return;
        }
        result.push(Candidate { provider, base_url, model, is_fallback });
    };

    add(request.provider.clone(), request.base_url.clone(), request.model.clone(), false);
    if !request.fallback_enabled {
        return result;
    }
    for model in request.fallback_models.iter().map(|item| item.trim()).filter(|item| !item.is_empty()) {
        add(request.provider.clone(), request.base_url.clone(), model.to_string(), true);
    }
    for provider in &request.fallback_provider_order {
        let Some(config) = request.provider_configs.get(provider) else { continue };
        add(provider.clone(), config.base_url.clone(), config.model.clone(), true);
    }
    result
}

fn provider_key(provider: &str) -> Result<Entry, String> {
    if !is_provider(provider) {
        return Err("Provider 无效。".into());
    }
    Entry::new(KEYRING_SERVICE, &format!("apikey.{provider}")).map_err(|e| e.to_string())
}

pub fn set_secret(provider: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_API_KEY_BYTES || value.chars().any(char::is_control) {
        return Err("API Key 格式或长度无效。".into());
    }
    let entry = provider_key(provider)?;
    if value.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("删除密钥失败: {error}")),
        };
    }
    entry
        .set_password(value)
        .map_err(|error| format!("保存密钥失败: {error}"))
}

pub fn has_secret(provider: &str) -> Result<bool, String> {
    let entry = provider_key(provider)?;
    match entry.get_password() {
        Ok(value) => Ok(!zeroize::Zeroizing::new(value).is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("读取密钥状态失败: {error}")),
    }
}

pub fn is_supported_provider(provider: &str) -> bool {
    is_provider(provider)
}

pub fn migrate_role_secret(old_key: &str, provider: &str) -> Result<(), String> {
    if !matches!(old_key, "apiKey" | "recognizeApiKey") {
        return Err("旧密钥类型无效。".into());
    }
    let old = Entry::new(KEYRING_SERVICE, old_key).map_err(|error| error.to_string())?;
    let value = match old.get_password() {
        Ok(value) if !value.is_empty() => zeroize::Zeroizing::new(value),
        Ok(_) | Err(keyring::Error::NoEntry) => return Ok(()),
        Err(error) => return Err(format!("读取旧密钥失败: {error}")),
    };
    if !has_secret(provider)? {
        set_secret(provider, value.as_str())?;
    }
    match old.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除旧密钥失败: {error}")),
    }
}

fn is_provider(value: &str) -> bool {
    matches!(value, "deepseek" | "openai" | "claude" | "gemini" | "qwen" | "grok" | "minimax")
}

fn supports_vision(value: &str) -> bool {
    matches!(value, "openai" | "claude" | "gemini" | "qwen" | "grok")
}

fn validate_provider_config(provider: &str, base_url: &str, model: &str) -> Result<(), String> {
    if !is_provider(provider) {
        return Err("Provider 无效。".into());
    }
    if !valid_model(model) { return Err("模型名无效。".into()); }
    if base_url.len() > 512 { return Err("Base URL 过长。".into()); }
    let url = reqwest::Url::parse(base_url.trim()).map_err(|_| "Base URL 无效。".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Base URL 必须是无凭据的 HTTPS 地址。".into());
    }
    let host = url.host_str().unwrap_or_default();
    let expected = match provider {
        "deepseek" => host == "api.deepseek.com",
        "openai" => host == "api.openai.com",
        "claude" => host == "api.anthropic.com",
        "gemini" => host == "generativelanguage.googleapis.com",
        "qwen" => host == "dashscope.aliyuncs.com" || host == "dashscope-intl.aliyuncs.com",
        "grok" => host == "api.x.ai",
        "minimax" => host == "api.minimax.chat",
        _ => false,
    };
    if !expected {
        return Err("当前 Provider 只允许访问其官方 HTTPS 域名。".into());
    }
    Ok(())
}

fn valid_model(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 200
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b'-' | b':' | b'@')
        })
}

async fn call_candidate(
    request: &TranslationRequest,
    candidate: &Candidate,
    api_key: &str,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> std::result::Result<Output, Failure> {
    match request.operation.as_str() {
        "text" | "test" => call_text(request, candidate, api_key, on_chunk).await.map(Output::Text),
        "vision_translate" => call_vision(request, candidate, api_key).await.map(|value| Output::Vision(value.0, value.1)),
        "vision_recognize" => call_vision(request, candidate, api_key).await.map(|value| Output::Text(value.0)),
        _ => Err(Failure::unsupported()),
    }
}

enum Output {
    Text(String),
    Vision(String, String),
}

async fn call_text(
    request: &TranslationRequest,
    candidate: &Candidate,
    api_key: &str,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> std::result::Result<String, Failure> {
    if candidate.provider == "gemini" {
        return call_gemini(request, candidate, api_key, true, on_chunk).await;
    }
    if candidate.provider == "claude" {
        return call_claude(request, candidate, api_key, true, on_chunk).await;
    }
    call_openai_compatible(request, candidate, api_key, true, on_chunk).await
}

async fn call_openai_compatible(
    request: &TranslationRequest,
    candidate: &Candidate,
    api_key: &str,
    stream: bool,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> std::result::Result<String, Failure> {
    let path = if candidate.provider == "minimax" {
        "/text/chatcompletion_v2"
    } else {
        "/chat/completions"
    };
    let url = format!("{}{path}", candidate.base_url.trim_end_matches('/'));
    let body = json!({
        "model": candidate.model,
        "temperature": 0.3,
        "stream": stream,
        "messages": [
            { "role": "system", "content": request.system_prompt },
            { "role": "user", "content": request.user_prompt.clone().unwrap_or_default() }
        ]
    });
    let client = client()?;
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("Accept", if stream { "text/event-stream" } else { "application/json" })
        .json(&body)
        .send()
        .await
        .map_err(|error| if error.is_timeout() { Failure::timeout() } else { Failure::network() })?;
    ensure_success(&response)?;
    if stream {
        read_sse(response, candidate.provider.as_str(), on_chunk).await
    } else {
        let value = read_json(response).await?;
        let text = value.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if text.is_empty() { Err(Failure::empty()) } else { Ok(text) }
    }
}

async fn call_claude(
    request: &TranslationRequest,
    candidate: &Candidate,
    api_key: &str,
    stream: bool,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> std::result::Result<String, Failure> {
    let url = format!("{}/messages", candidate.base_url.trim_end_matches('/'));
    let body = json!({
        "model": candidate.model,
        "max_tokens": 4096,
        "stream": stream,
        "system": request.system_prompt,
        "messages": [{ "role": "user", "content": request.user_prompt.clone().unwrap_or_default() }]
    });
    let client = client()?;
    let response = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .header("Accept", if stream { "text/event-stream" } else { "application/json" })
        .json(&body)
        .send()
        .await
        .map_err(|error| if error.is_timeout() { Failure::timeout() } else { Failure::network() })?;
    ensure_success(&response)?;
    if stream {
        read_sse(response, "claude", on_chunk).await
    } else {
        let value = read_json(response).await?;
        let text = value.pointer("/content/0/text").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if text.is_empty() { Err(Failure::empty()) } else { Ok(text) }
    }
}

async fn call_gemini(
    request: &TranslationRequest,
    candidate: &Candidate,
    api_key: &str,
    stream: bool,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> std::result::Result<String, Failure> {
    let method = if stream { "streamGenerateContent" } else { "generateContent" };
    let query = if stream { "?alt=sse" } else { "" };
    let url = format!("{}/models/{}:{}{}", candidate.base_url.trim_end_matches('/'), candidate.model, method, query);
    let body = json!({
        "systemInstruction": { "parts": [{ "text": request.system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": request.user_prompt.clone().unwrap_or_default() }] }],
        "generationConfig": { "temperature": 0.3 }
    });
    let client = client()?;
    let response = client
        .post(url)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .header("Accept", if stream { "text/event-stream" } else { "application/json" })
        .json(&body)
        .send()
        .await
        .map_err(|error| if error.is_timeout() { Failure::timeout() } else { Failure::network() })?;
    ensure_success(&response)?;
    if stream {
        read_sse(response, "gemini", on_chunk).await
    } else {
        let value = read_json(response).await?;
        let text = value.pointer("/candidates/0/content/parts/0/text").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if text.is_empty() { Err(Failure::empty()) } else { Ok(text) }
    }
}

async fn call_vision(
    request: &TranslationRequest,
    candidate: &Candidate,
    api_key: &str,
) -> std::result::Result<(String, String), Failure> {
    let image = request.image_data_url.as_deref().ok_or_else(Failure::empty)?;
    let (media_type, base64_image) = split_image_data_url(image).map_err(|_| Failure::network())?;
    let user_text = request.user_prompt.clone().unwrap_or_else(|| "Transcribe the text in this image.".into());
    let value = if candidate.provider == "claude" {
        let url = format!("{}/messages", candidate.base_url.trim_end_matches('/'));
        let body = json!({
            "model": candidate.model,
            "max_tokens": 4096,
            "system": request.system_prompt,
            "messages": [{ "role": "user", "content": [
                { "type": "image", "source": { "type": "base64", "media_type": media_type, "data": base64_image } },
                { "type": "text", "text": user_text }
            ] }]
        });
        let client = client()?;
        let response = client.post(url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body).send().await
            .map_err(|error| if error.is_timeout() { Failure::timeout() } else { Failure::network() })?;
        ensure_success(&response)?;
        read_json(response).await?
    } else if candidate.provider == "gemini" {
        let url = format!("{}/models/{}:generateContent", candidate.base_url.trim_end_matches('/'), candidate.model);
        let body = json!({
            "systemInstruction": { "parts": [{ "text": request.system_prompt }] },
            "contents": [{ "role": "user", "parts": [
                { "text": user_text },
                { "inlineData": { "mimeType": media_type, "data": base64_image } }
            ] }],
            "generationConfig": { "temperature": 0.2, "responseMimeType": "application/json" }
        });
        let client = client()?;
        let response = client.post(url)
            .header("x-goog-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&body).send().await
            .map_err(|error| if error.is_timeout() { Failure::timeout() } else { Failure::network() })?;
        ensure_success(&response)?;
        read_json(response).await?
    } else {
        let url = format!("{}{}/chat/completions", candidate.base_url.trim_end_matches('/'), if candidate.base_url.ends_with("/v1") { "" } else { "/v1" });
        let body = json!({
            "model": candidate.model,
            "temperature": 0.2,
            "response_format": { "type": "json_object" },
            "messages": [
                { "role": "system", "content": request.system_prompt },
                { "role": "user", "content": [
                    { "type": "text", "text": user_text },
                    { "type": "image_url", "image_url": { "url": image } }
                ] }
            ]
        });
        let client = client()?;
        let response = client.post(url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&body).send().await
            .map_err(|error| if error.is_timeout() { Failure::timeout() } else { Failure::network() })?;
        ensure_success(&response)?;
        read_json(response).await?
    };
    let content = extract_content(&value).ok_or_else(Failure::empty)?;
    parse_vision_result(&content)
}

fn ensure_success(response: &Response) -> std::result::Result<(), Failure> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(Failure::from_status(response.status()))
    }
}

fn client() -> std::result::Result<Client, Failure> {
    Client::builder()
        .use_rustls_tls()
        .timeout(REQUEST_TIMEOUT)
        // Provider APIs and release assets must not be able to redirect user
        // content or credentials to an unvalidated host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Failure::network())
}

async fn read_json(mut response: Response) -> std::result::Result<Value, Failure> {
    let bytes = read_limited(&mut response, MAX_RESPONSE_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| Failure::network())
}

async fn read_limited(response: &mut Response, max_bytes: usize) -> std::result::Result<Vec<u8>, Failure> {
    if response.content_length().is_some_and(|length| length > max_bytes as u64) {
        return Err(Failure::network());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::network())? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(Failure::network());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_sse(
    mut response: Response,
    provider: &str,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> std::result::Result<String, Failure> {
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
        return Err(Failure::network());
    }
    let mut buffer = String::new();
    let mut full = String::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::network())? {
        if buffer.len().saturating_add(full.len()).saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(Failure::network());
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        if buffer.len() > MAX_RESPONSE_BYTES {
            return Err(Failure::network());
        }
        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].trim().to_string();
            buffer.drain(..=index);
            if let Some(payload) = line.strip_prefix("data:") {
                let payload = payload.trim();
                if payload.is_empty() || payload == "[DONE]" { continue; }
                if let Ok(value) = serde_json::from_str::<Value>(payload) {
                    if let Some(text) = extract_stream_delta(&value, provider) {
                        if full.chars().count().saturating_add(text.chars().count()) > MAX_OUTPUT_CHARS {
                            return Err(Failure::network());
                        }
                        full.push_str(&text);
                        on_chunk(text);
                    }
                }
            }
        }
    }
    if !buffer.trim().is_empty() {
        if let Some(payload) = buffer.trim().strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                if let Some(text) = extract_stream_delta(&value, provider) {
                    if full.chars().count().saturating_add(text.chars().count()) > MAX_OUTPUT_CHARS {
                        return Err(Failure::network());
                    }
                    full.push_str(&text);
                    on_chunk(text);
                }
            }
        }
    }
    let output = full.trim().to_string();
    if output.is_empty() { Err(Failure::empty()) } else { Ok(output) }
}

fn extract_stream_delta(value: &Value, provider: &str) -> Option<String> {
    let pointer = match provider {
        "claude" => "/delta/text",
        _ => "/choices/0/delta/content",
    };
    value.pointer(pointer).and_then(Value::as_str).map(ToString::to_string).or_else(|| {
        value.pointer("/candidates/0/content/parts/0/text").and_then(Value::as_str).map(ToString::to_string)
    })
}

fn extract_content(value: &Value) -> Option<String> {
    value.pointer("/choices/0/message/content").and_then(Value::as_str).map(ToString::to_string).or_else(|| {
        value.pointer("/content/0/text").and_then(Value::as_str).map(ToString::to_string)
    }).or_else(|| {
        value.pointer("/candidates/0/content/parts/0/text").and_then(Value::as_str).map(ToString::to_string)
    })
}

fn parse_vision_result(content: &str) -> std::result::Result<(String, String), Failure> {
    if content.chars().count() > MAX_OUTPUT_CHARS {
        return Err(Failure::network());
    }
    let cleaned = content.trim().trim_matches('`').trim();
    if let Ok(value) = serde_json::from_str::<Value>(cleaned) {
        let original = value.get("original").and_then(Value::as_str).or_else(|| value.get("source").and_then(Value::as_str)).unwrap_or_default().to_string();
        let translation = value.get("translation").and_then(Value::as_str).or_else(|| value.get("translated").and_then(Value::as_str)).unwrap_or_default().to_string();
        if original.chars().count() > MAX_OUTPUT_CHARS || translation.chars().count() > MAX_OUTPUT_CHARS {
            return Err(Failure::network());
        }
        if !original.trim().is_empty() || !translation.trim().is_empty() {
            return Ok((original, translation));
        }
    }
    if cleaned.is_empty() { Err(Failure::empty()) } else { Ok((cleaned.to_string(), cleaned.to_string())) }
}

fn split_image_data_url(value: &str) -> Result<(&str, Vec<u8>)> {
    if value.len() > MAX_IMAGE_DATA_URL_CHARS {
        return Err(anyhow!("image data too large"));
    }
    let (header, encoded) = value.split_once(',').ok_or_else(|| anyhow!("invalid image data"))?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|rest| rest.strip_suffix(";base64"))
        .ok_or_else(|| anyhow!("invalid image data"))?;
    if !matches!(media_type, "image/png" | "image/jpeg" | "image/webp" | "image/bmp" | "image/gif") {
        return Err(anyhow!("unsupported image type"));
    }
    let bytes = STANDARD.decode(encoded.trim()).map_err(|_| anyhow!("invalid image data"))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES { return Err(anyhow!("image too large")); }
    let valid_magic = match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    };
    if !valid_magic { return Err(anyhow!("invalid image content")); }
    Ok((media_type, bytes))
}

fn emit(app: &AppHandle, window_label: &str, event: TranslationEvent) {
    let _ = app.emit_to(window_label, EVENT_NAME, event);
}

fn success_event(request: &TranslationRequest, candidate: &Candidate, output: Output, attempts: Vec<ProviderAttempt>) -> TranslationEvent {
    match output {
        Output::Text(text) => TranslationEvent {
            request_id: request.request_id.clone(), phase: "complete".into(), delta: None,
            text: Some(text), original: None, translation: None,
            provider: Some(candidate.provider.clone()), model: Some(candidate.model.clone()),
            used_fallback: candidate.is_fallback, attempts,
            error_kind: None, error_status: None, error_summary: None,
        },
        Output::Vision(original, translation) => TranslationEvent {
            request_id: request.request_id.clone(), phase: "complete".into(), delta: None,
            text: None, original: Some(original), translation: Some(translation),
            provider: Some(candidate.provider.clone()), model: Some(candidate.model.clone()),
            used_fallback: candidate.is_fallback, attempts,
            error_kind: None, error_status: None, error_summary: None,
        },
    }
}

fn attempt_from_failure(candidate: &Candidate, duration_ms: u64, failure: &Failure, status: &str) -> ProviderAttempt {
    ProviderAttempt {
        provider: candidate.provider.clone(), model: candidate.model.clone(), status: status.into(),
        duration_ms, is_fallback: candidate.is_fallback,
        error_kind: Some(failure.kind.clone()), error_summary: Some(failure.summary.clone()),
    }
}

impl Failure {
    fn unknown() -> Self {
        Self { kind: "unknown".into(), status: None, summary: "未知 Provider 错误。".into() }
    }
}

#[allow(dead_code)]
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_official_or_redirectable_provider_urls() {
        assert!(validate_provider_config("openai", "https://api.openai.com/v1", "gpt-4o-mini").is_ok());
        assert!(validate_provider_config("openai", "http://api.openai.com/v1", "gpt-4o-mini").is_err());
        assert!(validate_provider_config("openai", "https://evil.example/v1", "gpt-4o-mini").is_err());
        assert!(validate_provider_config("openai", "https://api.openai.com/v1?next=https://evil.example", "gpt-4o-mini").is_err());
        assert!(validate_provider_config("openai", "https://api.openai.com/v1", "gpt?next=evil").is_err());
    }

    #[test]
    fn validates_image_type_and_size() {
        let png = format!("data:image/png;base64,{}", STANDARD.encode(b"\x89PNG\r\n\x1a\n"));
        assert!(split_image_data_url(&png).is_ok());
        let fake = format!("data:image/png;base64,{}", STANDARD.encode(b"not png"));
        assert!(split_image_data_url(&fake).is_err());
    }
}
