interface Props {
  open: boolean;
  onClose: () => void;
  onAcknowledge?: () => void;
}

export function PrivacyModal({ open, onClose, onAcknowledge }: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-panel privacy-panel" onClick={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <h2>隐私政策</h2>
            <p>TransLoop 1.0.0 · 本地桌面应用</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭">
            ×
          </button>
        </header>
        <div className="settings-body privacy-body">
          <h3>本地保存</h3>
          <p>
            API Key 仅保存于 Windows 凭据管理器。翻译历史、截图缩略图和短期缓存使用当前 Windows
            用户绑定的 DPAPI 加密存储；设置、用量和诊断文件不包含 API Key。
          </p>
          <h3>Provider 请求</h3>
          <p>
            选择云端 Provider 后，待翻译文本或截图会发送给对应服务商。请求由 Rust 本地组件发起，
            WebView 不持有 API Key。Provider 的数据处理规则以其隐私政策和 API 条款为准。
          </p>
          <h3>诊断和保留</h3>
          <p>
            诊断日志默认关闭。开启后只记录运行状态、Provider、模型、耗时、错误类型和脱敏摘要，
            不记录原文、译文、截图或缓存正文；诊断日志最多保留 14 天。
          </p>
          <p>
            数据默认位于当前用户的应用数据目录。历史最多保存 200 条，缓存最多保存 24 小时/1000 条；你可以在历史、用量和设置页面删除这些数据。
          </p>
        </div>
        <footer className="modal-footer">
          <div className="spacer" />
          <button
            className="primary"
            onClick={() => {
              onAcknowledge?.();
              onClose();
            }}
          >
            知道了
          </button>
        </footer>
      </div>
    </div>
  );
}
