//! Stage 2: screenshot capture + region selection orchestration.
//!
//! Flow:
//! 1. `begin_capture` (hotkey or command) grabs the monitor under the cursor
//!    with xcap, encodes it to a PNG data URL, positions the borderless
//!    `overlay` window to cover that monitor exactly, shows it and emits the
//!    image. The frontend overlay lets the user rubber-band a region and crops
//!    it (canvas) using the image's natural-vs-displayed pixel ratio, so DPI
//!    scaling is handled automatically.
//! 2. The overlay calls `finish_capture` with the cropped data URL. We hide the
//!    overlay, center + show the `capture` window and forward the crop. The
//!    capture window then runs OCR mode A (vision model) or B (Windows OCR).
//! 3. `cancel_capture` just hides the overlay (Esc / right-click).

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
use xcap::{
    image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder},
    Monitor,
};

const OVERLAY_LABEL: &str = "overlay";
const CAPTURE_LABEL: &str = "capture";

/// Physical rect (x, y, w, h) of the monitor the last capture covered, so the
/// result window can be centered on the same screen.
static LAST_MONITOR: Mutex<Option<(i32, i32, u32, u32)>> = Mutex::new(None);

#[derive(Clone, Serialize)]
struct ImagePayload {
    #[serde(rename = "dataUrl")]
    data_url: String,
}

/// Take a screenshot of the monitor under the cursor and show the overlay.
pub fn begin_capture(app: &AppHandle) -> Result<()> {
    let (cx, cy) = match app.cursor_position() {
        Ok(p) => (p.x as i32, p.y as i32),
        Err(_) => (0, 0),
    };

    let monitor = Monitor::from_point(cx, cy)
        .or_else(|_| {
            Monitor::all()?
                .into_iter()
                .next()
                .ok_or_else(|| anyhow!("未找到任何显示器"))
        })
        .map_err(|e| anyhow!("定位显示器失败: {e}"))?;

    let mon_x = monitor.x().unwrap_or(0);
    let mon_y = monitor.y().unwrap_or(0);

    let image = monitor
        .capture_image()
        .map_err(|e| anyhow!("截屏失败: {e}"))?;
    let (img_w, img_h) = (image.width(), image.height());

    // Encode RGBA -> PNG -> base64 data URL.
    let mut png: Vec<u8> = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(image.as_raw(), img_w, img_h, ExtendedColorType::Rgba8)
        .map_err(|e| anyhow!("PNG 编码失败: {e}"))?;
    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&png));

    if let Ok(mut guard) = LAST_MONITOR.lock() {
        *guard = Some((mon_x, mon_y, img_w, img_h));
    }

    let overlay = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| anyhow!("overlay 窗口不存在"))?;

    // Cover the captured monitor exactly (physical px == image px).
    overlay.set_position(tauri::Position::Physical(PhysicalPosition::new(mon_x, mon_y)))?;
    overlay.set_size(tauri::Size::Physical(PhysicalSize::new(img_w, img_h)))?;

    // Emit before show so the image is ready when the window paints.
    overlay.emit_to(OVERLAY_LABEL, "capture://image", ImagePayload { data_url })?;

    overlay.show()?;
    let _ = overlay.set_always_on_top(true);
    let _ = overlay.set_focus();
    Ok(())
}

/// Overlay finished selecting: hide it, show the result window with the crop.
pub fn finish_capture(app: &AppHandle, data_url: String) -> Result<()> {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
    }

    let win = app
        .get_webview_window(CAPTURE_LABEL)
        .ok_or_else(|| anyhow!("capture 窗口不存在"))?;

    center_on_last_monitor(&win);

    win.emit_to(CAPTURE_LABEL, "capture://crop", ImagePayload { data_url })?;
    win.show()?;
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    Ok(())
}

pub fn cancel_capture(app: &AppHandle) -> Result<()> {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        overlay.hide()?;
    }
    Ok(())
}

pub fn hide_capture(app: &AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        win.hide()?;
    }
    Ok(())
}

fn center_on_last_monitor(win: &tauri::WebviewWindow) {
    let rect = LAST_MONITOR.lock().ok().and_then(|g| *g);
    if let Some((mx, my, mw, mh)) = rect {
        if let Ok(size) = win.outer_size() {
            let x = mx + ((mw as i32 - size.width as i32) / 2).max(0);
            let y = my + ((mh as i32 - size.height as i32) / 2).max(0);
            let _ = win.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
        }
    }
}
