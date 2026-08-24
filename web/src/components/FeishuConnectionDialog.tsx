import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { FeishuConnection, FeishuTasklist } from "../types";

interface FeishuConnectionDialogProps {
  connection: FeishuConnection | null;
  tasklists: FeishuTasklist[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onAuthorize: () => Promise<void>;
  onCancelAuthorization: () => Promise<void>;
  onRefreshTasklists: () => Promise<void>;
  onSaveTasklists: (guids: string[]) => Promise<void>;
}

export function FeishuConnectionDialog({
  connection,
  tasklists,
  saving,
  error,
  onClose,
  onAuthorize,
  onCancelAuthorization,
  onRefreshTasklists,
  onSaveTasklists,
}: FeishuConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set(
    connection?.tasklists.map((tasklist) => tasklist.guid) ?? [],
  ));

  useEffect(() => {
    setSelectedGuids(new Set(connection?.tasklists.map((tasklist) => tasklist.guid) ?? []));
  }, [connection]);

  async function saveTasklists(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSaveTasklists([...selectedGuids]);
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
        onSubmit={(event) => void saveTasklists(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="feishu-connection-title">
          {connection?.configured ? text("飞书任务设置", "Feishu task settings") : text("接入飞书任务", "Connect Feishu tasks")}
        </h2>
        <p className="feishu-connection-help">
          {!connection?.cliAvailable
            ? connection?.error ?? text("当前安装包缺少飞书登录组件。", "This installation is missing the Feishu login component.")
            : !connection.authorizationReady
              ? text("当前版本未配置飞书应用，请联系管理员。", "This version has no Feishu app configured. Contact an administrator.")
              : authorized
                ? text(`已授权${connection?.displayName ? `：${connection.displayName}` : ""}`, `Authorized${connection?.displayName ? `: ${connection.displayName}` : ""}`)
                : text("点击接入后使用飞书扫码或授权链接登录。", "Click connect to sign in with a Feishu QR code or authorization link.")}
        </p>

        {pending && connection.authorizationQrCode && (
          <div className="feishu-authorization-pending">
            <img
              className="feishu-authorization-qr"
              src={connection.authorizationQrCode}
              alt={text("飞书授权二维码", "Feishu authorization QR code")}
            />
            {authorizationExpiry && (
              <p className="feishu-connection-help">
                {text(`二维码有效期至 ${authorizationExpiry}`, `QR code expires at ${authorizationExpiry}`)}
              </p>
            )}
            <div className="feishu-connection-actions">
              {connection.authorizationUrl && (
                <a
                  className="button secondary"
                  href={connection.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {text("打开飞书授权页", "Open Feishu authorization")}
                </a>
              )}
              <button
                className="button secondary"
                type="button"
                disabled={saving}
                onClick={() => void onAuthorize()}
              >
                {text("重新生成二维码", "Regenerate QR code")}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={saving}
                onClick={() => void onCancelAuthorization()}
              >
                {text("取消授权", "Cancel authorization")}
              </button>
            </div>
          </div>
        )}

        {!pending && !authorized && (
          <div className="feishu-connection-actions">
            <button
              className="button primary"
              type="button"
              disabled={saving || !connection?.authorizationReady}
              onClick={() => void onAuthorize()}
            >
              {text("接入飞书", "Connect Feishu")}
            </button>
          </div>
        )}

        {authorized && (
          <>
            <div className="feishu-connection-actions">
              <button
                className="button secondary"
                type="button"
                disabled={saving}
                onClick={() => void onAuthorize()}
              >
                {text("重新登录授权", "Reauthorize Feishu")}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={saving}
                onClick={() => void onRefreshTasklists()}
              >
                {text("刷新任务清单", "Refresh task lists")}
              </button>
            </div>
            <fieldset className="feishu-tasklists">
              <legend>{text("同步任务清单", "Task lists to sync")}</legend>
              {tasklists.length > 0 ? tasklists.map((tasklist) => (
                <label key={tasklist.guid}>
                  <input
                    type="checkbox"
                    checked={selectedGuids.has(tasklist.guid)}
                    disabled={saving}
                    onChange={(event) => {
                      setSelectedGuids((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(tasklist.guid);
                        else next.delete(tasklist.guid);
                        return next;
                      });
                    }}
                  />
                  <span>{tasklist.name}</span>
                </label>
              )) : <p>{text("暂无可同步的任务清单。", "No task lists are available to sync.")}</p>}
            </fieldset>
          </>
        )}

        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          {authorized && (
            <button
              className="button primary"
              type="submit"
              disabled={saving || selectedGuids.size === 0}
            >
              {saving ? text("同步中…", "Syncing…") : text("保存并同步", "Save and sync")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
