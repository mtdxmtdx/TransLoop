# TransLoop 0.8.4

## 修复

- 修复 OCR A 多模型协作时，识别模型返回 JSON / HTML 后被直接显示在「原文」区域的问题。
- 新增 OCR 识别结果清洗：支持从 JSON 数组、JSON 对象、HTML、Markdown 代码块中提取纯文本。
- 强化纯 OCR 识别提示词，明确禁止返回 JSON、HTML、Markdown、坐标框、`rotate_rect` 等结构化内容。

## 说明

- 本版本主要面向截图翻译 OCR A 体验修复。
- 如果模型仍偶发返回结构化 OCR 内容，TransLoop 会尽量提取其中的 `text` / `original` / `source` / `content` 字段作为原文。

## 安装包

- Windows x64 NSIS 安装包：`TransLoop_0.8.4_x64-setup.exe`
