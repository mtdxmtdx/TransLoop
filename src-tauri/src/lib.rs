mod popup;
mod selection;
mod shortcut;

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";
const DEFAULT_HOTKEY: &str = "Alt+Q";

fn read_hotkey(app: &AppHandle) -> String {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(Value::Object(map)) = store.get(SETTINGS_KEY) {
            if let Some(Value::String(s)) = map.get("hotkey") {
                if !s.trim().is_empty() {
                    return s.clone();
                }
            }
        }
    }
    DEFAULT_HOTKEY.to_string()
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[tauri::command]
async fn update_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    shortcut::reregister(&app, &hotkey).map_err(|e| e.to_string())
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

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 TransLoop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("TransLoop · 翻译")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
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
        .setup(|app| {
            if let Some(win) = app.get_webview_window("popup") {
                let _ = win.hide();
            }

            let handle = app.handle().clone();
            let hotkey = read_hotkey(&handle);
            if let Err(e) = shortcut::register(&handle, &hotkey) {
                log::error!("register shortcut '{hotkey}' failed: {e:?}");
                if hotkey != DEFAULT_HOTKEY {
                    let _ = shortcut::register(&handle, DEFAULT_HOTKEY);
                }
            }

            if let Err(e) = build_tray(&handle) {
                log::error!("build tray failed: {e:?}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![update_hotkey, hide_popup, show_main])
        .run(tauri::generate_context!())
        .expect("error while running TransLoop");
}
