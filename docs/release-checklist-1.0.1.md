# TransLoop 1.0.1 发布检查清单

## 自动化与本地构建

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm security:check`
- [ ] `pnpm exec tsc -b`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `pnpm build`
- [ ] 注入生产更新公钥后执行 `pnpm tauri build -- --bundles nsis`
- [ ] 确认生成 `src-tauri/target/release/bundle/nsis/TransLoop_1.0.1_x64-setup.exe`
- [ ] 使用生产私钥本地生成并验证 `SHA256SUMS` 和 `SHA256SUMS.sig`，不得输出或复制私钥到仓库。

## 安装与升级

- [ ] 从 1.0.0 安装升级到 1.0.1，确认设置、Credential Manager API Key、历史、缓存和快捷键仍可用。
- [ ] 新安装后首次引导自动打开，隐私政策入口可访问。
- [ ] 手动启动、托盘关闭 / 恢复、开机自启和卸载正常。

## 核心回归

- [ ] 主窗口、划词和截图 OCR A/B/C 翻译正常。
- [ ] Provider 测试、备用模型 / Provider 降级、取消和并发请求正常。
- [ ] 历史与缓存可读写，旧明文 API Key 迁移后不再残留于设置文件。
- [ ] 诊断包、设置导出和用量日志不包含 API Key、Token、原文、译文、截图或缓存正文。

## 更新安全回归

- [ ] 先验证 `SHA256SUMS.sig`，签名失败时不下载安装包。
- [ ] 签名通过后验证安装包 SHA-256，哈希不匹配时拒绝写入和执行。
- [ ] 启动安装前再次计算 SHA-256；文件被替换、版本不符或读取失败时拒绝执行。
- [ ] 失败清理只删除固定更新目录中目标版本的 `.download` 或最终安装包，不删除邻近文件、目录外同名文件或同名目录。
- [ ] 未注入 `TRANSLOOP_UPDATE_PUBLIC_KEY_HEX` 的构建保持失败封闭。

## GitHub 发布

- [ ] GitHub Actions Secrets 已配置 `TRANSLOOP_UPDATE_PUBLIC_KEY_HEX` 和 `TRANSLOOP_UPDATE_SIGNING_PRIVATE_KEY`。
- [ ] Tag 必须为 `v1.0.1`，且与应用版本一致。
- [ ] Release 正文使用 `RELEASE_NOTES_1.0.1.md`。
- [ ] Release 上传 `TransLoop_1.0.1_x64-setup.exe`、`SHA256SUMS` 和 `SHA256SUMS.sig`。
- [ ] 发布后从 GitHub 下载三项资产并独立复核签名和 SHA-256。
