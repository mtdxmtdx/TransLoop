//! Mode B: offline OCR via the Windows.Media.Ocr WinRT API.
//!
//! Takes PNG (or any WIC-decodable) image bytes and returns the recognised
//! text. Runs on a blocking thread because the WinRT `*Async` calls (driven
//! here with the inherent `.join()` blocking helper) plus COM initialisation
//! must not happen on the async runtime's worker threads.

use anyhow::{anyhow, Result};
use windows::{
    Globalization::Language,
    Graphics::Imaging::BitmapDecoder,
    Media::Ocr::OcrEngine,
    Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
};

/// RAII guard so COM is uninitialised even on early return / error paths.
struct ComGuard;
impl ComGuard {
    fn new() -> Self {
        // Balanced by CoUninitialize in Drop.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        ComGuard
    }
}
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// Recognise text in `image_bytes`. `lang_tag` is a BCP-47 tag (e.g. "en",
/// "zh-Hans", "ja"); when `None` or unavailable, the engine falls back to the
/// user's profile languages.
pub fn recognize(image_bytes: &[u8], lang_tag: Option<&str>) -> Result<String> {
    let _com = ComGuard::new();

    // 1. Wrap the bytes in an in-memory random-access stream.
    let stream =
        InMemoryRandomAccessStream::new().map_err(|e| anyhow!("create stream failed: {e}"))?;
    {
        // InMemoryRandomAccessStream converts to IOutputStream via its
        // interface hierarchy, so &stream is accepted directly.
        let writer =
            DataWriter::CreateDataWriter(&stream).map_err(|e| anyhow!("create writer: {e}"))?;
        writer
            .WriteBytes(image_bytes)
            .map_err(|e| anyhow!("write bytes: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| anyhow!("store async: {e}"))?
            .join()
            .map_err(|e| anyhow!("store await: {e}"))?;
        writer
            .FlushAsync()
            .map_err(|e| anyhow!("flush async: {e}"))?
            .join()
            .map_err(|e| anyhow!("flush await: {e}"))?;
        let _ = writer.DetachStream();
    }
    stream.Seek(0).map_err(|e| anyhow!("seek stream: {e}"))?;

    // 2. Decode to a SoftwareBitmap.
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| anyhow!("decoder create: {e}"))?
        .join()
        .map_err(|e| anyhow!("decoder await: {e}"))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| anyhow!("get bitmap: {e}"))?
        .join()
        .map_err(|e| anyhow!("bitmap await: {e}"))?;

    // 3. Build an engine for the requested language, else user profile.
    let engine = build_engine(lang_tag)?;

    // 4. Recognise and join lines.
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| anyhow!("recognize: {e}"))?
        .join()
        .map_err(|e| anyhow!("recognize await: {e}"))?;

    let mut out = String::new();
    let lines = result.Lines().map_err(|e| anyhow!("lines: {e}"))?;
    for line in lines {
        if let Ok(text) = line.Text() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&text.to_string());
        }
    }
    Ok(out)
}

fn build_engine(lang_tag: Option<&str>) -> Result<OcrEngine> {
    if let Some(tag) = lang_tag {
        if let Ok(lang) = Language::CreateLanguage(&windows::core::HSTRING::from(tag)) {
            if let Ok(true) = OcrEngine::IsLanguageSupported(&lang) {
                if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                    return Ok(engine);
                }
            }
        }
    }
    OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| anyhow!("无可用的系统 OCR 语言包: {e}"))
}
