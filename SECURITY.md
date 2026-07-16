# TransLoop 安全边界

## 凭证

用户 API Key 只保存在 Windows Credential Manager（keyring）中。前端只接收“已配置/未配置”状态；Provider 网络请求和密钥读取均在 Rust 网关完成。

发布签名私钥不得进入仓库、安装包或 `.env` 文件，必须配置为 GitHub Actions Secret。生产构建通过 `TRANSLOOP_UPDATE_PUBLIC_KEY_HEX` 注入对应公钥；Release 工作流使用 `TRANSLOOP_UPDATE_SIGNING_PRIVATE_KEY` 生成 `SHA256SUMS` 和 `SHA256SUMS.sig`。更新器只接受固定仓库的 HTTPS 资产，并要求 Ed25519 签名清单和安装包 SHA-256 校验同时通过。未注入公钥时自动更新会安全地拒绝安装，而不会回退到未校验下载。

## 本地数据

翻译历史和缓存保存于应用数据目录，并使用当前 Windows 用户 DPAPI 加密。设置、用量和诊断只保存经过字段白名单及脱敏处理的元数据。诊断导出前还会再次进行脱敏检查。

## 报告问题

请不要在公开 Issue 中粘贴 API Key、诊断包、历史记录或截图。报告安全问题时请提供复现步骤、受影响版本和最小化的日志片段。
