import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";

const PROFILE_NAME = "taskboard";
const COMMAND_TIMEOUT_MS = 30_000;
const AUTH_COMMAND_TIMEOUT_MS = 10 * 60_000;
const QR_SIZE = 320;

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

function dataEnvelope(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.data !== undefined) {
    return value.data;
  }
  return value;
}

function cliError(code, message, details) {
  return new ApiError(502, code, message, details);
}

function normalizeExpiresAt(payload) {
  const absolute = payload?.expires_at ?? payload?.expiresAt;
  if (typeof absolute === "string" && !Number.isNaN(Date.parse(absolute))) {
    return new Date(absolute).toISOString();
  }
  const seconds = Number(payload?.expires_in ?? payload?.expiresIn ?? payload?.expires);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1_000).toISOString();
  }
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

function normalizeAuthorization(payload) {
  const value = dataEnvelope(payload) ?? {};
  const authorizationUrl = textValue(
    value.verification_url ?? value.verificationUrl ?? value.authorization_url ?? value.authorizationUrl,
  );
  const deviceCode = textValue(value.device_code ?? value.deviceCode);
  if (!authorizationUrl || !deviceCode) {
    throw cliError("FEISHU_CLI_INVALID_OUTPUT", "飞书 CLI 未返回有效的授权信息");
  }
  return {
    authorizationUrl,
    deviceCode,
    expiresAt: normalizeExpiresAt(value),
  };
}

function normalizeTasklists(payload) {
  const value = dataEnvelope(payload);
  const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
  return items.flatMap((item) => {
    if (typeof item?.guid !== "string" || typeof item?.name !== "string") return [];
    return [{
      guid: item.guid,
      name: item.name,
      url: typeof item.url === "string" ? item.url : null,
    }];
  });
}

function normalizeTaskSummaries(payload) {
  const value = dataEnvelope(payload);
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function normalizeTaskDetail(payload) {
  const value = dataEnvelope(payload);
  return value?.task && typeof value.task === "object" ? value.task : value;
}

function normalizeStatus(payload, { appId, appConfigured }) {
  const value = dataEnvelope(payload) ?? {};
  const user = value.identities?.user ?? value.user ?? {};
  const status = textValue(user.status, "missing");
  const scopes = textValue(user.scope ?? user.scopes, "");
  return {
    cliAvailable: true,
    configured: appConfigured,
    authorized: status === "ready",
    appId: textValue(value.appId, appId) || null,
    displayName: textValue(user.userName ?? user.name, "") || null,
    scopes: scopes.split(/\s+/).filter(Boolean),
    verified: value.verified === true || user.status === "ready",
    tokenStatus: textValue(user.tokenStatus, "") || null,
    authorizationState: status === "ready" ? "authorized" : "idle",
  };
}

function profileMarkerPath(homeDirectory) {
  return path.join(homeDirectory, ".taskboard-profile.json");
}

export function resolveFeishuCliPath({ explicitPath, projectRoot = process.cwd(), platform = process.platform } = {}) {
  if (explicitPath) return path.resolve(explicitPath);
  const binaryName = platform === "win32" ? "lark-cli.exe" : "lark-cli";
  const packagedPath = path.resolve(projectRoot, "..", "bin", binaryName);
  const developmentPath = path.resolve(projectRoot, "src-tauri", "resources", "bin", binaryName);
  if (!existsSync(packagedPath) && existsSync(developmentPath)) return developmentPath;
  return packagedPath;
}

export function createFeishuCli({
  executablePath,
  dataDirectory,
  appId = "",
  appSecret = "",
  profileName = PROFILE_NAME,
  spawn = spawnProcess,
  platform = process.platform,
} = {}) {
  if (!executablePath) throw new Error("executablePath is required");
  if (!dataDirectory) throw new Error("dataDirectory is required");
  const homeDirectory = path.join(dataDirectory, "lark-cli-home");
  const workDirectory = path.join(homeDirectory, "runtime");
  const markerPath = profileMarkerPath(homeDirectory);
  let authorization = null;
  let authorizationPromise = null;
  let authorizationProcess = null;
  let authorizationError = null;
  let authorizationGeneration = 0;

  function commandEnvironment() {
    const environment = {
      ...process.env,
      HOME: homeDirectory,
      ...(platform === "win32" ? { USERPROFILE: homeDirectory } : {}),
    };
    delete environment.CODEX_TASKBOARD_FEISHU_APP_SECRET;
    return environment;
  }

  async function run(args, {
    input = null,
    cwd = homeDirectory,
    timeoutMs = COMMAND_TIMEOUT_MS,
    useProfile = true,
    trackAuthorization = false,
  } = {}) {
    await mkdir(cwd, { recursive: true });
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(executablePath, [
        ...(useProfile ? ["--profile", profileName] : []),
        ...args,
      ], {
        cwd,
        env: commandEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (trackAuthorization) authorizationProcess = child;
      const timer = setTimeout(() => {
        child.kill();
        if (!settled) {
          settled = true;
          reject(cliError("FEISHU_CLI_TIMEOUT", "飞书 CLI 操作超时"));
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
        reject(cliError("FEISHU_CLI_UNAVAILABLE", "当前安装包缺少飞书登录组件", {
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
      if (input === null || input === undefined) child.stdin.end();
      else {
        child.stdin.end(String(input));
      }
    });
  }

  async function runJson(args, options = {}) {
    const result = await run(args, options);
    if (result.code !== 0) {
      const parsed = (() => {
        try { return JSON.parse(result.stdout); } catch { return null; }
      })();
      const message = textValue(parsed?.error?.message, "飞书 CLI 操作失败");
      throw cliError("FEISHU_CLI_COMMAND_FAILED", message, {
        exitCode: result.code,
        signal: result.signal,
      });
    }
    return parseJson(result.stdout, "飞书 CLI 返回了无效的 JSON 数据");
  }

  async function profileList() {
    const result = await run(["profile", "list"], { useProfile: false });
    if (result.code !== 0) return [];
    const parsed = parseJson(result.stdout, "飞书 CLI 返回了无效的 profile 数据");
    return Array.isArray(parsed) ? parsed : [];
  }

  async function ensureProfile() {
    if (!appId || !appSecret) {
      throw new ApiError(
        409,
        "FEISHU_APP_CONFIG_REQUIRED",
        "服务端尚未配置固定飞书应用，请设置 CODEX_TASKBOARD_FEISHU_APP_ID 和 CODEX_TASKBOARD_FEISHU_APP_SECRET",
      );
    }
    await mkdir(homeDirectory, { recursive: true });
    let marker = null;
    try {
      marker = JSON.parse(await readFile(markerPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (marker?.profileName === profileName && marker?.appId === appId) return;

    const profiles = await profileList();
    const existing = profiles.find((profile) => profile?.name === profileName);
    if (existing) {
      if (existing.appId !== appId) {
        throw new ApiError(409, "FEISHU_PROFILE_CONFLICT", "Taskboard 的飞书应用配置与当前发布配置不一致，请清理本地连接后重试");
      }
      await writeFile(markerPath, `${JSON.stringify({ profileName, appId })}\n`, { mode: 0o600 });
      return;
    }

    const result = await run([
      "profile", "add",
      "--name", profileName,
      "--app-id", appId,
      "--app-secret-stdin",
      "--brand", "feishu",
    ], { input: appSecret, useProfile: false });
    if (result.code !== 0) {
      throw cliError("FEISHU_CLI_PROFILE_FAILED", "无法初始化 Taskboard 的飞书应用配置");
    }
    await writeFile(markerPath, `${JSON.stringify({ profileName, appId })}\n`, { mode: 0o600 });
  }

  async function status() {
    const appConfigured = Boolean(appId && appSecret);
    if (authorization && Date.parse(authorization.expiresAt) > Date.now()) {
      return {
        configured: appConfigured,
        authorized: false,
        appId: appId || null,
        displayName: null,
        scopes: [],
        verified: false,
        tokenStatus: "pending",
        authorizationState: "pending",
        ...authorization.public,
      };
    }
    if (authorizationError) {
      return {
        cliAvailable: true,
        configured: appConfigured,
        authorized: false,
        appId: appConfigured ? appId : null,
        displayName: null,
        scopes: [],
        verified: false,
        tokenStatus: null,
        authorizationState: "failed",
        error: authorizationError,
      };
    }
    if (authorization && Date.parse(authorization.expiresAt) <= Date.now()) {
      authorization = null;
    }
    let profiles;
    try {
      profiles = await profileList();
    } catch (error) {
      if (error instanceof ApiError && error.code === "FEISHU_CLI_UNAVAILABLE") {
        return {
          cliAvailable: false,
          configured: false,
          authorized: false,
          appId: null,
          displayName: null,
          scopes: [],
          verified: false,
          tokenStatus: null,
          authorizationState: "idle",
          error: "当前安装包缺少飞书登录组件",
        };
      }
      throw error;
    }
    const profile = profiles.find((candidate) => candidate?.name === profileName);
    if (!profile) {
      return {
        cliAvailable: true,
        configured: appConfigured,
        authorized: false,
        appId: appConfigured ? appId : null,
        displayName: null,
        scopes: [],
        verified: false,
        tokenStatus: null,
        authorizationState: "idle",
      };
    }
    const payload = await runJson(["auth", "status", "--json", "--verify"]);
    return normalizeStatus(payload, { appId, appConfigured });
  }

  async function startAuthorization() {
    await ensureProfile();
    if (authorization && Date.parse(authorization.expiresAt) > Date.now()) return authorization.public;
    const generation = ++authorizationGeneration;
    authorizationError = null;
    const payload = await runJson(["auth", "login", "--domain", "task", "--no-wait", "--json"]);
    const normalized = normalizeAuthorization(payload);
    const qrFileName = `authorization-${createHash("sha256").update(normalized.deviceCode).digest("hex").slice(0, 16)}.png`;
    const qrResult = await run(["auth", "qrcode", normalized.authorizationUrl, "--output", qrFileName, "--size", String(QR_SIZE)], {
      cwd: workDirectory,
    });
    if (qrResult.code !== 0) throw cliError("FEISHU_CLI_QR_FAILED", "无法生成飞书授权二维码");
    const qrData = await readFile(path.join(workDirectory, qrFileName));
    await rm(path.join(workDirectory, qrFileName), { force: true });
    const publicAuthorization = {
      state: "pending",
      authorizationUrl: normalized.authorizationUrl,
      authorizationQrCode: `data:image/png;base64,${qrData.toString("base64")}`,
      authorizationExpiresAt: normalized.expiresAt,
    };
    authorization = { ...normalized, public: publicAuthorization };
    authorizationPromise = run(["auth", "login", "--device-code", normalized.deviceCode], {
      timeoutMs: Math.max(COMMAND_TIMEOUT_MS, Date.parse(normalized.expiresAt) - Date.now()),
      trackAuthorization: true,
    })
      .then((result) => {
        if (result.code !== 0) throw cliError("FEISHU_AUTH_FAILED", "飞书授权未完成，请重试");
        return runJson(["auth", "status", "--json", "--verify"]);
      })
      .catch((error) => {
        if (generation === authorizationGeneration) {
          authorizationError = safeErrorMessage(error, "飞书授权未完成，请重试");
        }
        throw error;
      })
      .finally(() => {
        authorization = null;
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

  async function listTasklists() {
    const payload = await runJson(["task", "tasklists", "list", "--as", "user", "--page-all", "--json"]);
    return normalizeTasklists(payload);
  }

  async function listTasklistTasks(guid) {
    const payload = await runJson([
      "task", "tasklists", "tasks",
      "--tasklist-guid", guid,
      "--as", "user",
      "--page-all",
      "--json",
    ]);
    return normalizeTaskSummaries(payload);
  }

  async function getTask(guid) {
    const payload = await runJson(["task", "tasks", "get", "--task-guid", guid, "--as", "user", "--json"]);
    return normalizeTaskDetail(payload);
  }

  async function patchTask(guid, data) {
    const payload = await runJson([
      "task", "tasks", "patch",
      "--task-guid", guid,
      "--data", "-",
      "--as", "user",
      "--json",
    ], { input: JSON.stringify(data) });
    return normalizeTaskDetail(payload);
  }

  return {
    ensureProfile,
    status,
    startAuthorization,
    cancelAuthorization,
    async close() {
      authorizationGeneration += 1;
      authorizationProcess?.kill();
      authorizationProcess = null;
      authorization = null;
      authorizationPromise = null;
      authorizationError = null;
    },
    listTasklists,
    listTasklistTasks,
    getTask,
    patchTask,
  };
}
