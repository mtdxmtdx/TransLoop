mod capture;
mod ocr;
mod popup;
mod selection;
mod shortcut;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path, process::Command};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";
const DEFAULT_HOTKEY: &str = "Alt+Q";
const DEFAULT_CAPTURE_HOTKEY: &str = "Alt+S";

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
async fn reload_shortcuts(app: AppHandle) -> Result<(), String> {
    let translate = read_hotkey(&app);
    let capture = read_capture_hotkey(&app);
    shortcut::reregister(&app, &translate, &capture).map_err(|e| e.to_string())
}

/// Temporarily unregister all global shortcuts so they don't fire while the
/// user is recording a new combination in the settings UI. Restored by a
/// subsequent `reload_shortcuts` call.
#[tauri::command]
async fn suspend_shortcuts(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn hide_popup(app: AppHandle) -> Result<(), String> {
    popup::hide_popup(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn show_main(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
async fn start_capture(app: AppHandle) -> Result<(), String> {
    capture::begin_capture(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn finish_capture(app: AppHandle, data_url: String) -> Result<(), String> {
    capture::finish_capture(&app, data_url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_capture(app: AppHandle) -> Result<(), String> {
    capture::cancel_capture(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn hide_capture(app: AppHandle) -> Result<(), String> {
    capture::hide_capture(&app).map_err(|e| e.to_string())
}

fn decode_image_data_url(image: &str) -> Result<Vec<u8>, String> {
    let b64 = image
        .rsplit_once(',')
        .map(|(_, rest)| rest)
        .unwrap_or(image);
    STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("图片解码失败: {e}"))
}

/// OCR mode B: run Windows OCR on a base64 image (data URL or bare base64).
/// Returns structured OCR text. `lang` is an optional BCP-47 tag.
#[tauri::command]
async fn ocr_windows(image: String, lang: Option<String>) -> Result<ocr::OcrResult, String> {
    let bytes = decode_image_data_url(&image)?;
    let lang = lang.filter(|s| !s.trim().is_empty());
    tauri::async_runtime::spawn_blocking(move || ocr::recognize_windows(&bytes, lang.as_deref()))
        .await
        .map_err(|e| format!("OCR 线程错误: {e}"))?
        .map_err(|e| e.to_string())
}

/// OCR mode C: run local Tesseract OCR on a base64 image.
#[tauri::command]
async fn ocr_tesseract(image: String, lang: Option<String>) -> Result<ocr::OcrResult, String> {
    let bytes = decode_image_data_url(&image)?;
    let lang = lang.filter(|s| !s.trim().is_empty());
    tauri::async_runtime::spawn_blocking(move || ocr::recognize_tesseract(&bytes, lang.as_deref()))
        .await
        .map_err(|e| format!("OCR 线程错误: {e}"))?
        .map_err(|e| e.to_string())
}

// ---- API Key 安全存储：OS keyring（Windows 凭据管理器 / macOS Keychain 等）----

const KEYRING_SERVICE: &str = "com.transloop.app";

fn keyring_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("keyring 初始化失败: {e}"))
}

/// 写入一个密钥；空字符串等同删除。
#[tauri::command]
async fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = keyring_entry(&key)?;
    if value.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("删除密钥失败: {e}")),
        };
    }
    entry
        .set_password(&value)
        .map_err(|e| format!("保存密钥失败: {e}"))
}

/// 读取一个密钥；不存在时返回 None。
#[tauri::command]
async fn get_secret(key: String) -> Result<Option<String>, String> {
    let entry = keyring_entry(&key)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取密钥失败: {e}")),
    }
}

/// 删除一个密钥。
#[tauri::command]
async fn delete_secret(key: String) -> Result<(), String> {
    let entry = keyring_entry(&key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除密钥失败: {e}")),
    }
}

// ---- 开机自启动 ----

#[tauri::command]
async fn get_autostart_status(app: AppHandle) -> Result<bool, String> {
    let autostart = app.autolaunch();
    autostart
        .is_enabled()
        .map_err(|e| format!("获取自启动状态失败: {e}"))
}

#[tauri::command]
async fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
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
async fn diagnostic_snapshot(app: AppHandle) -> Result<DiagnosticSnapshot, String> {
    let tesseract = Command::new("tesseract").arg("--version").output();
    let (tesseract_available, tesseract_version, tesseract_error) = match tesseract {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let first_line = text.lines().next().map(|s| s.to_string());
            (true, first_line, None)
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            (
                false,
                None,
                Some(if stderr.is_empty() {
                    format!("tesseract exited with status {}", output.status)
                } else {
                    stderr
                }),
            )
        }
        Err(e) => (false, None, Some(e.to_string())),
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

#[tauri::command]
async fn save_and_launch_installer(file_name: String, data_base64: String) -> Result<String, String> {
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "安装包文件名无效。".to_string())?;
    if !safe_name.to_ascii_lowercase().ends_with(".exe") {
        return Err("安装包文件名必须以 .exe 结尾。".to_string());
    }

    let bytes = STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("安装包数据解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("安装包数据为空。".to_string());
    }

    let dir = std::env::temp_dir().join("TransLoop").join("updates");
    fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {e}"))?;
    let path = dir.join(safe_name);
    fs::write(&path, bytes).map_err(|e| format!("保存安装包失败: {e}"))?;
    Command::new(&path)
        .spawn()
        .map_err(|e| format!("启动安装包失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
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
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
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
            set_secret,
            get_secret,
            delete_secret,
            get_autostart_status,
            set_autostart,
            diagnostic_snapshot,
            save_and_launch_installer
        ])
        .run(tauri::generate_context!())
        .expect("error while running TransLoop");
}
