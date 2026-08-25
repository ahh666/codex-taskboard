import { FEISHU_PROJECT_ID } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const SYNC_INTERVAL_MS = 60_000;

function limitedString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  return (result || fallback).slice(0, maxLength);
}

function readableValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = readableValue(parsed);
        if (nested) return nested;
      } catch {}
    }
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readableValue).filter(Boolean).join("、");
  if (typeof value === "object") {
    for (const key of ["display_name", "name", "label", "text", "content", "value", "title"]) {
      const result = readableValue(value[key]);
      if (result) return result;
    }
  }
  return "";
}

function workItemAttribute(item) {
  return item?.work_item_attribute ?? item?.workItemAttribute ?? item ?? {};
}

function fieldMap(item) {
  const result = new Map();
  const fields = item?.fields ?? item?.work_item_fields ?? item?.workItemFields;
  if (Array.isArray(fields)) {
    for (const field of fields) {
      const key = limitedString(field?.field_key ?? field?.key ?? field?.api_name, "", 256);
      const name = limitedString(field?.field_name ?? field?.name, "", 256);
      const value = field?.field_value ?? field?.value;
      if (key) result.set(key, value);
      if (name) result.set(name, value);
    }
  } else if (fields && typeof fields === "object") {
    for (const [key, value] of Object.entries(fields)) result.set(key, value);
  }
  return result;
}

function fieldValue(item, fields, ...keys) {
  const attribute = workItemAttribute(item);
  for (const key of keys) {
    if (item?.[key] !== undefined && item[key] !== null) return item[key];
    if (attribute?.[key] !== undefined && attribute[key] !== null) return attribute[key];
    if (fields.has(key)) return fields.get(key);
  }
  return null;
}

function workItemId(item) {
  const attribute = workItemAttribute(item);
  return limitedString(
    item?.work_item_id
      ?? item?.workItemId
      ?? item?.work_item_info?.work_item_id
      ?? attribute?.work_item_id
      ?? item?.id,
    "",
    256,
  );
}

function timestampToIso(value) {
  if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return new Date(number < 10_000_000_000 ? number * 1_000 : number).toISOString();
  }
  return new Date().toISOString();
}

function statusFromText(value) {
  const status = readableValue(value);
  if (/完成|已结束|关闭|终止|done|closed|finished/i.test(status)) return "done";
  if (/评审|验收|review/i.test(status)) return "in_review";
  if (/阻塞|blocked/i.test(status)) return "blocked";
  if (/进行|处理中|开发中|设计中|in.progress/i.test(status)) return "in_progress";
  if (/取消|canceled/i.test(status)) return "canceled";
  return "todo";
}

function priorityFromText(value) {
  const priority = readableValue(value).toUpperCase();
  if (priority === "P0" || /紧急|URGENT/.test(priority)) return "urgent";
  if (priority === "P1" || /高|HIGH/.test(priority)) return "high";
  if (priority === "P2" || /中|MEDIUM/.test(priority)) return "medium";
  if (priority === "P3" || /低|LOW/.test(priority)) return "low";
  return "none";
}

function actorFromValue(value, fallback) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const id = limitedString(
    candidate?.user_key ?? candidate?.userKey ?? candidate?.id ?? readableValue(candidate),
    fallback,
    240,
  );
  return {
    type: "user",
    id: `feishu-project:${id}`,
    name: limitedString(
      candidate?.display_name ?? candidate?.name ?? candidate?.username ?? readableValue(candidate),
      fallback,
      120,
    ),
    avatarUrl: typeof candidate?.avatar_url === "string" ? candidate.avatar_url : null,
  };
}

function normalizeWorkItem(item, view, index) {
  const id = workItemId(item);
  if (!id) throw new ApiError(502, "INVALID_FEISHU_RESPONSE", "飞书项目返回的需求缺少工作项 ID");
  const attribute = workItemAttribute(item);
  const fields = fieldMap(item);
  const title = readableValue(fieldValue(
    item,
    fields,
    "name",
    "work_item_name",
    "需求名称",
  )) || readableValue(item?.work_item_info?.work_item_name)
    || readableValue(attribute?.work_item_name) || "未命名需求";
  const statusValue = fieldValue(item, fields, "work_item_status", "status", "状态")
    ?? item?.state_info?.end_state_key_name
    ?? attribute?.work_item_status;
  const priorityValue = fieldValue(item, fields, "priority", "优先级");
  const creatorValue = fieldValue(item, fields, "created_by", "creator", "创建人");
  const assigneeValue = fieldValue(
    item,
    fields,
    "current_status_operator",
    "assignee",
    "owners",
    "role_owners",
    "负责人",
  );
  const description = readableValue(fieldValue(
    item,
    fields,
    "description",
    "requirement_description",
    "需求描述",
  ));
  const statusLabel = readableValue(statusValue);
  const externalOrigin = `feishu-project:${view.host}/${view.simpleName}`;
  return {
    id: `FEISHU-PROJECT:${id}`,
    identifier: `FEISHU:${view.simpleName.toUpperCase()}:${id}`,
    title: limitedString(title, "未命名需求", 240),
    description: description.slice(0, 100_000),
    status: statusFromText(statusValue),
    priority: priorityFromText(priorityValue),
    labels: statusLabel ? [limitedString(statusLabel, "", 120)] : [],
    sortOrder: (index + 1) * 1024,
    creator: actorFromValue(creatorValue, "飞书项目用户"),
    assignee: actorFromValue(assigneeValue, "未分配"),
    dueDate: null,
    externalOrigin,
    externalId: id,
    externalKey: id,
    externalUrl: `https://${view.host}/${view.simpleName}/${view.workItemType}/detail/${encodeURIComponent(id)}`,
    createdAt: timestampToIso(fieldValue(item, fields, "created_at", "createdAt", "创建时间") ?? attribute?.create_time),
    updatedAt: timestampToIso(fieldValue(item, fields, "updated_at", "updatedAt", "更新时间") ?? attribute?.update_time),
  };
}

function safeConnection(localConfig, cliStatus, lastSyncedAt, authorization = {}) {
  const session = authorization.state ? authorization : cliStatus;
  const authorizationState = session.state ?? session.authorizationState
    ?? (cliStatus.authorized ? "authorized" : "idle");
  const view = localConfig?.view ?? null;
  return {
    configured: Boolean(view),
    cliAvailable: cliStatus.cliAvailable !== false,
    authorized: cliStatus.authorized === true,
    authorizationReady: cliStatus.cliAvailable !== false,
    authorizationState,
    authorizationUrl: session.authorizationUrl ?? null,
    authorizationQrCode: session.authorizationQrCode ?? null,
    authorizationExpiresAt: session.authorizationExpiresAt ?? null,
    displayName: cliStatus.displayName ?? null,
    viewUrl: view?.url ?? null,
    viewId: view?.viewId ?? null,
    projectId: FEISHU_PROJECT_ID,
    lastSyncedAt,
    error: session.error ?? cliStatus.error ?? null,
  };
}

export function createFeishuIntegration({ configStore, database, cli }) {
  if (!configStore) throw new Error("configStore is required");
  if (!database) throw new Error("database is required");
  if (!cli) throw new Error("cli is required");
  let lastSyncedAt = null;
  let pendingSync = null;

  async function readConfig() {
    return (await configStore.read()) ?? { version: 3, view: null };
  }

  async function connectionStatus(authorization = {}) {
    return safeConnection(await readConfig(), await cli.status(), lastSyncedAt, authorization);
  }

  async function requireAuthorized() {
    const status = await cli.status();
    if (!status.authorized) {
      throw new ApiError(401, "FEISHU_REAUTH_REQUIRED", "请先完成飞书项目登录授权");
    }
    return status;
  }

  async function syncWithView(view, { archiveMissing = true } = {}) {
    const items = await cli.listViewWorkItems(view);
    const tasks = items.map((item, index) => normalizeWorkItem(item, view, index));
    database.syncFeishuTasks(tasks, { archiveMissing, projectName: "飞书需求" });
    lastSyncedAt = new Date().toISOString();
  }

  return {
    async status() {
      return connectionStatus();
    },
    async startAuthorization() {
      const authorization = await cli.startAuthorization();
      return connectionStatus(authorization);
    },
    async cancelAuthorization() {
      await cli.cancelAuthorization();
      return connectionStatus();
    },
    async saveView(viewUrl) {
      await requireAuthorized();
      const view = await cli.decodeViewUrl(viewUrl);
      await syncWithView(view);
      const savedConfig = await configStore.save({ version: 3, view });
      return safeConnection(savedConfig, await cli.status(), lastSyncedAt);
    },
    async sync({ force = false } = {}) {
      const config = await readConfig();
      const status = await cli.status();
      if (!status.authorized || !config.view) return safeConnection(config, status, lastSyncedAt);
      if (!force && lastSyncedAt && Date.now() - Date.parse(lastSyncedAt) < SYNC_INTERVAL_MS) {
        return safeConnection(config, status, lastSyncedAt);
      }
      if (pendingSync) return pendingSync;
      pendingSync = syncWithView(config.view)
        .then(() => connectionStatus())
        .finally(() => { pendingSync = null; });
      return pendingSync;
    },
    async reconcile() {
      await requireAuthorized();
      const config = await readConfig();
      if (config.view) await syncWithView(config.view, { archiveMissing: false });
      return connectionStatus();
    },
    async updateTask(task, changes) {
      if (task.externalOrigin?.startsWith("feishu-project:") !== true || !task.externalId) {
        throw new ApiError(409, "FEISHU_ORIGIN_MISMATCH", "此需求不属于当前飞书项目连接，请重新同步后再操作");
      }
      const externalFieldChanged = ["title", "description", "status", "dueDate"]
        .some((field) => Object.hasOwn(changes, field));
      if (!externalFieldChanged) return false;
      throw new ApiError(409, "FEISHU_FIELD_UNAVAILABLE", "请在飞书项目中修改需求内容");
    },
    async close() {
      await cli.close?.();
    },
  };
}
