mod capture;
mod ocr;
mod popup;
mod provider;
mod secure_store;
mod selection;
mod shortcut;
mod update;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::process::Command;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";
const DEFAULT_HOTKEY: &str = "Alt+Q";
const DEFAULT_CAPTURE_HOTKEY: &str = "Alt+S";
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_CHARS: usize = 30 * 1024 * 1024;
const MAX_DIAGNOSTIC_VERSION_CHARS: usize = 128;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticSnapshot {
    app_version: String,
    platform: String,
    arch: String,
    tesseract_available: bool,
    tesseract_version: Option<String>,
    tesseract_error: Option<String>,
}

fn read_setting_string(app: &AppHandle, key: &str, default: &str) -> String {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(Value::Object(map)) = store.get(SETTINGS_KEY) {
            if let Some(Value::String(s)) = map.get(key) {
                if !s.trim().is_empty() {
                    return s.clone();
                }
            }
        }
    }
    default.to_string()
}

fn read_hotkey(app: &AppHandle) -> String {
    read_setting_string(app, "hotkey", DEFAULT_HOTKEY)
}

fn read_capture_hotkey(app: &AppHandle) -> String {
    read_setting_string(app, "captureHotkey", DEFAULT_CAPTURE_HOTKEY)
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[tauri::command]
async fn reload_shortcuts(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_main(&window)?;
    let translate = read_hotkey(&app);
    let capture = read_capture_hotkey(&app);
    shortcut::reregister(&app, &translate, &capture).map_err(|e| e.to_string())
}

/// Temporarily unregister all global shortcuts so they don't fire while the
/// user is recording a new combination in the settings UI. Restored by a
/// subsequent `reload_shortcuts` call.
#[tauri::command]
async fn suspend_shortcuts(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_main(&window)?;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn hide_popup(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_allowed(&window, &["main", "popup"])?;
    popup::hide_popup(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn show_main(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_allowed(&window, &["main", "popup", "capture"])?;
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
async fn start_capture(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_main(&window)?;
    capture::begin_capture(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn finish_capture(window: WebviewWindow, app: AppHandle, data_url: String) -> Result<(), String> {
    require_allowed(&window, &["overlay"])?;
    decode_image_data_url(&data_url)?;
    capture::finish_capture(&app, data_url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_capture(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_allowed(&window, &["overlay"])?;
    capture::cancel_capture(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn hide_capture(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_allowed(&window, &["capture"])?;
    capture::hide_capture(&app).map_err(|e| e.to_string())
}

fn decode_image_data_url(image: &str) -> Result<Vec<u8>, String> {
    if image.len() > MAX_IMAGE_DATA_URL_CHARS {
        return Err("图片数据超过大小限制。".into());
    }
    let (header, b64) = image
        .split_once(',')
        .ok_or_else(|| "图片数据格式无效。".to_string())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/bmp" | "image/gif") {
        return Err("只支持常见图片格式。".into());
    }
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|_| "图片解码失败。".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片大小无效。".into());
    }
    let valid_magic = match mime.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    };
    if !valid_magic {
        return Err("图片内容与声明格式不匹配。".into());
    }
    Ok(bytes)
}

/// OCR mode B: run Windows OCR on a base64 image (data URL or bare base64).
/// Returns structured OCR text. `lang` is an optional BCP-47 tag.
#[tauri::command]
async fn ocr_windows(window: WebviewWindow, image: String, lang: Option<String>) -> Result<ocr::OcrResult, String> {
    require_allowed(&window, &["capture"])?;
    let bytes = decode_image_data_url(&image)?;
    let lang = lang.filter(|s| !s.trim().is_empty());
    tauri::async_runtime::spawn_blocking(move || ocr::recognize_windows(&bytes, lang.as_deref()))
        .await
        .map_err(|e| format!("OCR 线程错误: {e}"))?
        .map_err(|e| e.to_string())
}

/// OCR mode C: run local Tesseract OCR on a base64 image.
#[tauri::command]
async fn ocr_tesseract(window: WebviewWindow, image: String, lang: Option<String>) -> Result<ocr::OcrResult, String> {
    require_allowed(&window, &["capture"])?;
    let bytes = decode_image_data_url(&image)?;
    let lang = lang.filter(|s| !s.trim().is_empty());
    tauri::async_runtime::spawn_blocking(move || ocr::recognize_tesseract(&bytes, lang.as_deref()))
        .await
        .map_err(|e| format!("OCR 线程错误: {e}"))?
        .map_err(|e| e.to_string())
}

// ---- Restricted native gateway ----

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("该操作只能由主窗口发起。".into())
    }
}

fn require_allowed(window: &WebviewWindow, allowed: &[&str]) -> Result<(), String> {
    if allowed.iter().any(|label| *label == window.label()) {
        Ok(())
    } else {
        Err("当前窗口无权执行该操作。".into())
    }
}

#[tauri::command]
async fn migrate_legacy_secrets(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_main(&window)?;
    let store = app
        .store(STORE_FILE)
        .map_err(|error| format!("打开设置失败: {error}"))?;
    let Some(Value::Object(mut map)) = store.get(SETTINGS_KEY) else {
        provider::migrate_role_secret("apiKey", "deepseek")?;
        provider::migrate_role_secret("recognizeApiKey", "qwen")?;
        return Ok(());
    };
    let provider_name = map
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| provider::is_supported_provider(value))
        .unwrap_or("deepseek")
        .to_string();
    let recognize_provider = map
        .get("recognizeProvider")
        .and_then(Value::as_str)
        .filter(|value| provider::is_supported_provider(value))
        .unwrap_or("qwen")
        .to_string();
    let legacy_roles = vec![
        ("apiKey".to_string(), provider_name),
        ("recognizeApiKey".to_string(), recognize_provider),
    ];
    let mut legacy_secrets = Vec::new();
    let mut changed = false;
    for (field, provider_name) in &legacy_roles {
        if let Some(Value::String(value)) = map.remove(field) {
            if !value.is_empty() {
                legacy_secrets.push((field.clone(), provider_name.clone(), zeroize::Zeroizing::new(value)));
            }
            changed = true;
        }
    }
    // Remove legacy plaintext before touching keyring.  If keyring access
    // fails after this point, the app may require the user to enter the key
    // again, but it will not leave the old value in settings.json.
    if changed {
        store
            .set(SETTINGS_KEY, Value::Object(map));
        store
            .save()
            .map_err(|_| "无法安全清理旧版凭证，请重试。".to_string())?;
    }
    for (field, provider_name) in legacy_roles {
        if let Some((_, _, value)) = legacy_secrets.iter().find(|(old_field, _, _)| old_field == &field) {
            if !provider::has_secret(&provider_name)? {
                provider::set_secret(&provider_name, value.as_str())?;
            }
        }
        provider::migrate_role_secret(&field, &provider_name)?;
    }
    Ok(())
}

#[tauri::command]
async fn set_provider_secret(
    window: WebviewWindow,
    provider: String,
    value: String,
) -> Result<(), String> {
    require_main(&window)?;
    if value.len() > 512 {
        return Err("API Key 长度超过限制。".into());
    }
    provider::set_secret(&provider, &value)
}

#[tauri::command]
async fn provider_secret_status(window: WebviewWindow, provider: String) -> Result<bool, String> {
    require_main(&window)?;
    provider::has_secret(&provider)
}

#[tauri::command]
async fn start_translation(
    window: WebviewWindow,
    app: AppHandle,
    request: provider::TranslationRequest,
    state: State<'_, provider::ProviderState>,
) -> Result<(), String> {
    if !matches!(window.label(), "main" | "popup" | "capture") {
        return Err("该窗口不允许发起翻译请求。".into());
    }
    provider::validate_request(&request)?;
    state.cancel_window(window.label());
    if state
        .active
        .lock()
        .map_err(|_| "请求状态不可用。".to_string())?
        .contains_key(&request.request_id)
    {
        return Err("请求 ID 已存在。".into());
    }
    if !state.reserve(2) {
        return Err("当前已有太多进行中的请求，请稍后重试。".into());
    }

    let request_id = request.request_id.clone();
    let cleanup_id = request_id.clone();
    let request_token = std::sync::Arc::new(());
    let cleanup_token = request_token.clone();
    let window_label = window.label().to_string();
    let active = state.active.clone();
    let shared = std::sync::Arc::new(state.inner().clone());
    let reservations = state.inner().clone();
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        provider::run_request(app, window_label.clone(), request, shared).await;
        let removed = active
            .lock()
            .map(|mut requests| {
                if requests
                    .get(&cleanup_id)
                    .is_some_and(|item| std::sync::Arc::ptr_eq(&item.token, &cleanup_token))
                {
                    requests.remove(&cleanup_id).is_some()
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if removed {
            reservations.release();
        }
    });
    let cell = std::sync::Arc::new(std::sync::Mutex::new(Some(task)));
    let mut requests = match state.active.lock() {
        Ok(requests) => requests,
        Err(_) => {
            state.release();
            let item = provider::ActiveRequest {
                window_label: window.label().to_string(),
                handle: cell,
                token: request_token,
            };
            item.abort();
            return Err("请求状态不可用。".into());
        }
    };
    requests.insert(
        request_id.clone(),
        provider::ActiveRequest {
            window_label: window.label().to_string(),
            handle: cell,
            token: request_token,
        },
    );
    if start_tx.send(()).is_err() {
        if let Some(item) = requests.remove(&request_id) {
            state.release();
            item.abort();
        }
        return Err("请求启动失败。".into());
    }
    Ok(())
}

#[tauri::command]
async fn cancel_translation(
    window: WebviewWindow,
    request_id: String,
    state: State<'_, provider::ProviderState>,
) -> Result<(), String> {
    if !matches!(window.label(), "main" | "popup" | "capture") {
        return Err("该窗口不允许取消翻译请求。".into());
    }
    let item = {
        let mut requests = state
            .active
            .lock()
            .map_err(|_| "请求状态不可用。".to_string())?;
        if let Some(item) = requests.get(&request_id) {
            if item.window_label != window.label() {
                return Err("无权取消其他窗口的请求。".into());
            }
        }
        requests.remove(&request_id)
    };
    if let Some(item) = item {
        state.release();
        item.abort();
    }
    Ok(())
}

#[tauri::command]
async fn check_for_updates(window: WebviewWindow, app: AppHandle) -> Result<update::UpdateCheckResult, String> {
    if window.label() != "main" {
        return Err("该操作只能由主窗口发起。".into());
    }
    let current = app.package_info().version.to_string();
    let state = app
        .try_state::<update::UpdateState>()
        .ok_or_else(|| "更新状态不可用。".to_string())?;
    state.allow_check()?;
    update::check_update_async(&current)
        .await
        .map_err(|_| "更新检查失败。".to_string())
}

#[tauri::command]
async fn download_verified_update(
    window: WebviewWindow,
    app: AppHandle,
    version: String,
    state: State<'_, update::UpdateState>,
) -> Result<update::VerifiedUpdate, String> {
    update::download_verified(&window, &app, &state, version).await
}

#[tauri::command]
async fn launch_verified_update(
    window: WebviewWindow,
    version: String,
    state: State<'_, update::UpdateState>,
) -> Result<(), String> {
    update::launch_verified(&window, &state, version)
}

#[tauri::command]
async fn secure_history_get(window: WebviewWindow, app: AppHandle) -> Result<Vec<Value>, String> {
    secure_store::history_get(&window, &app)
}

#[tauri::command]
async fn secure_history_add(window: WebviewWindow, app: AppHandle, record: Value) -> Result<(), String> {
    secure_store::history_add(&window, &app, record)
}

#[tauri::command]
async fn secure_history_delete(window: WebviewWindow, app: AppHandle, id: String) -> Result<(), String> {
    secure_store::history_delete(&window, &app, id)
}

#[tauri::command]
async fn secure_history_clear(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    secure_store::history_clear(&window, &app)
}

#[tauri::command]
async fn secure_cache_get(window: WebviewWindow, app: AppHandle) -> Result<Vec<Value>, String> {
    secure_store::cache_get(&window, &app)
}

#[tauri::command]
async fn secure_cache_put(window: WebviewWindow, app: AppHandle, records: Vec<Value>) -> Result<(), String> {
    secure_store::cache_put(&window, &app, records)
}

#[tauri::command]
async fn secure_cache_clear(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    secure_store::cache_clear(&window, &app)
}

// ---- 开机自启动 ----

#[tauri::command]
async fn get_autostart_status(window: WebviewWindow, app: AppHandle) -> Result<bool, String> {
    require_main(&window)?;
    let autostart = app.autolaunch();
    autostart
        .is_enabled()
        .map_err(|e| format!("获取自启动状态失败: {e}"))
}

#[tauri::command]
async fn set_autostart(window: WebviewWindow, app: AppHandle, enabled: bool) -> Result<(), String> {
    require_main(&window)?;
    let autostart = app.autolaunch();
    if enabled {
        autostart
            .enable()
            .map_err(|e| format!("启用自启动失败: {e}"))
    } else {
        autostart
            .disable()
            .map_err(|e| format!("禁用自启动失败: {e}"))
    }
}

#[tauri::command]
async fn diagnostic_snapshot(window: WebviewWindow, app: AppHandle) -> Result<DiagnosticSnapshot, String> {
    require_main(&window)?;
    let tesseract = Command::new("tesseract").arg("--version").output();
    let (tesseract_available, tesseract_version, tesseract_error) = match tesseract {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let first_line = text
                .lines()
                .next()
                .map(|value| value.chars().take(MAX_DIAGNOSTIC_VERSION_CHARS).collect())
                .filter(|value: &String| !value.trim().is_empty());
            (true, first_line, None)
        }
        Ok(_) => (false, None, Some("tesseract 检测失败。".into())),
        Err(_) => (false, None, Some("tesseract 不可用。".into())),
    };
    Ok(DiagnosticSnapshot {
        app_version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        tesseract_available,
        tesseract_version,
        tesseract_error,
    })
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 TransLoop", true, None::<&str>)?;

    // 用 CheckMenuItem 展示自启动状态，切换时只更新勾选态，不重建托盘。
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启动",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    // 克隆一个句柄进闭包，供菜单事件回写勾选态。
    let autostart_handle = autostart_item.clone();

    let menu = Menu::with_items(app, &[&show_item, &autostart_item, &quit_item])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("TransLoop · 翻译")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "autostart" => {
                let autostart = app.autolaunch();
                let current = autostart.is_enabled().unwrap_or(false);
                let result = if current {
                    autostart.disable()
                } else {
                    autostart.enable()
                };
                match result {
                    Ok(()) => {
                        let _ = autostart_handle.set_checked(!current);
                    }
                    Err(e) => {
                        log::error!("切换自启动失败: {e}");
                        // 失败时把勾选态校正回真实状态。
                        let _ =
                            autostart_handle.set_checked(autostart.is_enabled().unwrap_or(false));
                    }
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(provider::ProviderState::default())
        .manage(update::UpdateState::default())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            // 开机自启动时带 --minimized 参数：静默到托盘，不弹主窗口。
            // 主窗在 tauri.conf.json 中默认 visible: false，避免先显示再隐藏的闪窗。
            let launched_minimized = std::env::args().any(|a| a == "--minimized");

            let handle = app.handle().clone();
            if !launched_minimized {
                show_main_window(&handle);
            }
            let hotkey = read_hotkey(&handle);
            let capture_hotkey = read_capture_hotkey(&handle);
            if let Err(e) = shortcut::register(&handle, &hotkey, &capture_hotkey) {
                log::error!("register shortcuts failed: {e:?}");
                // Fall back to defaults if the user-configured combo failed.
                let _ = shortcut::register(&handle, DEFAULT_HOTKEY, DEFAULT_CAPTURE_HOTKEY);
            }

            if let Err(e) = build_tray(&handle) {
                log::error!("build tray failed: {e:?}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // main hides to tray; overlay/capture hide on close so they can be
            // reused for the next screenshot.
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" | "overlay" | "capture" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            reload_shortcuts,
            suspend_shortcuts,
            hide_popup,
            show_main,
            start_capture,
            finish_capture,
            cancel_capture,
            hide_capture,
            ocr_windows,
            ocr_tesseract,
            set_provider_secret,
            provider_secret_status,
            migrate_legacy_secrets,
            start_translation,
            cancel_translation,
            check_for_updates,
            download_verified_update,
            launch_verified_update,
            secure_history_get,
            secure_history_add,
            secure_history_delete,
            secure_history_clear,
            secure_cache_get,
            secure_cache_put,
            secure_cache_clear,
            get_autostart_status,
            set_autostart,
            diagnostic_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TransLoop");
}
