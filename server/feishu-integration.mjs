import { createHash, randomBytes } from "node:crypto";

import { FEISHU_PROJECT_ID } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const AUTHORIZATION_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
const API_ORIGIN = "https://open.feishu.cn";
const SCOPES = ["offline_access", "task:task:read", "task:tasklist:read", "task:task:write"];
const REQUEST_TIMEOUT_MS = 20_000;
const SYNC_INTERVAL_MS = 60_000;
const DETAIL_REQUEST_INTERVAL_MS = 100;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

function base64url(buffer) {
  return buffer.toString("base64url");
}

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
  if (!guid) {
    throw new ApiError(502, "INVALID_FEISHU_RESPONSE", "飞书返回的任务缺少 GUID");
  }
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

function safeConfig(config, lastSyncedAt = null, defaultCredentials = null) {
  const authorized = Boolean(config?.accessToken || config?.refreshToken);
  const authorizationReady = Boolean(
    (config?.appId && config?.appSecret)
      || (defaultCredentials?.appId && defaultCredentials?.appSecret),
  );
  return config
    ? {
      configured: true,
      authorized,
      appId: config.appId,
      authorizationReady,
      scopes: config.scopes ? config.scopes.split(" ").filter(Boolean) : [],
      tasklists: config.tasklists,
      projectId: FEISHU_PROJECT_ID,
      lastSyncedAt,
    }
    : {
      configured: false,
      authorized: false,
      appId: defaultCredentials?.appId ?? null,
      authorizationReady,
      scopes: [],
      tasklists: [],
      projectId: FEISHU_PROJECT_ID,
      lastSyncedAt: null,
    };
}

function expiresAt(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ApiError(502, "INVALID_FEISHU_RESPONSE", "飞书未返回有效的令牌过期时间");
  }
  return new Date(Date.now() + value * 1_000).toISOString();
}

export function createFeishuIntegration({
  configStore,
  database,
  defaultCredentials = null,
  fetch: fetchImplementation = globalThis.fetch,
}) {
  let lastSyncedAt = null;
  let pendingSync = null;
  let pendingAuthorization = null;
  let pendingTokenRefresh = null;

  async function fetchJson(url, init, failureCode, failureMessage) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response;
    try {
      response = await fetchImplementation(url, { ...init, signal: controller.signal });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        502,
        timedOut ? "FEISHU_TIMEOUT" : failureCode,
        timedOut ? "连接飞书超时" : failureMessage,
      );
    } finally {
      clearTimeout(timeout);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(502, "INVALID_FEISHU_RESPONSE", "飞书返回了无效的 JSON 数据");
    }
    if (!response.ok || payload?.code !== 0) {
      const code = Number(payload?.code);
      const authorizationError = response.status === 401
        || response.status === 403
        || [99991661, 99991663, 99991668, 99991679].includes(code);
      throw new ApiError(
        authorizationError ? 401 : response.status >= 500 ? 502 : 409,
        authorizationError ? "FEISHU_AUTH_FAILED" : failureCode,
        authorizationError ? "飞书授权已失效或权限不足，请重新授权" : `${failureMessage}${payload?.msg ? `：${payload.msg}` : ""}`,
      );
    }
    return payload.data ?? payload;
  }

  async function requestToken(body) {
    return fetchJson(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    }, "FEISHU_TOKEN_FAILED", "无法获取飞书用户令牌");
  }

  async function refreshAccessToken(config) {
    if (!config.refreshToken || !config.refreshTokenExpiresAt || Date.parse(config.refreshTokenExpiresAt) <= Date.now()) {
      throw new ApiError(401, "FEISHU_REAUTH_REQUIRED", "飞书授权已过期，请重新授权");
    }
    const token = await requestToken({
      grant_type: "refresh_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      refresh_token: config.refreshToken,
    });
    if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
      throw new ApiError(502, "INVALID_FEISHU_RESPONSE", "飞书未返回可刷新的用户令牌");
    }
    return configStore.save({
      ...config,
      accessToken: token.access_token,
      accessTokenExpiresAt: expiresAt(token.expires_in),
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt: expiresAt(token.refresh_token_expires_in),
      scopes: typeof token.scope === "string" ? token.scope : config.scopes,
    });
  }

  async function activeConfig() {
    let config = await configStore.read();
    if (!config?.accessToken || !config.accessTokenExpiresAt) {
      if (!config) throw new ApiError(409, "FEISHU_NOT_CONFIGURED", "飞书尚未配置");
      return refreshAccessTokenOnce(config);
    }
    if (Date.parse(config.accessTokenExpiresAt) - Date.now() <= TOKEN_REFRESH_SKEW_MS) {
      config = await refreshAccessTokenOnce(config);
    }
    return config;
  }

  function refreshAccessTokenOnce(config) {
    if (!pendingTokenRefresh) {
      pendingTokenRefresh = refreshAccessToken(config)
        .finally(() => { pendingTokenRefresh = null; });
    }
    return pendingTokenRefresh;
  }

  async function request(config, pathname, init = {}) {
    const data = await fetchJson(`${API_ORIGIN}${pathname}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    }, "FEISHU_REQUEST_FAILED", "飞书任务请求失败");
    return data;
  }

  async function listTasklistsWithConfig(config) {
    const tasklists = [];
    let pageToken = null;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (pageToken) query.set("page_token", pageToken);
      const page = await request(config, `/open-apis/task/v2/tasklists?${query}`);
      const items = Array.isArray(page?.items) ? page.items : [];
      for (const item of items) {
        if (typeof item?.guid !== "string" || typeof item?.name !== "string") continue;
        tasklists.push({
          guid: item.guid,
          name: item.name,
          url: typeof item.url === "string" ? item.url : null,
        });
      }
      pageToken = page?.has_more && typeof page?.page_token === "string" ? page.page_token : null;
    } while (pageToken);
    return tasklists;
  }

  async function listTasklistTasks(config, tasklistGuid) {
    const tasks = [];
    let pageToken = null;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (pageToken) query.set("page_token", pageToken);
      const page = await request(
        config,
        `/open-apis/task/v2/tasklists/${encodeURIComponent(tasklistGuid)}/tasks?${query}`,
      );
      tasks.push(...(Array.isArray(page?.items) ? page.items : []));
      pageToken = page?.has_more && typeof page?.page_token === "string" ? page.page_token : null;
    } while (pageToken);
    return tasks;
  }

  async function syncWithConfig(config, { archiveMissing = true } = {}) {
    if (config.tasklists.length === 0) {
      database.syncFeishuTasks([], {
        archiveMissing,
        projectName: "飞书任务",
      });
      lastSyncedAt = new Date().toISOString();
      return safeConfig(config, lastSyncedAt, defaultCredentials);
    }
    const tasklistNames = new Map();
    for (const tasklist of config.tasklists) {
      const summaries = await listTasklistTasks(config, tasklist.guid);
      for (const summary of summaries) {
        if (typeof summary?.guid !== "string") continue;
        const names = tasklistNames.get(summary.guid) ?? new Set();
        names.add(tasklist.name);
        tasklistNames.set(summary.guid, names);
      }
    }
    const tasks = [];
    for (const [guid, names] of tasklistNames) {
      const data = await request(config, `/open-apis/task/v2/tasks/${encodeURIComponent(guid)}`);
      tasks.push(normalizeTask(data?.task, names, tasks.length));
      if (tasks.length < tasklistNames.size) {
        await new Promise((resolve) => setTimeout(resolve, DETAIL_REQUEST_INTERVAL_MS));
      }
    }
    database.syncFeishuTasks(tasks, {
      archiveMissing,
      projectName: "飞书任务",
    });
    lastSyncedAt = new Date().toISOString();
    return safeConfig(config, lastSyncedAt, defaultCredentials);
  }

  return {
    async status() {
      return safeConfig(await configStore.read(), lastSyncedAt, defaultCredentials);
    },
    async startAuthorization({ redirectUri }) {
      const current = await configStore.read();
      const configuredCredentials = current?.appId && current?.appSecret
        ? { appId: current.appId, appSecret: current.appSecret }
        : null;
      const credentials = defaultCredentials?.appId && defaultCredentials?.appSecret
        ? defaultCredentials
        : configuredCredentials;
      if (!credentials) {
        throw new ApiError(
          409,
          "FEISHU_APP_CONFIG_REQUIRED",
          "服务端尚未配置固定飞书应用，请设置 CODEX_TASKBOARD_FEISHU_APP_ID 和 CODEX_TASKBOARD_FEISHU_APP_SECRET",
        );
      }
      const candidate = configStore.validateCredentials(credentials);
      const config = await configStore.save({
        ...candidate,
        tasklists: current?.appId === candidate.appId ? current.tasklists : [],
      });
      const verifier = base64url(randomBytes(64));
      const state = base64url(randomBytes(32));
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      pendingAuthorization = {
        state,
        verifier,
        redirectUri,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      };
      const authorizationUrl = new URL(AUTHORIZATION_URL);
      authorizationUrl.searchParams.set("client_id", config.appId);
      authorizationUrl.searchParams.set("redirect_uri", redirectUri);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("scope", SCOPES.join(" "));
      authorizationUrl.searchParams.set("code_challenge", challenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      return { authorizationUrl: authorizationUrl.toString(), redirectUri };
    },
    async completeAuthorization({ code, state }) {
      const pending = pendingAuthorization;
      pendingAuthorization = null;
      if (!pending || pending.expiresAt < Date.now() || state !== pending.state) {
        throw new ApiError(400, "FEISHU_OAUTH_STATE_INVALID", "飞书授权请求已过期，请返回 Taskboard 重新发起授权");
      }
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "FEISHU_NOT_CONFIGURED", "飞书配置已丢失，请重新发起授权");
      const token = await requestToken({
        grant_type: "authorization_code",
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      });
      if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
        throw new ApiError(502, "INVALID_FEISHU_RESPONSE", "飞书未返回可刷新的用户令牌，请检查 offline_access 权限");
      }
      const savedConfig = await configStore.save({
        ...config,
        accessToken: token.access_token,
        accessTokenExpiresAt: expiresAt(token.expires_in),
        refreshToken: token.refresh_token,
        refreshTokenExpiresAt: expiresAt(token.refresh_token_expires_in),
        scopes: typeof token.scope === "string" ? token.scope : "",
      });
      return safeConfig(savedConfig, lastSyncedAt, defaultCredentials);
    },
    async listTasklists() {
      return listTasklistsWithConfig(await activeConfig());
    },
    async saveTasklists(input) {
      const config = await activeConfig();
      const available = await listTasklistsWithConfig(config);
      const availableByGuid = new Map(available.map((tasklist) => [tasklist.guid, tasklist]));
      const selected = input.map((tasklist) => availableByGuid.get(tasklist.guid)).filter(Boolean);
      if (selected.length !== input.length) {
        throw new ApiError(409, "FEISHU_TASKLIST_UNAVAILABLE", "所选飞书任务清单已不可访问，请刷新清单后重试");
      }
      const savedConfig = await configStore.save({ ...config, tasklists: selected });
      return syncWithConfig(savedConfig);
    },
    async sync({ force = false } = {}) {
      const config = await configStore.read();
      if (!config?.accessToken && !config?.refreshToken) {
        return safeConfig(config, null, defaultCredentials);
      }
      if (!force && lastSyncedAt && Date.now() - Date.parse(lastSyncedAt) < SYNC_INTERVAL_MS) {
        return safeConfig(config, lastSyncedAt, defaultCredentials);
      }
      if (pendingSync) return pendingSync;
      pendingSync = activeConfig()
        .then((active) => syncWithConfig(active))
        .finally(() => { pendingSync = null; });
      return pendingSync;
    },
    async reconcile() {
      return syncWithConfig(await activeConfig(), { archiveMissing: false });
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
      await request(await activeConfig(), `/open-apis/task/v2/tasks/${encodeURIComponent(task.externalId)}`, {
        method: "PATCH",
        body: JSON.stringify({ task: update, update_fields: updateFields }),
      });
      return true;
    },
  };
}
