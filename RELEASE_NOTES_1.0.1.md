# TransLoop 1.0.1

## 定位

TransLoop 1.0.1 是面向 Windows 桌面划词翻译与截图 OCR 翻译的安全加固更新。本版本不新增大型产品功能，重点收紧凭证、本地数据、Provider 网络访问、IPC 和应用内更新的安全边界。

## 安全改进

- Provider API Key 仅保存到 Windows Credential Manager，并由 Rust 原生网关读取；密钥不再返回 WebView。
- 旧版设置中的明文 API Key 会在迁移前从设置持久化数据中移除，再写入系统凭证存储。
- 翻译历史和缓存使用当前 Windows 用户的 DPAPI 加密。
- Provider 请求仅允许官方 HTTPS 域名、禁止重定向，并限制响应大小、并发数和请求频率。
- 敏感 IPC 命令校验调用窗口标签，日志、诊断包和用量数据统一脱敏。
- 增加内容安全策略、隐私政策入口和安全说明文档。

## 更新完整性

- 应用先验证 `SHA256SUMS.sig` 的 Ed25519 签名，再下载并验证安装包 SHA-256。
- 签名、哈希、写入、状态保存或启动前复核任一步失败，都会拒绝执行安装包。
- 清理逻辑只直接删除固定更新目录中与目标版本完整文件名匹配的文件，不使用通配符、递归删除或目录删除。
- 生产构建必须注入 `TRANSLOOP_UPDATE_PUBLIC_KEY_HEX`；未注入时应用内更新保持关闭并失败封闭。

## 升级说明

- 可从 `1.0.0` 直接安装升级到 `1.0.1`。
- 设置、Credential Manager 中的 Provider API Key、历史、缓存和快捷键会继续保留在本机。
- 应用内更新不做静默安装；验证成功后才启动 NSIS 安装程序。

## 安装包

- Windows x64 NSIS 安装包：`TransLoop_1.0.1_x64-setup.exe`
- 更新校验资产：`SHA256SUMS`、`SHA256SUMS.sig`
