import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { FeishuConnection, FeishuTasklist } from "../types";

interface FeishuConnectionDialogProps {
  connection: FeishuConnection | null;
  tasklists: FeishuTasklist[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onAuthorize: () => Promise<void>;
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
  onRefreshTasklists,
  onSaveTasklists,
}: FeishuConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set(
    connection?.tasklists.map((tasklist) => tasklist.guid) ?? [],
  ));
  const callbackUri = useMemo(() => new URL(
    "api/local/feishu-connection/callback",
    document.baseURI,
  ).toString(), []);

  useEffect(() => {
    setSelectedGuids(new Set(connection?.tasklists.map((tasklist) => tasklist.guid) ?? []));
  }, [connection]);

  async function saveTasklists(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSaveTasklists([...selectedGuids]);
  }

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
          {connection?.configured ? text("飞书任务设置", "Feishu task settings") : text("连接飞书任务", "Connect Feishu tasks")}
        </h2>
        <label>
          <span>{text("回调地址", "Redirect URI")}</span>
          <input readOnly value={callbackUri} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <p className="feishu-connection-help">
          {connection?.authorizationReady
            ? text("使用已配置的飞书应用登录并授权，前端不会保存应用密钥。", "Sign in and authorize with the configured Feishu app. The app secret stays on the local service.")
            : text("当前未配置固定飞书应用，请管理员设置 CODEX_TASKBOARD_FEISHU_APP_ID 和 CODEX_TASKBOARD_FEISHU_APP_SECRET。", "A fixed Feishu app is not configured. Ask an administrator to set CODEX_TASKBOARD_FEISHU_APP_ID and CODEX_TASKBOARD_FEISHU_APP_SECRET.")}
        </p>
        <div className="feishu-connection-actions">
          <button
            className="button secondary"
            type="button"
            disabled={saving || !connection?.authorizationReady}
            onClick={() => void onAuthorize()}
          >
            {connection?.authorized
              ? text("重新登录并授权", "Sign in and reauthorize")
              : text("登录并授权飞书", "Sign in and authorize Feishu")}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={saving || !connection?.authorized}
            onClick={() => void onRefreshTasklists()}
          >
            {text("刷新任务清单", "Refresh task lists")}
          </button>
        </div>
        {connection?.authorized && (
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
            )) : <p>{text("授权完成后刷新任务清单。", "Refresh task lists after authorization.")}</p>}
          </fieldset>
        )}
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={saving || !connection?.authorized || selectedGuids.size === 0}
          >
            {saving ? text("同步中…", "Syncing…") : text("保存并同步", "Save and sync")}
          </button>
        </div>
      </form>
    </div>
  );
}
