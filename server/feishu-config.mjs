import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 1;
const TOKEN_MAX_LENGTH = 8_192;

export class FeishuConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeishuConfigError";
    this.code = code;
  }
}

function plainString(value, field, { required = false, maxLength = 256 } = {}) {
  if (value === null || value === undefined) {
    if (!required) return null;
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", `${field} 不能为空`);
  }
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", `${field} 格式无效`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", `${field} 不能为空`);
  }
  return normalized || null;
}

function timestamp(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", `${field} 必须是有效时间`);
  }
  return value;
}

function tasklists(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书任务清单最多只能选择 100 项");
  }
  const seen = new Set();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书任务清单格式无效");
    }
    const guid = plainString(item.guid, "tasklist.guid", { required: true, maxLength: 256 });
    const name = plainString(item.name, "tasklist.name", { required: true, maxLength: 256 });
    const url = plainString(item.url, "tasklist.url", { maxLength: 2_048 });
    if (seen.has(guid)) return [];
    seen.add(guid);
    return [{ guid, name, url }];
  });
}

function parseConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== CONFIG_VERSION) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件无效");
  }
  const allowedKeys = new Set([
    "version",
    "appId",
    "appSecret",
    "accessToken",
    "accessTokenExpiresAt",
    "refreshToken",
    "refreshTokenExpiresAt",
    "scopes",
    "tasklists",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件包含未知字段");
  }
  const appId = plainString(value.appId, "App ID", { required: true, maxLength: 256 });
  const appSecret = plainString(value.appSecret, "App Secret", { required: true, maxLength: 4_096 });
  const accessToken = plainString(value.accessToken, "accessToken", { maxLength: TOKEN_MAX_LENGTH });
  const refreshToken = plainString(value.refreshToken, "refreshToken", { maxLength: TOKEN_MAX_LENGTH });
  const accessTokenExpiresAt = timestamp(value.accessTokenExpiresAt, "accessTokenExpiresAt");
  const refreshTokenExpiresAt = timestamp(value.refreshTokenExpiresAt, "refreshTokenExpiresAt");
  if ((accessToken === null) !== (accessTokenExpiresAt === null)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "access token 配置不完整");
  }
  if ((refreshToken === null) !== (refreshTokenExpiresAt === null)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "refresh token 配置不完整");
  }
  if (value.scopes !== undefined && (typeof value.scopes !== "string" || value.scopes.length > 4_096)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "scopes 格式无效");
  }
  return {
    version: CONFIG_VERSION,
    appId,
    appSecret,
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    scopes: value.scopes ?? "",
    tasklists: tasklists(value.tasklists),
  };
}

export function createFeishuConfigStore({ configPath }) {
  if (!configPath) throw new Error("configPath is required");
  let pendingWrite = Promise.resolve();

  async function readFromDisk() {
    try {
      return parseConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeAtomically(config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  }

  return {
    async read() {
      await pendingWrite;
      return readFromDisk();
    },
    async save(input) {
      const config = parseConfig({ ...input, version: CONFIG_VERSION });
      const operation = pendingWrite.catch(() => {}).then(async () => {
        await writeAtomically(config);
        return config;
      });
      pendingWrite = operation.catch(() => {});
      return operation;
    },
    async clear() {
      await pendingWrite;
      try {
        await unlink(configPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
    validateCredentials({ appId, appSecret }) {
      return parseConfig({
        version: CONFIG_VERSION,
        appId,
        appSecret,
        accessToken: null,
        accessTokenExpiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        scopes: "",
        tasklists: [],
      });
    },
  };
}
