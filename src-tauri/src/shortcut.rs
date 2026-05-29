use anyhow::{anyhow, Result};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

use crate::capture::begin_capture;
use crate::popup::show_popup_at_cursor;
use crate::selection::capture_selection;

/// Parse a string like "Alt+Q" or "Ctrl+Shift+T" into a Shortcut.
pub fn parse_shortcut(input: &str) -> Result<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;

    for raw in input.split('+') {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "controlleft" => mods |= Modifiers::CONTROL,
            "alt" | "option" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "win" | "cmd" | "command" => mods |= Modifiers::SUPER,
            other => {
                code = Some(parse_key(other)?);
            }
        }
    }
    let code = code.ok_or_else(|| anyhow!("快捷键缺少主键: {input}"))?;
    Ok(Shortcut::new(Some(mods), code))
}

fn parse_key(s: &str) -> Result<Code> {
    let upper = s.to_ascii_uppercase();
    if upper.len() == 1 {
        let ch = upper.chars().next().unwrap();
        if ch.is_ascii_alphabetic() {
            return Ok(match ch {
                'A' => Code::KeyA, 'B' => Code::KeyB, 'C' => Code::KeyC, 'D' => Code::KeyD,
                'E' => Code::KeyE, 'F' => Code::KeyF, 'G' => Code::KeyG, 'H' => Code::KeyH,
                'I' => Code::KeyI, 'J' => Code::KeyJ, 'K' => Code::KeyK, 'L' => Code::KeyL,
                'M' => Code::KeyM, 'N' => Code::KeyN, 'O' => Code::KeyO, 'P' => Code::KeyP,
                'Q' => Code::KeyQ, 'R' => Code::KeyR, 'S' => Code::KeyS, 'T' => Code::KeyT,
                'U' => Code::KeyU, 'V' => Code::KeyV, 'W' => Code::KeyW, 'X' => Code::KeyX,
                'Y' => Code::KeyY, 'Z' => Code::KeyZ,
                _ => return Err(anyhow!("不支持的字符: {ch}")),
            });
        }
        if ch.is_ascii_digit() {
            return Ok(match ch {
                '0' => Code::Digit0, '1' => Code::Digit1, '2' => Code::Digit2,
                '3' => Code::Digit3, '4' => Code::Digit4, '5' => Code::Digit5,
                '6' => Code::Digit6, '7' => Code::Digit7, '8' => Code::Digit8,
                '9' => Code::Digit9,
                _ => unreachable!(),
            });
        }
    }
    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            return Ok(match n {
                1 => Code::F1, 2 => Code::F2, 3 => Code::F3, 4 => Code::F4,
                5 => Code::F5, 6 => Code::F6, 7 => Code::F7, 8 => Code::F8,
                9 => Code::F9, 10 => Code::F10, 11 => Code::F11, 12 => Code::F12,
                _ => return Err(anyhow!("不支持的功能键: F{n}")),
            });
        }
    }
    match upper.as_str() {
        "SPACE" => Ok(Code::Space),
        "ENTER" | "RETURN" => Ok(Code::Enter),
        "TAB" => Ok(Code::Tab),
        "ESC" | "ESCAPE" => Ok(Code::Escape),
        "BACKSPACE" => Ok(Code::Backspace),
        "DELETE" | "DEL" => Ok(Code::Delete),
        _ => Err(anyhow!("无法识别的按键: {s}")),
    }
}

fn on_triggered(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match capture_selection(app.clone()).await {
            Ok(Some(text)) => {
                if let Err(e) = show_popup_at_cursor(&app, text) {
                    log::error!("show popup failed: {e:?}");
                }
            }
            Ok(None) => {
                if let Err(e) = show_popup_at_cursor(
                    &app,
                    "未捕获到选中的文字。请先选中文字再触发快捷键。".into(),
                ) {
                    log::error!("show popup failed: {e:?}");
                }
            }
            Err(e) => {
                log::error!("capture selection failed: {e:?}");
                let _ = show_popup_at_cursor(&app, format!("读取剪贴板失败：{e}"));
            }
        }
    });
}

fn on_capture_triggered(app: &AppHandle) {
    if let Err(e) = begin_capture(app) {
        log::error!("begin capture failed: {e:?}");
    }
}

/// Register both the selection-translate hotkey and the screenshot hotkey.
/// Either may be empty/invalid; we register whichever parse successfully and
/// return the first error so the caller can fall back / log.
pub fn register(app: &AppHandle, translate_hotkey: &str, capture_hotkey: &str) -> Result<()> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let mut first_err: Option<anyhow::Error> = None;

    if let Err(e) = bind(app, translate_hotkey, Action::Translate) {
        log::error!("注册划词快捷键 '{translate_hotkey}' 失败: {e:?}");
        first_err.get_or_insert(e);
    }
    if !capture_hotkey.trim().is_empty() {
        if let Err(e) = bind(app, capture_hotkey, Action::Capture) {
            log::error!("注册截图快捷键 '{capture_hotkey}' 失败: {e:?}");
            first_err.get_or_insert(e);
        }
    }

    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[derive(Clone, Copy)]
enum Action {
    Translate,
    Capture,
}

fn bind(app: &AppHandle, hotkey: &str, action: Action) -> Result<()> {
    let shortcut = parse_shortcut(hotkey)?;
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _sc, event: ShortcutEvent| {
            if event.state() == ShortcutState::Pressed {
                match action {
                    Action::Translate => on_triggered(&app_handle),
                    Action::Capture => on_capture_triggered(&app_handle),
                }
            }
        })
        .map_err(|e| anyhow!("注册快捷键失败: {e}"))?;
    Ok(())
}

pub fn reregister(app: &AppHandle, translate_hotkey: &str, capture_hotkey: &str) -> Result<()> {
    let _ = app.global_shortcut().unregister_all();
    register(app, translate_hotkey, capture_hotkey)
}
