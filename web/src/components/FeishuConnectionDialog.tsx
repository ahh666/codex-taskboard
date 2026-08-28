import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { FeishuConnection } from "../types";
import { LinearIcon } from "./LinearIcon";

interface FeishuConnectionDialogProps {
  connection: FeishuConnection | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onAuthorize: () => Promise<void>;
  onCancelAuthorization: () => Promise<void>;
  onSaveView: (viewUrl: string) => Promise<void>;
}

export function FeishuConnectionDialog({
  connection,
  saving,
  error,
  onClose,
  onAuthorize,
  onCancelAuthorization,
  onSaveView,
}: FeishuConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [viewUrl, setViewUrl] = useState(connection?.viewUrl ?? "");

  useEffect(() => {
    setViewUrl(connection?.viewUrl ?? "");
  }, [connection?.viewUrl]);

  async function saveView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSaveView(viewUrl.trim());
  }

  async function refreshAuthorization() {
    await onCancelAuthorization();
    await onAuthorize();
  }

  const pending = connection?.authorizationState === "pending";
  const authorized = connection?.authorized === true;
  const failed = connection?.authorizationState === "failed";
  const unavailable = connection?.cliAvailable === false;
  const visibleError = error ?? (failed || unavailable ? connection?.error : null);
  const authorizationExpiry = connection?.authorizationExpiresAt
    ? new Date(connection.authorizationExpiresAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className="delete-backdrop feishu-connection-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="delete-dialog feishu-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feishu-connection-title"
        onSubmit={(event) => void saveView(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <header className="feishu-dialog-header">
          <span className="feishu-dialog-brand" aria-hidden="true">飞</span>
          <span className="feishu-dialog-heading">
            <h2 id="feishu-connection-title">
              {connection?.configured
                ? text("飞书需求设置", "Feishu requirement settings")
                : text("接入飞书需求", "Connect Feishu requirements")}
            </h2>
            <span>{text("授权账号并选择需要同步的需求视图", "Authorize an account and choose a requirement view")}</span>
          </span>
          <button
            className="feishu-dialog-close"
            type="button"
            disabled={saving}
            aria-label={text("关闭", "Close")}
            title={text("关闭", "Close")}
            onClick={onClose}
          >
            <LinearIcon name="close" />
          </button>
        </header>

        <nav className="feishu-dialog-progress" aria-label={text("接入步骤", "Connection steps")}>
          <span className={`feishu-dialog-step ${authorized ? "is-complete" : "is-active"}`} aria-current={!authorized ? "step" : undefined}>
            <span className="feishu-dialog-step-number" aria-hidden="true">
              {authorized ? <LinearIcon name="check" /> : "1"}
            </span>
            <span>{text("扫码授权", "Scan to authorize")}</span>
          </span>
          <span className={`feishu-dialog-progress-line ${authorized ? "is-complete" : ""}`} aria-hidden="true" />
          <span className={`feishu-dialog-step ${authorized ? "is-active" : ""}`} aria-current={authorized ? "step" : undefined}>
            <span className="feishu-dialog-step-number" aria-hidden="true">2</span>
            <span>{text("选择视图", "Choose view")}</span>
          </span>
        </nav>

        <main className={`feishu-dialog-main ${authorized ? "is-authorized" : ""}`}>
          <section className="feishu-qr-panel" aria-label={authorized ? text("授权完成", "Authorization complete") : text("飞书授权二维码", "Feishu authorization QR code")}>
            {authorized ? (
              <div className="feishu-authorized-visual">
                <span className="feishu-authorized-check" aria-hidden="true"><LinearIcon name="check" /></span>
                <strong>{text("授权完成", "Authorized")}</strong>
                <span>{connection?.displayName ?? text("飞书账号已连接", "Feishu account connected")}</span>
              </div>
            ) : pending && connection?.authorizationQrCode ? (
              <div className="feishu-qr-frame">
                <img
                  className="feishu-qr-code"
                  src={connection.authorizationQrCode}
                  alt={text("飞书授权二维码", "Feishu authorization QR code")}
                />
              </div>
            ) : (
              <div className="feishu-qr-empty" aria-hidden="true">
                <span>QR</span>
              </div>
            )}
          </section>

          <section className="feishu-dialog-details">
            <span className="feishu-dialog-eyebrow">
              {authorized ? text("步骤 2 · 选择视图", "Step 2 · Choose view") : text("步骤 1 · 扫码授权", "Step 1 · Scan to authorize")}
            </span>

            {authorized ? (
              <>
                <h3>{text("选择要同步的需求视图", "Choose a requirement view")}</h3>
                <p className="feishu-connection-help">
                  {text("粘贴飞书项目中的需求视图 URL，保存后会立即同步当前项目。", "Paste a Feishu Project requirement view URL to sync it with this project.")}
                </p>
                <div className="feishu-dialog-status is-success">
                  <span className="feishu-status-dot" aria-hidden="true" />
                  <span>{text("已授权", "Authorized")}</span>
                  {connection?.displayName && <strong>{connection.displayName}</strong>}
                </div>
                <label className="feishu-connection-field">
                  <span>{text("需求视图 URL", "Requirement view URL")}</span>
                  <input
                    type="url"
                    value={viewUrl}
                    onChange={(event) => setViewUrl(event.target.value)}
                    placeholder="https://project.feishu.cn/空间/storyView/视图ID"
                    disabled={saving}
                    required
                  />
                </label>
              </>
            ) : (
              <>
                <h3>
                  {pending
                    ? text("使用飞书移动端扫码", "Scan with the Feishu mobile app")
                    : failed
                      ? text("重新生成授权二维码", "Generate a new authorization QR code")
                      : text("生成飞书授权二维码", "Generate a Feishu authorization QR code")}
                </h3>
                <p className="feishu-connection-help">
                  {unavailable
                    ? text("当前安装包缺少飞书项目登录组件。", "This installation is missing the Feishu Project login component.")
                    : pending
                      ? text("打开飞书移动端扫描左侧二维码，授权完成后会自动进入下一步。", "Scan the QR code with Feishu. This dialog advances automatically when authorization completes.")
                      : text("二维码只用于本次授权，不会保存到项目配置。", "The QR code is used only for this authorization and is not saved to project settings.")}
                </p>
                <div className={`feishu-dialog-status ${pending ? "is-pending" : failed || unavailable ? "is-error" : ""}`}>
                  <span className="feishu-status-dot" aria-hidden="true" />
                  <span>
                    {pending
                      ? text("等待扫码", "Waiting for scan")
                      : failed
                        ? text("授权未完成", "Authorization incomplete")
                        : unavailable
                          ? text("登录组件不可用", "Login component unavailable")
                          : text("尚未开始", "Not started")}
                  </span>
                  {pending && authorizationExpiry && (
                    <strong>{text(`${authorizationExpiry} 前有效`, `Valid until ${authorizationExpiry}`)}</strong>
                  )}
                </div>
                {pending && connection?.authorizationUrl && (
                  <a className="feishu-connection-link" href={connection.authorizationUrl} target="_blank" rel="noreferrer">
                    <LinearIcon name="openExternal" />
                    <span>{text("无法扫码？打开授权页", "Can't scan? Open the authorization page")}</span>
                  </a>
                )}
              </>
            )}

            {visibleError && <p className="project-dialog-error feishu-dialog-error" role="alert">{visibleError}</p>}
          </section>
        </main>

        <footer className="feishu-dialog-footer">
          <span className="feishu-dialog-product">Taskboard <i aria-hidden="true" /> {text("飞书项目", "Feishu Project")}</span>
          <span className="feishu-dialog-footer-actions">
            {authorized ? (
              <>
                <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
                  {text("取消", "Cancel")}
                </button>
                <button className="button secondary" type="button" disabled={saving} onClick={() => void onAuthorize()}>
                  {text("重新授权", "Reauthorize")}
                </button>
                <button className="button primary" type="submit" disabled={saving || !viewUrl.trim()}>
                  {saving ? text("同步中…", "Syncing…") : text("保存并同步", "Save and sync")}
                </button>
              </>
            ) : pending ? (
              <>
                <button className="button secondary" type="button" disabled={saving} onClick={() => void onCancelAuthorization()}>
                  {text("取消授权", "Cancel authorization")}
                </button>
                <button className="button primary" type="button" disabled={saving} onClick={() => void refreshAuthorization()}>
                  {saving ? text("生成中…", "Generating…") : text("刷新二维码", "Refresh QR code")}
                </button>
              </>
            ) : (
              <>
                <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
                  {text("取消", "Cancel")}
                </button>
                <button className="button primary" type="button" disabled={saving || !connection?.authorizationReady} onClick={() => void onAuthorize()}>
                  {saving ? text("生成中…", "Generating…") : text("生成二维码", "Generate QR code")}
                </button>
              </>
            )}
          </span>
        </footer>
      </form>
    </div>
  );
}
