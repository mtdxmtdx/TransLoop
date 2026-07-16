//! Mode B: offline OCR via the Windows.Media.Ocr WinRT API.
//!
//! Takes PNG (or any WIC-decodable) image bytes and returns the recognised
//! text. Runs on a blocking thread because the WinRT `*Async` calls (driven
//! here with the inherent `.join()` blocking helper) plus COM initialisation
//! must not happen on the async runtime's worker threads.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::{
    io::Write,
    path::PathBuf,
    process::Command,
};
use windows::{
    Globalization::Language,
    Graphics::Imaging::BitmapDecoder,
    Media::Ocr::OcrEngine,
    Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
};

const MAX_IMAGE_PIXELS: u64 = 40_000_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub lines: Vec<OcrLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    pub words: Vec<OcrWord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

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
pub fn recognize_windows(image_bytes: &[u8], lang_tag: Option<&str>) -> Result<OcrResult> {
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
    let width = decoder.PixelWidth().map_err(|e| anyhow!("image width: {e}"))? as u64;
    let height = decoder.PixelHeight().map_err(|e| anyhow!("image height: {e}"))? as u64;
    if width == 0 || height == 0 || width.saturating_mul(height) > MAX_IMAGE_PIXELS {
        return Err(anyhow!("图片像素尺寸超过限制"));
    }
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

    let mut result_lines = Vec::new();
    let lines = result.Lines().map_err(|e| anyhow!("lines: {e}"))?;
    for line in lines {
        if let Ok(text) = line.Text() {
            let mut words = Vec::new();
            if let Ok(line_words) = line.Words() {
                for word in line_words {
                    let Ok(word_text) = word.Text() else {
                        continue;
                    };
                    let Ok(rect) = word.BoundingRect() else {
                        continue;
                    };
                    words.push(OcrWord {
                        text: word_text.to_string(),
                        x: rect.X,
                        y: rect.Y,
                        width: rect.Width,
                        height: rect.Height,
                    });
                }
            }
            result_lines.push(OcrLine {
                text: text.to_string(),
                words,
            });
        }
    }

    let text = result_lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(OcrResult {
        text,
        lines: result_lines,
    })
}

pub fn recognize_tesseract(image_bytes: &[u8], lang: Option<&str>) -> Result<OcrResult> {
    let mut temporary = tempfile::Builder::new()
        .prefix("transloop-ocr-")
        .suffix(".png")
        .tempfile_in(std::env::temp_dir())
        .map_err(|e| anyhow!("写入临时图片失败: {e}"))?;
    temporary
        .write_all(image_bytes)
        .map_err(|e| anyhow!("写入临时图片失败: {e}"))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|e| anyhow!("提交临时图片失败: {e}"))?;
    let input_path = temporary.path().to_path_buf();

    let tesseract = find_tesseract()?;
    let tessdata = find_tessdata();
    let lang_arg = tesseract_lang(lang);
    let mut last_error = None;
    for psm in ["6", "11"] {
        let mut command = Command::new(&tesseract);
        command.arg(&input_path)
            .arg("stdout")
            .arg("-l")
            .arg(&lang_arg)
            .arg("--psm")
            .arg(psm);
        if let Some(tessdata) = &tessdata {
            command.env("TESSDATA_PREFIX", tessdata);
        }
        let output = command.output();

        match output {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !text.is_empty() || psm == "11" {
                    return Ok(result_from_plain_text(text));
                }
            }
            Ok(output) => {
                last_error = Some(format!("Tesseract exited with status {}", output.status));
            }
            Err(e) => {
                return Err(anyhow!(
                    "启动 Tesseract 失败。请确认 Tesseract OCR 已安装（错误码：{}）",
                    e.kind()
                ));
            }
        }
    }

    Err(anyhow!(
        "Tesseract OCR 识别失败：{}",
        last_error
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "无错误输出".to_string())
    ))
}

fn find_tesseract() -> Result<PathBuf> {
    let candidates = [
        PathBuf::from(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
        PathBuf::from("tesseract"),
    ];

    for candidate in candidates {
        if candidate.components().count() == 1 || candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(anyhow!(
        "未找到 Tesseract。请先安装 Tesseract OCR 并确保 tesseract 命令在 PATH 中。"
    ))
}

fn find_tessdata() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(prefix) = std::env::var("TESSDATA_PREFIX") {
        candidates.push(PathBuf::from(prefix));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app_data).join(r"Tesseract-OCR\tessdata"));
    }
    candidates.push(PathBuf::from(r"C:\Program Files\Tesseract-OCR\tessdata"));
    candidates
        .into_iter()
        .find(|path| path.join("eng.traineddata").exists())
}

fn tesseract_lang(lang: Option<&str>) -> String {
    match lang.unwrap_or("auto") {
        "zh" | "zh-Hans" => "chi_sim+eng",
        "zh-TW" | "zh-Hant" => "chi_tra+eng",
        "en" => "eng",
        "ja" => "jpn+eng",
        "ko" => "kor+eng",
        "fr" => "fra+eng",
        "de" => "deu+eng",
        "es" => "spa+eng",
        "ru" => "rus+eng",
        _ => "eng+chi_sim",
    }
    .to_string()
}

fn result_from_plain_text(text: String) -> OcrResult {
    let lines = text
        .lines()
        .map(|line| OcrLine {
            text: line.to_string(),
            words: Vec::new(),
        })
        .collect();
    OcrResult { text, lines }
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
