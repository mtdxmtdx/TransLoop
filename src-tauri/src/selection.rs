use anyhow::{anyhow, Result};
use enigo::{
    Direction::{Press, Release},
    Enigo, Key, Keyboard, Settings,
};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

const SENTINEL: &str = "\u{200B}__TRANSLOOP_SENTINEL__\u{200B}";
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const POLL_TIMEOUT: Duration = Duration::from_millis(700);

/// Simulate Ctrl+C to capture the current selection. Strategy:
/// 1. Save existing clipboard text.
/// 2. Overwrite clipboard with a sentinel so we can detect a real copy
///    even when the selection equals the prior clipboard content.
/// 3. Release any modifier keys the user is still holding from the
///    global hotkey (Alt/Ctrl/Shift/Meta) — otherwise Ctrl+C arrives at
///    the foreground app as e.g. Ctrl+Alt+C and is not a copy command.
/// 4. Send Ctrl+C, poll the clipboard until content differs from the
///    sentinel or we time out.
/// 5. Restore the original clipboard.
pub async fn capture_selection(app: AppHandle) -> Result<Option<String>> {
    let original = app.clipboard().read_text().ok();

    app.clipboard()
        .write_text(SENTINEL.to_string())
        .map_err(|e| anyhow!("write sentinel failed: {e}"))?;

    // Let the OS register the new clipboard owner before we read again.
    tokio::time::sleep(Duration::from_millis(20)).await;

    tokio::task::spawn_blocking(|| -> Result<()> {
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| anyhow!("init enigo failed: {e}"))?;

        // User likely still holds the hotkey (e.g. Alt for Alt+Q).
        // Release every plausible modifier so the upcoming Ctrl+C is clean.
        // Release on a not-pressed key is a no-op on Windows.
        for key in [
            Key::Alt,
            Key::Shift,
            Key::Meta,
            Key::Control,
            Key::Unicode('q'),
        ] {
            let _ = enigo.key(key, Release);
        }
        std::thread::sleep(Duration::from_millis(30));

        enigo
            .key(Key::Control, Press)
            .map_err(|e| anyhow!("press ctrl: {e}"))?;
        std::thread::sleep(Duration::from_millis(10));
        enigo
            .key(Key::Unicode('c'), Press)
            .map_err(|e| anyhow!("press c: {e}"))?;
        std::thread::sleep(Duration::from_millis(20));
        enigo
            .key(Key::Unicode('c'), Release)
            .map_err(|e| anyhow!("release c: {e}"))?;
        enigo
            .key(Key::Control, Release)
            .map_err(|e| anyhow!("release ctrl: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| anyhow!("join error: {e}"))??;

    let captured = poll_for_selection(&app).await;

    // Restore the user's original clipboard. If the selection itself was
    // captured, leave it on the clipboard if there was no original content;
    // otherwise restore so we don't surprise the user.
    match (&captured, &original) {
        (_, Some(orig)) => {
            let _ = app.clipboard().write_text(orig.clone());
        }
        (Some(_), None) => {
            // keep selection on clipboard
        }
        (None, None) => {
            let _ = app.clipboard().clear();
        }
    }

    Ok(captured)
}

async fn poll_for_selection(app: &AppHandle) -> Option<String> {
    let start = std::time::Instant::now();
    while start.elapsed() < POLL_TIMEOUT {
        tokio::time::sleep(POLL_INTERVAL).await;
        if let Ok(text) = app.clipboard().read_text() {
            if text != SENTINEL && !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}
