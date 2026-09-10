# TransLoop 1.0.5

## 定位

TransLoop 1.0.5 是面向 Windows 桌面划词翻译与截图 OCR 翻译的功能更新，全面取消截图翻译 Provider 对 DeepSeek 模型名称的限制，支持 DeepSeek 系列模型直接进行多模态视觉理解与图片翻译。

## 修复与改进

- **DeepSeek 全面多模态放行**：解除对 DeepSeek 必须匹配特定实验模型名称（如 `deepseek-v4-flash-vision-exp`）的限制，DeepSeek 所有模型均支持图片输入与视觉翻译。
- **默认视觉模型对齐**：DeepSeek 提供方的默认视觉模型同步为 `deepseek-v4-flash`。
- **原生网关同步**：底层 Rust 请求网关中的 `supports_vision` 多模态校验放行所有 DeepSeek 模型请求。
- **设置界面体验优化**：更新设置界面多模态提示信息，与其他多模态 Provider（OpenAI / Claude / Gemini 等）保持一致。

## 升级说明

- 可从 `1.0.4` 直接安装升级到 `1.0.5`。
- 设置、Credential Manager 中的 Provider API Key、历史、缓存和快捷键会继续保留在本机。
- 应用内更新不做静默安装；验证成功后才启动 NSIS 安装程序。

## 安装包

- Windows x64 NSIS 安装包：`TransLoop_1.0.5_x64-setup.exe`
- 更新校验资产：`SHA256SUMS`、`SHA256SUMS.sig`
