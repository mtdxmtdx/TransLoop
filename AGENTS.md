# TransLoop Agent Guide

## 1. 项目定位
面向 Windows 桌面端的快捷划词翻译（Alt+Q）与多屏幕截图 OCR 翻译（Alt+S）工具。

## 2. 快速运行与构建
- 前端开发：`pnpm dev`
- 前端构建与检查：`pnpm build` (`tsc -b && vite build`)
- 原生开发调试：`pnpm tauri dev`
- 原生构建发布包：`pnpm tauri build`
- 原生测试：`cargo test --manifest-path src-tauri/Cargo.toml`

## 3. 技术栈
- 桌面框架：Tauri 2 (Rust) + 多窗口 (`main`, `popup`, `overlay`, `capture`)
- 前端：React 18 + TypeScript + Vite + CSS
- 系统交互：`enigo` (按键模拟取词), `xcap` (跨屏幕截图), `windows` (WinRT OCR / DPAPI 加密)
- 密钥与安全：`keyring` (系统凭据存储), `ed25519-dalek` / `sha2` (签名校验更新)

## 4. 目录结构与架构约定
- `src/`：React 前端组件与业务逻辑（`SettingsModal`, `CaptureView`, `PopupView`, `App` 等）
- `src/providers/`：Provider 注册表、Prompt 加固模板与视觉支持判断
- `src-tauri/src/`：Rust 原生网关与系统功能（`lib.rs`, `provider.rs`, `secure_store.rs`, `capture.rs`, `ocr.rs`）
- **安全约定**：WebView 严禁直接存储或读取明文 API Key；翻译历史与缓存必须通过 DPAPI 加密。

## 5. 当前状态与下一步
- 当前版本：`1.0.5`（已全面支持 DeepSeek 多模态视觉模型；截图翻译已解除对 DeepSeek 模型名称的限制）
- 下一步：`1.1.0` 增强 OCR 质量与段落/代码块结构恢复。
