# TransLoop（译环）

桌面端翻译工具。两种使用方式：

1. **划词翻译**：在任意应用选中文字 → 按全局快捷键（默认 `Alt+Q`）→ 光标附近弹出无边框悬浮窗显示译文。
2. **主窗翻译**：左侧粘贴/输入文字，右侧实时显示译文。停止输入 600 ms 后自动调用模型。

主窗关闭按钮会把窗口隐藏到系统托盘；系统最小化仍走 Windows 默认行为（到任务栏）。


---

## 技术栈

- **Tauri 2** (Rust) + **React 18 + TypeScript + Vite**
- 前端：`@tauri-apps/api`、`plugin-global-shortcut`、`plugin-clipboard-manager`、`plugin-store`、`plugin-http`
- Rust：`enigo`（模拟 `Ctrl+C`）、`tokio`、`serde`、Tauri `tray-icon` feature

## 目录

```
TransLoop/
├── index.html / popup.html        # 主窗口 + 划词悬浮窗
├── src/
│   ├── App.tsx                    # 主窗（左输入 / 右译文 / 顶部工具栏）
│   ├── SettingsModal.tsx          # 由齿轮按钮唤起的设置弹窗
│   ├── PopupView.tsx              # 划词悬浮窗
│   ├── store.ts                   # tauri-plugin-store 封装
│   ├── styles.css
│   └── providers/
│       ├── types.ts               # TranslationProvider 接口 + 注册表
│       ├── deepseek.ts            # 默认实现
│       ├── stubs.ts               # OpenAI/Claude/Gemini/Qwen/Grok/MiniMax 占位
│       └── index.ts               # createProvider 工厂
└── src-tauri/
    ├── tauri.conf.json
    ├── capabilities/default.json
    └── src/
        ├── main.rs / lib.rs       # 入口、命令、托盘、窗口事件拦截
        ├── shortcut.rs            # 解析并注册全局快捷键
        ├── selection.rs           # 释放修饰键 → 模拟 Ctrl+C → 轮询剪贴板
        └── popup.rs               # 在光标位置展示悬浮窗
```

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发模式（带 HMR）
pnpm tauri build    # 生产构建（NSIS 安装包尚未启用，详见路线图）
```

> 本机环境若 `cargo install tauri-cli` 因权限被杀软拦截，使用项目内置的 `pnpm tauri ...` 即可，无需全局安装。

## 使用

### 主窗

1. 启动后即看到双栏翻译界面。首次使用点右上角 **⚙** 打开设置：
   - 选 Provider（默认 DeepSeek，`https://platform.deepseek.com` 获取 key）
   - 填 *API Key*
   - 可选：调整 *Base URL* 走中转、改 *Model*、修改全局快捷键
2. 顶栏可切换源/目标语言，**⇄** 一键互换。
3. 在左栏输入或粘贴文字，停止输入约 0.6 秒后右栏自动出现译文。
4. 点 × 把窗口隐到系统托盘；左键点击托盘图标或右键菜单"显示主窗口"可重新唤出；右键菜单选"退出"才真正关闭进程。

### 划词翻译

1. 在任何应用里选中文字。
2. 按全局快捷键（默认 `Alt+Q`，可在设置里改成例如 `Ctrl+Shift+T`）。
3. 光标附近弹出无边框悬浮窗：
   - 顶栏拖拽可移动位置，四边/四角拖拽可调整大小。
   - 点 × 或按 `Esc` 关闭；不会自动消失。

## 配置文件位置

`%APPDATA%\com.transloop.app\settings.json`（Windows）

包含字段：`hotkey`、`provider`、`apiKey`（明文，后续阶段计划改 OS keyring）、`baseUrl`、`model`、`fromLang`、`toLang`。

## 已知约束

- 划词依赖剪贴板：会临时覆盖剪贴板内容（哨兵串），完成后恢复用户原有内容。
- 个别应用（部分老版本 Office、某些受 UIPI 保护的窗口）对 `Ctrl+C` 响应慢或被拦截，可能漏读，重试一次即可。
- API Key 目前以明文存盘。
- 占位 Provider（OpenAI / Claude / Gemini / Qwen / Grok / MiniMax）只是注册了名字和默认配置，调用 `translate()` 会抛"尚未实现"错误。

---

## 更新日志

### 0.1.0 · 2026-05-24

**阶段 1：划词翻译 MVP**

- Tauri 2 + React + TS 脚手架，双窗口（主窗 + 悬浮窗）。
- 全局快捷键注册（默认 `Alt+Q`，运行时可改）。
- 划词捕获：模拟 `Ctrl+C` + 剪贴板轮询；触发前先释放可能仍按住的修饰键以避免组合键误判；用哨兵串区分"复制成功 / 内容相同"。
- 光标定位悬浮窗：从 `app.cursor_position()` 计算，自动避开屏幕边界。
- 悬浮窗交互演进：
  - 0.1.0-a：3 秒无操作自动关闭，鼠标 hover 暂停计时。
  - 0.1.0-b：取消自动关闭；右上角加 × 手动关闭；顶栏可拖拽；四边四角可缩放。
- 主窗演进：
  - 0.1.0-a：纯设置页（快捷键 / Provider / API Key / Base URL / Model / 源语言 / 目标语言）。
  - 0.1.0-b：改为「左输入 / 右译文」双栏翻译器，顶部 lang/swap/⚙，设置移入模态框，输入 debounce 自动翻译。
- 系统托盘：图标 + 菜单（显示主窗口 / 退出），左键单击 = 显示主窗。
- 主窗 × 拦截：`CloseRequested` 不退出，仅 `hide()`。
- Provider 适配层：`TranslationProvider` 接口、注册表、`createProvider` 工厂、DeepSeek 实现、其余 6 家占位。
- 设置持久化：`tauri-plugin-store`，`%APPDATA%\com.transloop.app\settings.json`。

---

## 路线图

| 阶段 | 目标 | 状态 |
|------|------|------|
| 1 | 脚手架 + 划词翻译 + 主窗双栏 + 托盘 | ✅ 已完成 |
| 2 | 截图框选 + OCR 模式 A（多模态）/ B（Windows 系统 OCR）+ 分屏展示窗 | ⏳ 待开始 |
| 3 | 多模型完整适配（OpenAI / Claude / Gemini / Qwen / Grok / MiniMax 真实实现）+ API Key 加密（OS keyring） | ⏳ 部分（接口 + DeepSeek 已落地） |
| 4 | 开机自启 + 完整托盘菜单 + NSIS 安装包打包 | ⏳ 待开始（基础托盘已有） |
| 5 | 浏览器插件（Manifest V3） + 与桌面端 WebSocket 联动 + OCR 模式 C（Tesseract）/ D（第三方） | ⏳ 待开始 |

### 计划中的细节增强

- 划词翻译"重试"按钮（API 失败时）。
- 翻译历史 / 收藏。
- 主窗增加流式输出（逐字显示）。
- 悬浮窗位置/尺寸记忆。
- 多语言界面（i18n）。
- 自定义 system prompt（专业术语词汇表）。

