use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition};

const POPUP_LABEL: &str = "popup";
static REQUEST_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
struct PopupPayload {
    text: String,
    #[serde(rename = "requestId")]
    request_id: u64,
}

pub fn show_popup_at_cursor(app: &AppHandle, text: String) -> Result<()> {
    let win = app
        .get_webview_window(POPUP_LABEL)
        .ok_or_else(|| anyhow!("popup window not found"))?;

    if let Ok(cursor) = app.cursor_position() {
        let scale = win.scale_factor().unwrap_or(1.0);
        let size = win.outer_size().ok();
        let monitor = win.current_monitor().ok().flatten();

        // Cursor is in physical pixels. Offset 16/22 px so the popup doesn't
        // sit directly under the cursor and steal mouse-leave logic.
        let mut x = cursor.x + 16.0;
        let mut y = cursor.y + 22.0;

        if let (Some(sz), Some(m)) = (size, monitor) {
            let mp = m.position();
            let ms = m.size();
            let max_x = (mp.x as f64) + (ms.width as f64) - sz.width as f64 - 8.0;
            let max_y = (mp.y as f64) + (ms.height as f64) - sz.height as f64 - 8.0;
            if x > max_x {
                x = max_x;
            }
            if y > max_y {
                y = max_y;
            }
        }

        let logical = LogicalPosition::new(x / scale, y / scale);
        let _ = win.set_position(tauri::Position::Logical(logical));
    } else {
        let _ = win.set_position(tauri::Position::Physical(PhysicalPosition::new(100, 100)));
    }

    let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
    app.emit_to(
        POPUP_LABEL,
        "popup://text",
        PopupPayload { text, request_id: id },
    )?;

    win.show()?;
    let _ = win.set_always_on_top(true);
    Ok(())
}

pub fn hide_popup(app: &AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window(POPUP_LABEL) {
        win.hide()?;
    }
    Ok(())
}
