import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { FeishuConnection, FeishuTasklist } from "../types";

interface FeishuConnectionDialogProps {
  connection: FeishuConnection | null;
  tasklists: FeishuTasklist[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onAuthorize: (input: { appId: string; appSecret: string }) => Promise<void>;
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
  const [appId, setAppId] = useState(connection?.appId ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set(
    connection?.tasklists.map((tasklist) => tasklist.guid) ?? [],
  ));
  const callbackUri = useMemo(() => new URL(
    "api/local/feishu-connection/callback",
    document.baseURI,
  ).toString(), []);

  useEffect(() => {
    setAppId(connection?.appId ?? "");
    setAppSecret("");
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
        <label>
          <span>{text("App ID", "App ID")}</span>
          <input
            required={!connection?.authorized}
            autoFocus
            autoComplete="off"
            maxLength={256}
            placeholder="cli_xxx"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
          />
        </label>
        <label>
          <span>{text("App Secret", "App Secret")}</span>
          <input
            required={!connection?.authorized}
            type="password"
            autoComplete="off"
            maxLength={4096}
            placeholder={connection?.authorized ? text("重新授权时填写", "Required to reauthorize") : ""}
            value={appSecret}
            onChange={(event) => setAppSecret(event.target.value)}
          />
        </label>
        <div className="feishu-connection-actions">
          <button
            className="button secondary"
            type="button"
            disabled={saving || !appId.trim() || !appSecret}
            onClick={() => void onAuthorize({ appId: appId.trim(), appSecret })}
          >
            {text("授权飞书", "Authorize Feishu")}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={saving || !connection?.configured}
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
