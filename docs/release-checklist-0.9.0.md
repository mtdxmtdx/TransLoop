# TransLoop 0.9.0 RC 发布检查清单

## 构建

- [ ] `npm run build`
- [ ] `cargo check`
- [ ] `npm run tauri -- build --config .tauri-build-override.json`
- [ ] 确认生成 `src-tauri/target/release/bundle/nsis/TransLoop_0.9.0_x64-setup.exe`

## 安装与升级

- [ ] 从 0.8.x 安装升级到 0.9.0，确认设置、keyring、历史、缓存和快捷键仍可用。
- [ ] 手动启动显示主窗口；托盘关闭/恢复正常。
- [ ] 开机自启开启后不会弹出主窗口，只驻留托盘。

## 核心回归

- [ ] 主窗口翻译：自动检测、手动语言、缓存命中、Provider 失败降级。
- [ ] 划词翻译：固定窗口、目标语言切换、编辑原文后重译、复制原文/译文、Esc 关闭。
- [ ] 截图翻译：OCR A/B/C、目标语言切换、编辑原文后重译、复制原文/译文、历史保存。
- [ ] 用量面板：7/30/90 天统计、状态筛选、缓存命中统计、CSV 导出、清空记录。
- [ ] 设置页：Provider 测试、更新检查、导出诊断包、导入/导出设置、重新打开引导。

## 失败路径

- [ ] 缺 API Key、错误 API Key、错误模型名、断网、超时、429、5xx 都显示可读提示。
- [ ] OCR A 返回 JSON/HTML/Markdown 时只显示纯原文。
- [ ] Tesseract 未安装时显示安装和 PATH 提示。
- [ ] Windows OCR 语言包不可用时提示切换 OCR 模式或安装语言包。
- [ ] 更新下载失败时显示失败原因，并保留打开 Release 页兜底。
- [ ] 设置导入非法字段时回退默认值，不破坏应用启动。

## 隐私与发布

- [ ] 诊断包不包含 API Key、原文、译文、截图、translation-cache 译文。
- [ ] 设置导出不包含 keyring API Key。
- [ ] usage 日志只包含元数据、状态、耗时、字符/token/费用估算。
- [ ] GitHub Release 正文使用 `RELEASE_NOTES_0.9.0.md`。
- [ ] GitHub Release 上传 `TransLoop_0.9.0_x64-setup.exe`。
