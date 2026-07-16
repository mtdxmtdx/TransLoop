# TransLoop（译环）

TransLoop 是一款面向 Windows 的桌面划词翻译与截图 OCR 翻译工具。它聚焦桌面端使用场景：在任意应用中选中文字快速翻译，或框选屏幕区域进行 OCR 识别与翻译。

## 下载

- 最新安装包请前往 [GitHub Releases](https://github.com/mtdxmtdx/TransLoop/releases)。
- Windows x64 用户下载 `TransLoop_1.0.1_x64-setup.exe` 并运行安装。
- 从 `1.0.0` 升级到 `1.0.1` 时，设置、Provider API Key、历史记录、缓存和快捷键会继续保留在本机。

## 核心功能

- **划词翻译**：任意应用选中文字后按快捷键，光标旁弹出悬浮窗显示译文。
- **截图翻译**：按快捷键框选屏幕区域，自动 OCR 并展示原文 / 译文分屏结果。
- **多 Provider 支持**：支持 DeepSeek、OpenAI、Qwen、Grok、MiniMax、Claude、Gemini；网络请求仅访问对应 Provider 的官方 HTTPS 域名。
- **自动降级与用量统计**：Provider 失败时可尝试备用模型 / Provider，并记录本地请求元数据。
- **翻译历史与缓存**：保存最近翻译结果，短期复用重复翻译以减少请求。
- **诊断与迁移**：支持脱敏诊断包导出、非密钥设置导入 / 导出、应用内检查新版本。

## 快速开始

1. 安装并启动 TransLoop。
2. 首次引导中选择 Provider 和模型，并填写 API Key。
3. 确认划词快捷键（默认 `Alt+Q`）和截图快捷键（默认 `Alt+S`）。
4. 在任意应用选中文字后按 `Alt+Q` 使用划词翻译。
5. 按 `Alt+S` 框选屏幕区域使用截图翻译。

也可以随时点击主窗口右上角设置按钮调整 Provider、模型、OCR 模式、智能语言方向、缓存、自动降级和诊断选项。

## 使用说明

### 划词翻译

在任意应用选中文字后按快捷键，TransLoop 会读取选区并在光标旁显示悬浮窗。悬浮窗支持拖拽、缩放、固定、目标语言快速切换、编辑原文后重新翻译、复制原文 / 译文、Esc 关闭。

### 截图翻译

按截图快捷键后拖拽框选屏幕区域，松开鼠标后进入截图翻译结果窗。结果窗左侧为原文，右侧为译文；原文可手动编辑后重新翻译，目标语言也可在结果窗中切换。

### OCR 模式选择

| 模式 | 原理 | 适合场景 | 注意事项 |
|------|------|----------|----------|
| A 单模型 | 多模态模型直接识别并翻译图片 | 复杂图片、中英文混排、希望一步完成 | 需要支持视觉的模型 |
| A 协作 | 视觉模型先 OCR，再交给文本模型翻译 | 想组合不同识别和翻译 Provider | 会产生两次 API 调用 |
| B Windows OCR | Windows.Media.Ocr 本地识别，再调用翻译模型 | 本地快速 OCR、隐私优先 | 依赖系统 OCR 语言包 |
| C Tesseract | Tesseract 本地 OCR，再调用翻译模型 | Windows OCR 不可用时离线兜底 | 需安装 Tesseract 和语言包 |

### 历史、缓存与用量

- 「历史」保存划词和截图翻译结果，便于搜索、复制、删除和回看。
- 翻译缓存保存原文哈希和译文，默认保留 24 小时 / 最多 1000 条。
- 用量日志只记录请求元数据、状态、耗时、字符/token/费用估算和错误摘要，不保存原文、译文或截图。

## 隐私与本地数据

- API Key 按 Provider 分开存入系统 keyring，不写入设置文件。
- 已保存的 API Key 不会返回给 WebView；Provider 请求和密钥读取由 Rust 原生网关完成。
- 翻译历史会在本机保存原文和译文，并使用当前 Windows 用户 DPAPI 加密。
- 翻译缓存同样使用 DPAPI 加密；缓存只用于本机短期复用，不会上传到 TransLoop 服务。
- 诊断日志、用量日志和诊断包不包含 API Key、原文、译文、截图或缓存译文正文。
- 选择云端 Provider 时，要翻译的文本或截图内容会发送给对应服务商处理。
- TransLoop 不提供云同步、团队统计或远程监控。

更完整的说明见 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### 提示未找到 Tesseract 怎么办？

OCR 模式 C 依赖本机 Tesseract。请安装 Tesseract OCR，并确认 `tesseract` 命令在 PATH 中；也可以切换到 OCR 模式 A 或 B。

### 当前 Provider 不支持图片输入怎么办？

截图模式 A 需要支持视觉的模型。可改用 OpenAI / Claude / Gemini / Qwen-VL / Grok 等支持图片输入的模型，或切换到 OCR 模式 B/C。

### API Key 会明文保存吗？

不会。API Key 保存在系统 keyring 中，设置导出和诊断包不会包含 API Key。

### 更新下载失败怎么办？

应用内更新只接受通过 Ed25519 签名清单和 SHA-256 校验的安装包。若 Release 缺少签名或校验失败，设置页会拒绝自动安装并保留「打开发布页」入口，可前往 GitHub Releases 手动下载安装包。

### 用量统计是账单吗？

不是。用量统计是本地估算，只用于观察请求趋势和大致成本，不代表服务商真实账单。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Tauri 2 (Rust) |
| 前端 | React 18 + TypeScript + Vite |
| 前端插件 | plugin-global-shortcut, plugin-clipboard-manager, plugin-store |
| Rust 依赖 | enigo, xcap, windows, keyring, reqwest, sha2, ed25519-dalek, tokio, serde |

## 开发

```bash
pnpm install
pnpm tauri dev
pnpm tauri build
```

若 `cargo install tauri-cli` 因权限或安全软件拦截失败，可使用项目内置的 `pnpm tauri ...`。

## 目录

```text
TransLoop/
├── index.html                  # 主窗口入口
├── popup.html                  # 划词悬浮窗入口
├── overlay.html                # 截图框选蒙层入口
├── capture.html                # 截图翻译结果窗入口
├── src/
│   ├── App.tsx                 # 主窗：双栏翻译器 + 工具栏
│   ├── SettingsModal.tsx        # 设置弹窗
│   ├── PopupView.tsx            # 划词悬浮窗
│   ├── OverlayView.tsx          # 框选蒙层
│   ├── CaptureView.tsx          # 截图结果窗
│   ├── translationRuntime.ts    # 统一翻译运行时
│   ├── nativeTranslation.ts     # Rust Provider 网关调用
│   ├── history.ts               # 翻译历史
│   ├── usage.ts                 # 用量记录
│   ├── diagnostics.ts           # 脱敏诊断日志
│   └── providers/               # Provider 元数据与 Prompt
└── src-tauri/
    ├── tauri.conf.json
    ├── Cargo.toml
    └── src/                     # Rust 命令、Provider、托盘、截图、OCR、keyring、DPAPI
```

## 配置文件位置

Windows 默认数据目录：`%APPDATA%\com.transloop.app\`

- `settings.json`：非密钥设置。
- Windows Credential Manager：按 Provider 保存 API Key，位置不在应用数据文件中。
- `history.secure.json`：DPAPI 加密的翻译历史，包含原文和译文。
- `usage.json`：请求元数据和用量估算，不含正文。
- `translation-cache.secure.json`：DPAPI 加密的短期缓存，保存原文哈希和译文。
- `diagnostics.json`：脱敏诊断日志。

## 已知约束

- 划词依赖剪贴板读取，个别受保护窗口可能漏读。
- OCR 模式 B 依赖 Windows 系统 OCR 语言包。
- OCR 模式 C 依赖 Tesseract OCR 和对应语言包。
- 智能语言方向使用轻量本地规则，不额外调用模型。
- 用量统计为本地估算，不等同于服务商账单。
- 应用内更新为检查新版本、下载安装包并启动安装程序，不做静默自动更新。

## 路线图

| 阶段 | 目标 | 状态 |
|------|------|------|
| 1 | 脚手架 + 划词翻译 + 主窗双栏 + 托盘 + DeepSeek | ✅ |
| 2 | 截图框选 + OCR 模式 A/B + 分屏展示窗 + 多模型协作 + 快捷键录制 | ✅ |
| 3 | 全部 7 家 Provider 真实实现 + API Key keyring 按提供方加密 | ✅ |
| 4 | 开机自启 + NSIS 安装包 | ✅ |
| 5 | OCR 增强 + 翻译历史 | ✅ |
| 6 | Provider 连通性测试 + 备用模型降级 + 用量统计 | ✅ |
| 7 | 划词悬浮窗增强 + 智能语言方向 + 翻译缓存 | ✅ |
| 8 | 自动更新 + 首次启动引导 + 诊断日志 + 设置导入/导出 | ✅ |
| 9 | 0.9.0 RC：正式版候选收尾 + 稳定性回归 + 发布验证 | ✅ |
| 10 | 1.0.0 正式版：Windows 桌面翻译正式稳定版 | ✅ |
| 11 | 1.0.1：凭证、数据、网络、IPC 与更新链路安全加固 | ✅ |

## 后续计划

- `1.0.x`：只修复用户反馈、安装升级、OCR 异常和 Provider 错误提示。
- `1.1.0`：优先增强 OCR 质量、段落恢复、表格 / 代码块结构保留。
- `1.2.0`：考虑历史收藏、术语表、常用目标语言和复制格式优化。
- 不恢复浏览器插件路线；不在 1.0.x 中加入云同步、团队统计或远程监控。

## 更新日志

### 1.0.1 · 2026-07-16 — 安全加固更新

- **凭证隔离**：Provider API Key 仅保存在 Windows Credential Manager，由 Rust 原生网关读取，不再返回 WebView。
- **本地数据保护**：翻译历史与缓存使用当前 Windows 用户的 DPAPI 加密，日志、诊断和用量数据统一脱敏。
- **网络与 IPC 防护**：Provider 请求限制官方 HTTPS 域名、禁止重定向，并增加大小、并发、频率和窗口标签校验。
- **可信更新**：应用先验证 Ed25519 签名清单，再验证安装包 SHA-256；失败时只精确删除本次更新文件并拒绝执行。
- **合规文档**：补充隐私政策入口、CSP、安全说明和签名发布流程，发布检查见 `docs/release-checklist-1.0.1.md`。

### 1.0.0 · 2026-07-09 — 正式版

- **正式发布**：TransLoop 进入 Windows 桌面划词翻译与截图 OCR 翻译正式稳定版。
- **文档正式化**：README 改为面向用户的下载、快速开始、核心功能、隐私和 FAQ 说明。
- **隐私说明**：新增 `PRIVACY.md`，明确本地数据、Provider 请求、诊断包和设置导出的边界。
- **发布检查**：新增 `docs/release-checklist-1.0.0.md`，覆盖构建、安装升级、核心回归、隐私和 GitHub Release 验证。

### 0.9.0 · 2026-07-03 — RC：正式版候选收尾

- **版本收口**：统一应用版本为 `0.9.0`，新增 RC 发布说明和发布检查清单，为 `1.0.0` 正式版做稳定性准备。
- **错误提示统一**：主窗口、划词翻译、截图翻译、Provider 测试、更新下载、设置导入和诊断包导出会把常见底层错误转换为更可读的用户提示。
- **Provider 分类增强**：运行时增强 HTTP 状态、限流、网络、超时、空响应和缺 Key 的错误归类，便于自动降级、用量记录和诊断日志排查。
- **隐私边界复核**：继续保持诊断日志、诊断包、设置导出和用量日志不包含 API Key、原文、译文、截图或缓存译文正文。

### 0.8.4 · 2026-07-03 — OCR A 结构化结果清洗

- **OCR A 原文清洗**：多模型协作识别结果会自动清洗 JSON 数组、JSON 对象、HTML 和 Markdown 代码块，只保留可读原文。
- **结构化 OCR 兼容**：支持提取 `text`、`original`、`source`、`content` 等字段，避免 `rotate_rect` / HTML 标签直接出现在原文区域。
- **识别 Prompt 加固**：纯 OCR 识别提示词明确禁止 JSON、HTML、Markdown、坐标框和结构化标签输出。

更早版本记录可查看 `docs/archive/README-0.9.0-RC.md`。
