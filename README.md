# TransLoop（译环）

桌面端翻译工具，Tauri 2 + React 18 + TypeScript。

两种核心交互：

1. **划词翻译**：任意应用选中文字 → 按快捷键（默认 `Alt+Q`）→ 光标旁弹出悬浮窗实时显示译文。
2. **截图翻译**：按快捷键（默认 `Alt+S`）→ 框选屏幕区域 → 分屏窗口（左原文 / 右译文），支持流式。



## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Tauri 2 (Rust) |
| 前端 | React 18 + TypeScript + Vite |
| 前端插件 | plugin-global-shortcut, plugin-clipboard-manager, plugin-store, plugin-http |
| Rust 依赖 | enigo（模拟按键）, xcap（屏幕截图）, windows（WinRT OCR）, keyring（OS 凭据管理器）, tokio, serde |

## 目录

```
TransLoop/
├── index.html                  # 主窗口入口
├── popup.html                  # 划词悬浮窗入口
├── overlay.html                # 截图框选蒙层入口
├── capture.html                # 截图翻译结果窗入口
├── src/
│   ├── App.tsx                 # 主窗：双栏翻译器 + 工具栏
│   ├── SettingsModal.tsx        # 设置弹窗（快捷键录制、模型配置、OCR 模式）
│   ├── PopupView.tsx            # 划词悬浮窗（拖拽 / 缩放 / Esc 关闭）
│   ├── OverlayView.tsx          # 框选蒙层（canvas 裁切 → finish_capture）
│   ├── CaptureView.tsx          # 截图结果窗（分屏 + 模式 A/B 分流）
│   ├── HotkeyInput.tsx          # 快捷键录制组件
│   ├── store.ts                 # tauri-plugin-store 封装
│   ├── styles.css
│   └── providers/
│       ├── types.ts             # TranslationProvider 接口 + PROVIDER_REGISTRY
│       ├── openai-compat.ts     # OpenAI 兼容层（openai/qwen/grok/minimax；chatPath 选项）
│       ├── deepseek.ts          # DeepSeek（文本 SSE 流式，含 thinking:disabled）
│       ├── claude.ts            # Anthropic Claude（Messages API，x-api-key，content_block_delta）
│       ├── gemini.ts            # Google Gemini（generateContent / streamGenerateContent，inlineData）
│       ├── sse.ts               # 通用 SSE 行读取 + data: URL 拆分
│       └── index.ts             # createProvider 工厂
└── src-tauri/
    ├── tauri.conf.json
    ├── Cargo.toml
    ├── capabilities/default.json
    └── src/
        ├── main.rs / lib.rs     # 入口、命令、托盘、窗口事件拦截
        ├── shortcut.rs          # 解析并注册双全局快捷键
        ├── selection.rs         # 释放修饰键 → 模拟 Ctrl+C → 轮询剪贴板
        ├── popup.rs             # 光标附近展示悬浮窗
        ├── capture.rs           # 截图 → PNG data: URL → overlay 定位
        └── ocr.rs               # Windows.Media.Ocr WinRT 识别（模式 B）
```

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发模式（HMR）
pnpm tauri build    # 生产构建
```

> 若 `cargo install tauri-cli` 因权限被杀软拦截，用项目内置的 `pnpm tauri ...` 即可，无需全局安装。

## 使用

### 初次设置

1. 启动后点右上角 **⚙** 打开设置。
2. 选择翻译提供方（默认 DeepSeek），填写 API Key。
3. 可选：调整 Base URL / Model、修改快捷键（点击字段后直接按键录制）、选择 OCR 模式、开启多模型协作并配置识别模型。
4. 保存后设置窗口自动关闭。

### 划词翻译（`Alt+Q`）

在任意应用选中文字 → 按快捷键 → 光标旁弹出悬浮窗显示流式译文。窗口可拖拽、缩放，点 × 或 Esc 关闭。

### 截图翻译（`Alt+S`）

按快捷键 → 拖拽框选屏幕区域 → 松开后自动进入翻译：

- **模式 A**：多模态模型处理；协作模式下先识别再翻译。
- **模式 B**：Windows 系统 OCR 识别 → 翻译模型翻译。

分屏结果窗：左侧原文，右侧译文（流式），顶栏显示截图缩略图，右下角「复制」按钮，Esc 关闭。

### OCR 模式对比

| 模式 | 原理 | 优势 | 局限 |
|------|------|------|------|
| A（单模型） | 多模态模型直接见图翻译 | 一步完成，准确率最高 | 需支持视觉的模型 |
| A（协作） | 视觉模型 OCR → 文本模型翻译 | 可组合任意模型 | 两次 API 调用 |
| B | Windows.Media.Ocr → 文本模型 | 离线免费，隐私安全 | 复杂排版效果一般 |

## 配置文件位置

`%APPDATA%\com.transloop.app\settings.json`（Windows）

字段（不含密钥）：`hotkey`, `captureHotkey`, `provider`, `baseUrl`, `model`, `fromLang`, `toLang`, `streamOutput`, `ocrMode`, `visionCollab`, `recognizeProvider`, `recognizeBaseUrl`, `recognizeModel`。API Key 按提供方分开保存在 OS keyring 中（`apikey.<provider>`），不在 settings.json 里落盘。

## 已知约束

- 划词依赖剪贴板：会临时覆盖后恢复用户原有内容。个别 UIPI 保护的窗口可能漏读。
- API Key 按提供方分别存入 OS keyring（Windows 凭据管理器），不在配置文件中落盘。
- 截图捕获当前光标所在显示器（多屏环境以光标为准）。
- OCR 模式 B 依赖系统已安装的语言包。

---

## 路线图

| 阶段 | 目标 | 状态 |
|------|------|------|
| 1 | 脚手架 + 划词翻译 + 主窗双栏 + 托盘 + DeepSeek | ✅ |
| 2 | 截图框选 + OCR 模式 A/B + 分屏展示窗 + 多模型协作 + 快捷键录制 | ✅ |
| 3 | 全部 7 家 Provider 真实实现 + API Key keyring 按提供方加密 | ✅ |
| 4 | 开机自启 + NSIS 安装包 | ✅ |
| 5 | 浏览器插件 + OCR 模式 C/D | ⏳ 待开始 |

---

## 更新日志

### 0.4.0 · 2026-05-30 — Stage 4

- **开机自启动**：集成 `tauri-plugin-autostart`，支持在设置界面和系统托盘菜单中切换开机自启状态（Windows 通过注册表实现）。
- **静默启动到托盘**：自启动时带 `--minimized` 参数，开机后静默驻留托盘，不弹出主窗口；手动启动则正常显示。
- **系统托盘增强**：托盘菜单新增「开机自启动」勾选项（`CheckMenuItem`），切换时仅更新勾选态，不重建托盘（避免重复图标）。
- **NSIS 安装包配置**：配置 Windows NSIS 安装包生成，支持当前用户安装模式（currentUser），提供中英文语言选择。
- 版本号统一升至 `0.4.0`（`package.json` / `tauri.conf.json` / `Cargo.toml`）。

### 0.3.0 · 2026-05-29 — Stage 3

- **Claude 真实实现**：Anthropic Messages API，`x-api-key` + `anthropic-version` 头，SSE `content_block_delta` 流式，base64 `image` 内容块支持视觉。
- **Gemini 真实实现**：`generateContent` / `streamGenerateContent` + `alt=sse`，`systemInstruction`，`inlineData` 视觉，key 走 `?key=` 查询参数。
- **MiniMax 真实实现**：通过 OpenAI 兼容层接入，走 `/text/chatcompletion_v2` 路径。
- **API Key 按提供方分别加密**：keyring 条目 `apikey.<provider>`（如 `apikey.deepseek`），切换提供方自动切换对应 Key；自动迁移旧版按角色存储的 keyring 条目。
- **设置交互优化**：API Key 输入框绑定当前提供方，预载所有提供方 Key 后即时切换。
- 移除 `stubs.ts`（全部 7 家提供方已实现）。

### 0.2.0 · 2026-05-29 — Stage 2

- **截图翻译**：xcap 全屏截图 → overlay 框选 + canvas 裁切 → 分屏展示窗。
- **OCR 模式 A（多模态）**：GPT-4o / Qwen3-VL-Flash / Grok 等视觉模型，`translateImage()` + `recognizeImage()`。
- **OCR 模式 B（离线）**：Windows.Media.Ocr WinRT 引擎识别 → 文本模型翻译。
- **多模型协作**：视觉模型 OCR → 任意文本模型翻译，可组合不同服务商。
- **OpenAI 兼容层**：统一处理 OpenAI / Qwen3-VL / Grok（SSE 流式 + 视觉 API）。
- **快捷键录制**：点击字段直接按组合键录制，录制期间自动暂停全局快捷键避免冲突。
- **双全局快捷键**：划词 `Alt+Q` + 截图 `Alt+S`，独立注册和设置。
- **设置交互优化**：保存后自动关闭设置窗。

### 0.1.0 · 2026-05-24 — Stage 1

- Tauri 2 + React + TS 脚手架，双窗口（主窗 + 悬浮窗）。
- 全局快捷键 + 划词捕获（Ctrl+C + 哨兵轮询）+ 光标定位悬浮窗。
- 主窗双栏翻译器（左输入/右译文，debounce 自动触发）。
- 系统托盘（显示主窗 / 退出），× 拦截不退出。
- DeepSeek 流式 SSE 翻译实现，其余 6 家 Provider 占位。
- 设置弹窗 + tauri-plugin-store 持久化。
