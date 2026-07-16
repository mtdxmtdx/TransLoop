# TransLoop 隐私说明

TransLoop 是本地桌面应用，不提供云同步、团队统计或远程监控。本说明解释应用会保存什么数据、什么数据会发送给 Provider，以及导出文件中不会包含哪些内容。

## API Key

- API Key 按 Provider 分开保存到系统 keyring（Windows 凭据管理器）。
- API Key 不写入 `settings.json`。
- 设置导出、诊断包和用量日志不会包含 API Key。

## 本地保存的数据

TransLoop 的本地数据默认位于 `%APPDATA%\com.transloop.app\`。

- `settings.json`：保存快捷键、Provider、模型、OCR 模式、智能方向、缓存开关、自动降级等非密钥设置。
- `history.secure.json`：保存翻译历史，包含用户实际看到的原文、译文和可选截图缩略图；使用当前 Windows 用户 DPAPI 加密。
- `translation-cache.secure.json`：保存短期缓存，包含原文哈希、译文、语言方向、创建时间和命中次数；使用当前 Windows 用户 DPAPI 加密，不保存原文正文。
- `usage.json`：保存请求元数据、状态、耗时、字符/token/费用估算和错误摘要；不保存原文、译文或截图。
- `diagnostics.json`：保存脱敏诊断日志，只记录运行状态、Provider/模型、耗时、版本、平台和错误摘要。

## 会发送给 Provider 的内容

当你使用云端 Provider 时，TransLoop 会把完成当前任务所需的内容发送给你选择的服务商。

- 文本翻译会发送待翻译文本和语言方向。
- 截图模式 A 会发送截图内容给支持视觉的模型。
- 截图模式 B/C 会先在本机 OCR，再把识别出的文字发送给翻译 Provider。
- Provider 的数据处理规则以对应服务商的隐私政策和 API 条款为准。

## 诊断包和设置导出

诊断包包含：应用版本、平台信息、Tesseract 检测结果、脱敏设置、诊断日志和用量汇总。

诊断包和设置导出不会包含：

- API Key
- 原文
- 译文
- 截图图片
- 翻译历史正文
- translation-cache 中的译文正文

## 用户可控操作

- 可在历史面板删除单条历史或清空全部历史。
- 可在用量面板清空用量日志。
- 可在设置页清空翻译缓存。
- 可关闭诊断日志。
- 可导出非密钥设置，并在新环境中导入后重新填写 API Key。

首次使用云端 Provider 或截图模式 A 时，待翻译文本或截图会发送给所选 Provider；应用不会将 API Key 发送给 WebView 或写入导出文件。

## 已知边界

- 划词翻译依赖剪贴板读取，会临时复制选中文字并尝试恢复原剪贴板内容。
- 如果你选择云端 Provider，待翻译文本或截图会离开本机发送给该 Provider。
- TransLoop 的用量费用是本地估算，不代表服务商真实账单。
