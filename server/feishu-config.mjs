import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 2;

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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件无效");
  }
  if (value.version === 1) {
    return {
      version: CONFIG_VERSION,
      tasklists: tasklists(value.tasklists),
    };
  }
  if (value.version !== CONFIG_VERSION) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件版本无效");
  }
  if (Object.keys(value).some((key) => !new Set(["version", "tasklists"]).has(key))) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件包含未知字段");
  }
  return {
    version: CONFIG_VERSION,
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
  };
}
