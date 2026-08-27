import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";

const PROFILE_NAME = "taskboard";
const DEFAULT_HOST = "project.feishu.cn";
const COMMAND_TIMEOUT_MS = 60_000;
const AUTH_COMMAND_TIMEOUT_MS = 30 * 60_000;

function textValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 400) || fallback;
}

function parseJson(stdout, fallbackMessage) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) throw new ApiError(502, "FEISHU_CLI_INVALID_OUTPUT", fallbackMessage);
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ApiError(502, "FEISHU_CLI_INVALID_OUTPUT", fallbackMessage);
  }
}

function parseCliErrorOutput(output) {
  const trimmed = String(output ?? "").trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart > 0) candidates.push(trimmed.slice(jsonStart));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return value;
    } catch {}
  }
  return null;
}

function cliError(code, message, details) {
  return new ApiError(502, code, message, details);
}

function normalizeAuthorization(payload) {
  const authorizationUrl = textValue(
    payload?.verification_uri_complete ?? payload?.verification_uri,
  );
  const deviceCode = textValue(payload?.device_code);
  const clientId = textValue(payload?.client_id);
  const interval = Number(payload?.interval) || 5;
  const expiresIn = Number(payload?.expires_in) || 1_800;
  if (!authorizationUrl || !deviceCode || !clientId) {
    throw cliError("FEISHU_CLI_INVALID_OUTPUT", "飞书项目 CLI 未返回有效的授权信息");
  }
  return {
    authorizationUrl,
    deviceCode,
    clientId,
    interval,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
  };
}

function recordArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["results", "work_items", "work_item_list", "items", "list", "records", "data"]) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === "object") {
      const nested = recordArray(payload[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function workItemId(record) {
  return textValue(String(
    record?.work_item_id
      ?? record?.workItemId
      ?? record?.work_item_info?.work_item_id
      ?? record?.work_item_attribute?.work_item_id
      ?? record?.id
      ?? "",
  ));
}

export function resolveFeishuCliPath({
  explicitPath,
  projectRoot = process.cwd(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (explicitPath) return path.resolve(explicitPath);
  const binaryName = platform === "win32" ? "meegle.exe" : "meegle";
  const packagedPath = path.resolve(projectRoot, "..", "bin", binaryName);
  if (existsSync(packagedPath)) return packagedPath;
  const developmentPath = path.resolve(projectRoot, "src-tauri", "resources", "bin", binaryName);
  if (existsSync(developmentPath)) return developmentPath;
  const packageBinaryName = `meegle-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
  const packagePath = path.resolve(
    projectRoot,
    "node_modules",
    "@lark-project",
    "meegle",
    "bin",
    packageBinaryName,
  );
  if (existsSync(packagePath)) return packagePath;
  return packagedPath;
}

export function createFeishuCli({
  executablePath,
  dataDirectory,
  profileName = PROFILE_NAME,
  host = DEFAULT_HOST,
  spawn = spawnProcess,
  platform = process.platform,
} = {}) {
  if (!executablePath) throw new Error("executablePath is required");
  if (!dataDirectory) throw new Error("dataDirectory is required");
  const homeDirectory = path.join(dataDirectory, "meegle-home");
  let authorization = null;
  let authorizationPromise = null;
  let authorizationProcess = null;
  let authorizationError = null;
  let authorizationGeneration = 0;

  function commandEnvironment() {
    const environment = {
      ...process.env,
      HOME: homeDirectory,
      MEEGLE_HOST: host,
      ...(platform === "win32" ? { USERPROFILE: homeDirectory } : {}),
    };
    delete environment.CODEX_TASKBOARD_FEISHU_APP_SECRET;
    return environment;
  }

  async function run(args, {
    timeoutMs = COMMAND_TIMEOUT_MS,
    trackAuthorization = false,
  } = {}) {
    await mkdir(homeDirectory, { recursive: true });
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(executablePath, ["--profile", profileName, ...args], {
        cwd: homeDirectory,
        env: commandEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (trackAuthorization) authorizationProcess = child;
      const timer = setTimeout(() => {
        child.kill();
        if (!settled) {
          settled = true;
          reject(cliError("FEISHU_CLI_TIMEOUT", "飞书项目 CLI 操作超时"));
        }
      }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(cliError("FEISHU_CLI_UNAVAILABLE", "当前安装包缺少飞书项目登录组件", {
          detail: safeErrorMessage(error, "spawn failed"),
        }));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (trackAuthorization && authorizationProcess === child) authorizationProcess = null;
        if (settled) return;
        settled = true;
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  async function runJson(args, options = {}) {
    const result = await run([...args, "--format", "json"], options);
    if (result.code !== 0) {
      const parsed = [result.stderr, result.stdout].map(parseCliErrorOutput).find(Boolean);
      const message = textValue(
        parsed?.error?.message ?? parsed?.message ?? parsed?.reason,
        textValue(result.stderr, "飞书项目 CLI 操作失败"),
      );
      throw cliError("FEISHU_CLI_COMMAND_FAILED", safeErrorMessage(message, "飞书项目 CLI 操作失败"), {
        exitCode: result.code,
        signal: result.signal,
        cliError: parsed?.error ?? parsed ?? null,
      });
    }
    return parseJson(result.stdout, "飞书项目 CLI 返回了无效的 JSON 数据");
  }

  async function status() {
    if (authorization && Date.parse(authorization.expiresAt) > Date.now()) {
      return {
        cliAvailable: true,
        configured: true,
        authorized: false,
        displayName: null,
        authorizationState: "pending",
        ...authorization.public,
      };
    }
    if (authorizationError) {
      return {
        cliAvailable: true,
        configured: true,
        authorized: false,
        displayName: null,
        authorizationState: "failed",
        error: authorizationError,
      };
    }
    if (authorization && Date.parse(authorization.expiresAt) <= Date.now()) authorization = null;
    let result;
    try {
      result = await run(["auth", "status", "--format", "json"]);
    } catch (error) {
      if (error instanceof ApiError && error.code === "FEISHU_CLI_UNAVAILABLE") {
        return {
          cliAvailable: false,
          configured: false,
          authorized: false,
          displayName: null,
          authorizationState: "idle",
          error: "当前安装包缺少飞书项目登录组件",
        };
      }
      throw error;
    }
    const payload = parseJson(result.stdout, "飞书项目 CLI 返回了无效的授权状态");
    const authorized = result.code === 0 && payload?.authenticated === true;
    let displayName = null;
    if (authorized) {
      try {
        const user = await runJson(["user", "me"]);
        displayName = textValue(user?.name ?? user?.user_name ?? user?.username, "") || null;
      } catch {}
    }
    return {
      cliAvailable: true,
      configured: true,
      authorized,
      displayName,
      authorizationState: authorized ? "authorized" : "idle",
      error: result.code > 1 ? textValue(payload?.reason, "飞书项目服务暂不可用") : null,
    };
  }

  async function startAuthorization() {
    if (authorization && Date.parse(authorization.expiresAt) > Date.now()) return authorization.public;
    const generation = ++authorizationGeneration;
    authorizationError = null;
    const normalized = normalizeAuthorization(await runJson([
      "auth", "login",
      "--device-code",
      "--phase", "init",
      "--host", host,
    ]));
    const publicAuthorization = {
      state: "pending",
      authorizationUrl: normalized.authorizationUrl,
      authorizationQrCode: null,
      authorizationExpiresAt: normalized.expiresAt,
    };
    authorization = { ...normalized, public: publicAuthorization };
    authorizationPromise = runJson([
      "auth", "login",
      "--device-code",
      "--phase", "poll",
      "--host", host,
      "--device-code-value", normalized.deviceCode,
      "--client-id", normalized.clientId,
      "--interval", String(normalized.interval),
      "--expires-in", String(normalized.expiresIn),
    ], {
      timeoutMs: AUTH_COMMAND_TIMEOUT_MS,
      trackAuthorization: true,
    })
      .catch((error) => {
        if (generation === authorizationGeneration) {
          authorizationError = safeErrorMessage(error, "飞书项目授权未完成，请重试");
        }
        throw error;
      })
      .finally(() => {
        if (generation === authorizationGeneration) authorization = null;
        authorizationPromise = null;
      });
    authorizationPromise.catch(() => {});
    return publicAuthorization;
  }

  async function cancelAuthorization() {
    authorizationGeneration += 1;
    authorizationProcess?.kill();
    authorizationProcess = null;
    authorization = null;
    authorizationPromise = null;
    authorizationError = null;
    return { state: "idle" };
  }

  async function decodeViewUrl(url) {
    const decoded = await runJson(["url", "decode", "--url", url]);
    if (decoded?.url_kind !== "view_story") {
      throw new ApiError(400, "FEISHU_PROJECT_VIEW_REQUIRED", "请填写飞书项目中的需求视图 URL");
    }
    const simpleName = textValue(decoded.simple_name);
    const viewId = textValue(decoded.view_id);
    const workItemType = textValue(decoded.work_item_type, "story");
    const decodedHost = textValue(decoded.host, host);
    if (!simpleName || !viewId || workItemType !== "story") {
      throw new ApiError(400, "FEISHU_PROJECT_VIEW_REQUIRED", "飞书需求视图 URL 格式无效");
    }
    return {
      url: textValue(decoded.raw, url),
      host: decodedHost,
      simpleName,
      viewId,
      workItemType,
    };
  }

  async function listViewWorkItems(view) {
    const payload = await runJson([
      "view", "get",
      "--view-id", view.viewId,
      "--project-key", view.simpleName,
      "--page-num", "1",
      "--auto-paginate",
    ]);
    const summaries = recordArray(payload).filter((record) => workItemId(record));
    const ids = [...new Set(summaries.map(workItemId))];
    if (ids.length === 0) return [];
    const details = await runJson([
      "workitem", "+batch-get",
      "--project-key", view.simpleName,
      "--work-item-ids", ids.join(","),
    ], { timeoutMs: Math.max(COMMAND_TIMEOUT_MS, ids.length * 2_000) });
    const detailsById = new Map(recordArray(details).flatMap((result) => {
      const detail = result?.data && typeof result.data === "object" ? result.data : result;
      const id = workItemId(detail) || workItemId(result);
      return id ? [[id, detail]] : [];
    }));
    return summaries.map((summary) => detailsById.get(workItemId(summary)) ?? summary);
  }

  return {
    status,
    startAuthorization,
    cancelAuthorization,
    decodeViewUrl,
    listViewWorkItems,
    async close() {
      authorizationGeneration += 1;
      authorizationProcess?.kill();
      authorizationProcess = null;
      authorization = null;
      authorizationPromise = null;
      authorizationError = null;
    },
  };
}
