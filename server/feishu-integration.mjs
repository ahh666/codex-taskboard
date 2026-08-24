import { FEISHU_PROJECT_ID } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const SYNC_INTERVAL_MS = 60_000;
const DETAIL_REQUEST_INTERVAL_MS = 100;

function limitedString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  return (result || fallback).slice(0, maxLength);
}

function timestampToIso(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return new Date().toISOString();
  return new Date(milliseconds).toISOString();
}

function dueDateFromTask(task) {
  const timestamp = Number(task?.due?.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function actorFromFeishu(member, fallback) {
  const id = limitedString(member?.id, fallback, 240);
  return {
    type: "user",
    id: `feishu:${id}`,
    name: limitedString(member?.name, fallback, 120),
    avatarUrl: null,
  };
}

function normalizeTask(task, tasklistNames, index) {
  const guid = limitedString(task?.guid, "", 256);
  if (!guid) throw new ApiError(502, "INVALID_FEISHU_RESPONSE", "飞书返回的任务缺少 GUID");
  const members = Array.isArray(task.members) ? task.members : [];
  const assignee = members.find((member) => member?.role === "assignee") ?? members[0] ?? task.creator;
  const creator = task.creator ?? assignee;
  const labels = [...tasklistNames].sort((left, right) => left.localeCompare(right)).slice(0, 20);
  return {
    id: `FEISHU:${guid}`,
    identifier: `FEISHU:${guid}`,
    title: limitedString(task.summary, "未命名任务", 240),
    description: typeof task.description === "string" ? task.description.slice(0, 100_000) : "",
    status: Number(task.completed_at) > 0 ? "done" : "todo",
    priority: "none",
    labels,
    sortOrder: (index + 1) * 1024,
    creator: actorFromFeishu(creator, "飞书用户"),
    assignee: actorFromFeishu(assignee, "未分配"),
    dueDate: dueDateFromTask(task),
    externalOrigin: "feishu",
    externalId: guid,
    externalKey: limitedString(task.task_id ?? guid, guid, 256),
    externalUrl: typeof task.url === "string" && task.url.length <= 2_048 ? task.url : null,
    createdAt: timestampToIso(task.created_at),
    updatedAt: timestampToIso(task.updated_at),
  };
}

function safeConnection(localConfig, cliStatus, lastSyncedAt, authorization = {}) {
  const tasklists = localConfig?.tasklists ?? [];
  const session = authorization.state ? authorization : cliStatus;
  const authorizationState = session.state ?? session.authorizationState
    ?? (cliStatus.authorized ? "authorized" : "idle");
  return {
    configured: Boolean(cliStatus.configured || tasklists.length > 0),
    cliAvailable: cliStatus.cliAvailable !== false,
    authorized: cliStatus.authorized === true,
    authorizationReady: cliStatus.cliAvailable !== false && cliStatus.configured === true,
    authorizationState,
    authorizationUrl: session.authorizationUrl ?? null,
    authorizationQrCode: session.authorizationQrCode ?? null,
    authorizationExpiresAt: session.authorizationExpiresAt ?? null,
    appId: cliStatus.appId ?? null,
    displayName: cliStatus.displayName ?? null,
    scopes: cliStatus.scopes ?? [],
    tasklists,
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
    return (await configStore.read()) ?? { version: 2, tasklists: [] };
  }

  async function connectionStatus(authorization = {}) {
    return safeConnection(await readConfig(), await cli.status(), lastSyncedAt, authorization);
  }

  async function requireAuthorized() {
    const status = await cli.status();
    if (!status.authorized) {
      throw new ApiError(401, "FEISHU_REAUTH_REQUIRED", "请先完成飞书登录授权");
    }
    return status;
  }

  async function syncWithConfig(config, { archiveMissing = true } = {}) {
    if (config.tasklists.length === 0) {
      database.syncFeishuTasks([], { archiveMissing, projectName: "飞书任务" });
      lastSyncedAt = new Date().toISOString();
      return connectionStatus();
    }
    const tasklistNames = new Map();
    for (const tasklist of config.tasklists) {
      const summaries = await cli.listTasklistTasks(tasklist.guid);
      for (const summary of summaries) {
        if (typeof summary?.guid !== "string") continue;
        const names = tasklistNames.get(summary.guid) ?? new Set();
        names.add(tasklist.name);
        tasklistNames.set(summary.guid, names);
      }
    }
    const tasks = [];
    for (const [guid, names] of tasklistNames) {
      const task = await cli.getTask(guid);
      tasks.push(normalizeTask(task, names, tasks.length));
      if (tasks.length < tasklistNames.size) {
        await new Promise((resolve) => setTimeout(resolve, DETAIL_REQUEST_INTERVAL_MS));
      }
    }
    database.syncFeishuTasks(tasks, { archiveMissing, projectName: "飞书任务" });
    lastSyncedAt = new Date().toISOString();
    return connectionStatus();
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
    async listTasklists() {
      await requireAuthorized();
      return cli.listTasklists();
    },
    async saveTasklists(input) {
      await requireAuthorized();
      const available = await cli.listTasklists();
      const availableByGuid = new Map(available.map((tasklist) => [tasklist.guid, tasklist]));
      const selected = input.map((tasklist) => availableByGuid.get(tasklist.guid)).filter(Boolean);
      if (selected.length !== input.length) {
        throw new ApiError(409, "FEISHU_TASKLIST_UNAVAILABLE", "所选飞书任务清单已不可访问，请刷新清单后重试");
      }
      const savedConfig = await configStore.save({ version: 2, tasklists: selected });
      return syncWithConfig(savedConfig);
    },
    async sync({ force = false } = {}) {
      const config = await readConfig();
      const status = await cli.status();
      if (!status.authorized) return safeConnection(config, status, lastSyncedAt);
      if (!force && lastSyncedAt && Date.now() - Date.parse(lastSyncedAt) < SYNC_INTERVAL_MS) {
        return safeConnection(config, status, lastSyncedAt);
      }
      if (pendingSync) return pendingSync;
      pendingSync = syncWithConfig(config)
        .finally(() => { pendingSync = null; });
      return pendingSync;
    },
    async reconcile() {
      await requireAuthorized();
      return syncWithConfig(await readConfig(), { archiveMissing: false });
    },
    async updateTask(task, changes) {
      if (task.externalOrigin !== "feishu" || !task.externalId) {
        throw new ApiError(409, "FEISHU_ORIGIN_MISMATCH", "此任务不属于当前飞书连接，请重新同步后再操作");
      }
      const updateFields = [];
      const update = {};
      if (Object.hasOwn(changes, "title") && changes.title !== task.title) {
        update.summary = changes.title;
        updateFields.push("summary");
      }
      if (Object.hasOwn(changes, "description") && changes.description !== task.description) {
        update.description = changes.description;
        updateFields.push("description");
      }
      if (Object.hasOwn(changes, "dueDate") && changes.dueDate !== task.dueDate) {
        update.due = changes.dueDate
          ? { timestamp: String(Date.parse(`${changes.dueDate}T00:00:00.000Z`)), is_all_day: true }
          : {};
        updateFields.push("due");
      }
      if (Object.hasOwn(changes, "status") && changes.status !== task.status) {
        update.completed_at = changes.status === "done" ? String(Date.now()) : "0";
        updateFields.push("completed_at");
      }
      if (updateFields.length === 0) return false;
      await requireAuthorized();
      await cli.patchTask(task.externalId, { task: update, update_fields: updateFields });
      return true;
    },
    async close() {
      await cli.close?.();
    },
  };
}
