# TransLoop 1.0.3

## 定位

TransLoop 1.0.3 是面向 Windows 桌面划词翻译与截图 OCR 翻译的功能更新，新增对 DeepSeek 官方视觉模型 `deepseek-v4-flash-vision-exp` 的全面支持与配置体验优化。

## 改进与特性

- **DeepSeek 视觉多模态支持**：支持选择 DeepSeek 的 `deepseek-v4-flash-vision-exp` 进行截图 OCR 与图片翻译。
- **模式 A 体验优化**：当选择 DeepSeek 提供方且模型配置为 `deepseek-v4-flash-vision-exp` 时，自动解除“当前翻译提供方不支持图片输入”的限制与警告提示。
- **多模型协作识别支持**：在 OCR 模式 A「多模型协作」的识别提供方列表中加入 DeepSeek，并自动预填默认视觉模型。
- **Rust 原生网关同步**：更新底层 Rust 请求网关中的多模态支持判定，保障 DeepSeek 视觉请求能够正常流式执行。
- **本地用量估算**：在本地用量与费用统计中补充 `deepseek-v4-flash-vision-exp` 模型定价。

## 升级说明

- 可从 `1.0.2` 直接安装升级到 `1.0.3`。
- 设置、Credential Manager 中的 Provider API Key、历史、缓存和快捷键会继续保留在本机。
- 应用内更新不做静默安装；验证成功后才启动 NSIS 安装程序。

## 安装包

- Windows x64 NSIS 安装包：`TransLoop_1.0.3_x64-setup.exe`
- 更新校验资产：`SHA256SUMS`、`SHA256SUMS.sig`
