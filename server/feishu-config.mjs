import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 4;

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

function projectView(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书需求视图配置无效");
  }
  const allowed = new Set(["url", "host", "simpleName", "viewId", "workItemType"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书需求视图配置包含未知字段");
  }
  return {
    url: plainString(value.url, "view.url", { required: true, maxLength: 2_048 }),
    host: plainString(value.host, "view.host", { required: true, maxLength: 256 }),
    simpleName: plainString(value.simpleName, "view.simpleName", { required: true, maxLength: 256 }),
    viewId: plainString(value.viewId, "view.viewId", { required: true, maxLength: 256 }),
    workItemType: plainString(value.workItemType, "view.workItemType", { required: true, maxLength: 128 }),
  };
}

function projectBindings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书项目绑定配置无效");
  }
  const projects = {};
  for (const [projectId, view] of Object.entries(value)) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(projectId)) {
      throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书项目绑定的项目 ID 无效");
    }
    projects[projectId] = projectView(view);
  }
  return projects;
}

function parseConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件无效");
  }
  if (value.version === 1 || value.version === 2) {
    return { version: CONFIG_VERSION, projects: {} };
  }
  if (value.version === 3) {
    if (Object.keys(value).some((key) => !new Set(["version", "view"]).has(key))) {
      throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件包含未知字段");
    }
    return {
      version: CONFIG_VERSION,
      projects: value.view ? { "feishu-tasks": projectView(value.view) } : {},
    };
  }
  if (value.version !== CONFIG_VERSION) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件版本无效");
  }
  if (Object.keys(value).some((key) => !new Set(["version", "projects"]).has(key))) {
    throw new FeishuConfigError("INVALID_FEISHU_CONFIG", "飞书配置文件包含未知字段");
  }
  return {
    version: CONFIG_VERSION,
    projects: projectBindings(value.projects),
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
