import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { FeishuConnection } from "../types";

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

  const pending = connection?.authorizationState === "pending";
  const authorized = connection?.authorized === true;
  const authorizationExpiry = connection?.authorizationExpiresAt
    ? new Date(connection.authorizationExpiresAt).toLocaleTimeString()
    : null;

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="delete-dialog project-create-dialog feishu-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feishu-connection-title"
        onSubmit={(event) => void saveView(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="feishu-connection-title">
          {connection?.configured ? text("飞书需求设置", "Feishu requirement settings") : text("接入飞书需求", "Connect Feishu requirements")}
        </h2>
        <p className="feishu-connection-help">
          {!connection?.cliAvailable
            ? connection?.error ?? text("当前安装包缺少飞书项目登录组件。", "This installation is missing the Feishu Project login component.")
            : authorized
              ? text(`已授权${connection?.displayName ? `：${connection.displayName}` : ""}`, `Authorized${connection?.displayName ? `: ${connection.displayName}` : ""}`)
              : text("点击接入后使用飞书扫码或授权链接登录。", "Click connect to sign in with a Feishu QR code or authorization link.")}
        </p>

        {pending && (
          <div className="feishu-authorization-pending">
            <p className="feishu-connection-help">{text("请扫码或打开授权链接完成飞书项目登录。", "Scan the QR code or open the authorization link to sign in.")}</p>
            {authorizationExpiry && (
              <p className="feishu-connection-help">
                {text(`授权有效期至 ${authorizationExpiry}`, `Authorization expires at ${authorizationExpiry}`)}
              </p>
            )}
            <div className="feishu-connection-actions">
              {connection.authorizationUrl && (
                <a className="button secondary" href={connection.authorizationUrl} target="_blank" rel="noreferrer">
                  {text("打开飞书授权页", "Open Feishu authorization")}
                </a>
              )}
              <button className="button secondary" type="button" disabled={saving} onClick={() => void onAuthorize()}>
                {text("重新生成授权链接", "Regenerate authorization link")}
              </button>
              <button className="button secondary" type="button" disabled={saving} onClick={() => void onCancelAuthorization()}>
                {text("取消授权", "Cancel authorization")}
              </button>
            </div>
          </div>
        )}

        {!pending && !authorized && (
          <div className="feishu-connection-actions">
            <button className="button primary" type="button" disabled={saving || !connection?.authorizationReady} onClick={() => void onAuthorize()}>
              {text("接入飞书", "Connect Feishu")}
            </button>
          </div>
        )}

        {authorized && (
          <>
            <div className="feishu-connection-actions">
              <button className="button secondary" type="button" disabled={saving} onClick={() => void onAuthorize()}>
                {text("重新登录授权", "Reauthorize Feishu")}
              </button>
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
            <p className="feishu-connection-help">
              {text("保存后会同步该视图中的需求工作项，点击需求可查看详细内容。", "Saving syncs requirement work items from this view. Click a requirement to view its details.")}
            </p>
          </>
        )}

        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          {authorized && (
            <button className="button primary" type="submit" disabled={saving || !viewUrl.trim()}>
              {saving ? text("同步中…", "Syncing…") : text("保存并同步", "Save and sync")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
