#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const nodeVersion = "22.23.2";
const nodeArchitectures = ["arm64", "x64"];
const nodeArchiveSha256 = {
  arm64: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  x64: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
};
const windowsTarget = "x86_64-pc-windows-msvc";
const windowsNodeArchiveName = `node-v${nodeVersion}-win-x64.zip`;
const windowsNodeArchiveSha256 =
  "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
const linuxTarget = "x86_64-unknown-linux-gnu";
const linuxNodeArchiveName = `node-v${nodeVersion}-linux-x64.tar.gz`;
const linuxNodeArchiveSha256 =
  "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a";
const feishuCliVersion = "1.0.82";
const feishuCliArchives = {
  "darwin-arm64": {
    name: `lark-cli-${feishuCliVersion}-darwin-arm64.tar.gz`,
    sha256: "4aad6d81b1a39a641c04d2a2c386e91a09c67334f027c32712bd65aef8dc6a7a",
  },
  "darwin-amd64": {
    name: `lark-cli-${feishuCliVersion}-darwin-amd64.tar.gz`,
    sha256: "3f9800b350399f58031e8fe534279c02afef627623d6bf767e895c1a9029ba62",
  },
  "linux-amd64": {
    name: `lark-cli-${feishuCliVersion}-linux-amd64.tar.gz`,
    sha256: "3ab5f030d66580b9e7908880fc6a21bb0c5cb214816579819b093c7ea1608cab",
  },
  "windows-amd64": {
    name: `lark-cli-${feishuCliVersion}-windows-amd64.zip`,
    sha256: "7d12b020965c9f8d86b2b09d932878f91476053bd5460ce83fcf985ff62b983",
  },
};
const feishuCliReleaseBase = `https://github.com/larksuite/cli/releases/download/v${feishuCliVersion}`;
const meegleCliVersion = "1.0.20";
const meeglePackageUrl = `https://registry.npmjs.org/@lark-project/meegle/-/meegle-${meegleCliVersion}.tgz`;
const meeglePackageSha256 = "042ae94cf8e50c246fe0b6db96abdb0753fbd4bfb5a5f5445909e25a89de7d8d";
const supportedTargets = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "universal-apple-darwin",
  windowsTarget,
  linuxTarget,
]);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const binariesDirectory = path.join(tauriRoot, "binaries");
const resourcesDirectory = path.join(tauriRoot, "resources");
const runtimeCacheDirectory = path.join(projectRoot, "dist", "tauri-runtime-cache");
const extractionDirectory = path.join(runtimeCacheDirectory, "extracted");
const target = parseTarget(process.argv.slice(2));

if (target === windowsTarget && process.platform !== "win32") {
  throw new Error("Codex Taskboard for Windows must be prepared on Windows");
}
if (target === linuxTarget && process.platform !== "linux") {
  throw new Error("Codex Taskboard for Linux must be prepared on Linux");
}
if (target !== windowsTarget && target !== linuxTarget && process.platform !== "darwin") {
  throw new Error("Codex Taskboard for macOS must be prepared on macOS");
}

function parseTarget(argv) {
  let selected = process.platform === "win32"
    ? windowsTarget
    : process.platform === "linux"
      ? linuxTarget
      : "universal-apple-darwin";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") selected = argv[++index];
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!supportedTargets.has(selected)) {
    throw new Error(`Unsupported Tauri target: ${selected}`);
  }
  return selected;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }
  const temporaryPath = `${destination}.download`;
  await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
  await rename(temporaryPath, destination);
}

async function verifiedNodeArchive(archiveName, expectedChecksum) {
  const archivePath = path.join(runtimeCacheDirectory, archiveName);
  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== expectedChecksum) {
    await rm(archivePath, { force: true });
    await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archivePath);
  }
  if ((await sha256(archivePath)) !== expectedChecksum) {
    throw new Error(`Checksum verification failed for ${archiveName}`);
  }
  return { archiveName, archivePath };
}

async function verifiedFeishuCliArchive(platformKey) {
  const archive = feishuCliArchives[platformKey];
  if (!archive) throw new Error(`Missing Feishu CLI archive metadata for ${platformKey}`);
  const archivePath = path.join(runtimeCacheDirectory, archive.name);
  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== archive.sha256) {
    await rm(archivePath, { force: true });
    await download(`${feishuCliReleaseBase}/${archive.name}`, archivePath);
  }
  if ((await sha256(archivePath)) !== archive.sha256) {
    throw new Error(`Feishu CLI checksum verification failed for ${archive.name}`);
  }
  return archivePath;
}

async function verifiedMeeglePackage() {
  const archivePath = path.join(runtimeCacheDirectory, `meegle-${meegleCliVersion}.tgz`);
  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== meeglePackageSha256) {
    await rm(archivePath, { force: true });
    await download(meeglePackageUrl, archivePath);
  }
  if ((await sha256(archivePath)) !== meeglePackageSha256) {
    throw new Error(`Meegle CLI checksum verification failed for ${meegleCliVersion}`);
  }
  return archivePath;
}

async function extractNodeRuntime(architecture) {
  const archiveName = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`;
  const { archivePath } = await verifiedNodeArchive(
    archiveName,
    nodeArchiveSha256[architecture],
  );
  const destination = path.join(extractionDirectory, architecture);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run(process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);
  return path.join(destination, `node-v${nodeVersion}-darwin-${architecture}`);
}

async function prepareMacNodeRuntime() {
  const runtimes = new Map();
  for (const architecture of nodeArchitectures) {
    runtimes.set(architecture, await extractNodeRuntime(architecture));
  }

  const universalNodePath = path.join(binariesDirectory, "node-universal-apple-darwin");
  await mkdir(binariesDirectory, { recursive: true });
  run("/usr/bin/lipo", [
    "-create",
    path.join(runtimes.get("arm64"), "bin", "node"),
    path.join(runtimes.get("x64"), "bin", "node"),
    "-output",
    universalNodePath,
  ]);
  await chmod(universalNodePath, 0o755);
  const architectures = run("/usr/bin/lipo", ["-archs", universalNodePath]);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error(`Universal Node runtime has unexpected architectures: ${architectures}`);
  }

  for (const targetTriple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const targetPath = path.join(binariesDirectory, `node-${targetTriple}`);
    await rm(targetPath, { force: true });
    await link(universalNodePath, targetPath);
  }
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtimes.get("arm64"), "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function prepareWindowsNodeRuntime() {
  const { archivePath } = await verifiedNodeArchive(
    windowsNodeArchiveName,
    windowsNodeArchiveSha256,
  );
  const destination = path.join(extractionDirectory, "win-x64");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run(path.join(process.env.SystemRoot, "System32", "tar.exe"), [
    "-xf",
    archivePath,
    "-C",
    destination,
  ]);

  const runtime = path.join(destination, `node-v${nodeVersion}-win-x64`);
  const targetPath = path.join(binariesDirectory, `node-${windowsTarget}.exe`);
  await mkdir(binariesDirectory, { recursive: true });
  await rm(targetPath, { force: true });
  await copyFile(path.join(runtime, "node.exe"), targetPath);
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtime, "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function prepareLinuxNodeRuntime() {
  const { archivePath } = await verifiedNodeArchive(
    linuxNodeArchiveName,
    linuxNodeArchiveSha256,
  );
  const destination = path.join(extractionDirectory, "linux-x64");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);

  const runtime = path.join(destination, `node-v${nodeVersion}-linux-x64`);
  const targetPath = path.join(
    binariesDirectory,
    `codex-taskboard-node-${linuxTarget}`,
  );
  await mkdir(binariesDirectory, { recursive: true });
  await rm(targetPath, { force: true });
  await copyFile(path.join(runtime, "bin", "node"), targetPath);
  await chmod(targetPath, 0o755);
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtime, "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
}

async function copyApplicationResources() {
  const appResources = path.join(resourcesDirectory, "app");
  await rm(resourcesDirectory, { recursive: true, force: true });
  await mkdir(appResources, { recursive: true });
  await Promise.all([
    cp(path.join(projectRoot, "server"), path.join(appResources, "server"), { recursive: true }),
    cp(path.join(projectRoot, "shared"), path.join(appResources, "shared"), { recursive: true }),
    cp(
      path.join(projectRoot, "node_modules", "smol-toml"),
      path.join(appResources, "node_modules", "smol-toml"),
      { recursive: true },
    ),
    cp(path.join(projectRoot, "dist", "web"), path.join(appResources, "dist", "web"), {
      recursive: true,
    }),
    cp(
      path.join(projectRoot, "skills", "manage-taskboard"),
      path.join(appResources, "skills", "manage-taskboard"),
      { recursive: true },
    ),
  ]);

  await mkdir(path.join(appResources, "scripts"), { recursive: true });
  for (const fileName of [
    "codex-cdp-pipe.mjs",
    "codex-injector.mjs",
    "codex-injector-runtime.mjs",
    "codex-rate-limits.mjs",
    "taskboard-supervisor.mjs",
  ]) {
    await copyFile(
      path.join(projectRoot, "scripts", fileName),
      path.join(appResources, "scripts", fileName),
    );
  }
  await mkdir(path.join(appResources, "inject"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "inject", "codex-taskboard.user.js"),
    path.join(appResources, "inject", "codex-taskboard.user.js"),
  );
  await mkdir(path.join(appResources, "cli"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "cli", "taskctl.mjs"),
    path.join(appResources, "cli", "taskctl.mjs"),
  );

  if (target === windowsTarget) {
    const taskctlWrapper = [
      "@echo off",
      "setlocal",
      "set \"CODEX_TASKBOARD_DATA_DIR=%APPDATA%\\Codex Taskboard\"",
      "set \"CODEX_TASKBOARD_RUNTIME_FILE=%CODEX_TASKBOARD_DATA_DIR%\\launcher-runtime.json\"",
      "\"%~dp0..\\node.exe\" \"%~dp0..\\app\\cli\\taskctl.mjs\" %*",
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
    const taskctlPath = path.join(resourcesDirectory, "bin", "taskctl.cmd");
    await mkdir(path.dirname(taskctlPath), { recursive: true });
    await writeFile(taskctlPath, taskctlWrapper);
    return;
  }

  if (target === linuxTarget) {
    const taskctlWrapper = `#!/bin/sh
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RESOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
export CODEX_TASKBOARD_DATA_DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/Codex Taskboard"
export CODEX_TASKBOARD_RUNTIME_FILE="$CODEX_TASKBOARD_DATA_DIR/launcher-runtime.json"
exec "$RESOURCE_DIR/../../bin/codex-taskboard-node" "$RESOURCE_DIR/app/cli/taskctl.mjs" "$@"
`;
    const taskctlPath = path.join(resourcesDirectory, "bin", "taskctl");
    await mkdir(path.dirname(taskctlPath), { recursive: true });
    await writeFile(taskctlPath, taskctlWrapper);
    await chmod(taskctlPath, 0o755);
    return;
  }

  const taskctlWrapper = `#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTENTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export CODEX_TASKBOARD_DATA_DIR="$HOME/Library/Application Support/Codex Taskboard"
export CODEX_TASKBOARD_RUNTIME_FILE="$CODEX_TASKBOARD_DATA_DIR/launcher-runtime.json"
exec "$CONTENTS_DIR/MacOS/node" "$CONTENTS_DIR/Resources/app/cli/taskctl.mjs" "$@"
`;
  const taskctlPath = path.join(resourcesDirectory, "bin", "taskctl");
  await mkdir(path.dirname(taskctlPath), { recursive: true });
  await writeFile(taskctlPath, taskctlWrapper);
  await chmod(taskctlPath, 0o755);
}

async function prepareFeishuCliRuntime() {
  const binDirectory = path.join(resourcesDirectory, "bin");
  const licensesDirectory = path.join(resourcesDirectory, "licenses");
  await mkdir(binDirectory, { recursive: true });
  await mkdir(licensesDirectory, { recursive: true });

  const license = `MIT License

Copyright (c) 2026 Lark Technologies Pte. Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
  await writeFile(path.join(licensesDirectory, "lark-cli-LICENSE"), license);
  await writeFile(
    path.join(resourcesDirectory, "lark-cli-version.json"),
    `${JSON.stringify({
      version: feishuCliVersion,
      source: "larksuite/cli",
      archives: Object.fromEntries(Object.entries(feishuCliArchives).map(([key, value]) => [key, value])),
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(resourcesDirectory, "meegle-version.json"),
    `${JSON.stringify({ version: meegleCliVersion, source: "larksuite/meegle-cli" }, null, 2)}\n`,
  );

  if (target === windowsTarget) {
    const archivePath = await verifiedFeishuCliArchive("windows-amd64");
    const destination = path.join(extractionDirectory, "feishu-cli-win-x64");
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    run(path.join(process.env.SystemRoot, "System32", "tar.exe"), ["-xf", archivePath, "-C", destination]);
    await copyFile(path.join(destination, "lark-cli.exe"), path.join(binDirectory, "lark-cli.exe"));
    return;
  }

  if (target === linuxTarget) {
    const archivePath = await verifiedFeishuCliArchive("linux-amd64");
    const destination = path.join(extractionDirectory, "feishu-cli-linux-x64");
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    run("/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);
    const binaryPath = path.join(binDirectory, "lark-cli");
    await copyFile(path.join(destination, "lark-cli"), binaryPath);
    await chmod(binaryPath, 0o755);
    return;
  }

  const [armArchive, x64Archive] = await Promise.all([
    verifiedFeishuCliArchive("darwin-arm64"),
    verifiedFeishuCliArchive("darwin-amd64"),
  ]);
  const armDestination = path.join(extractionDirectory, "feishu-cli-darwin-arm64");
  const x64Destination = path.join(extractionDirectory, "feishu-cli-darwin-x64");
  await Promise.all([
    rm(armDestination, { recursive: true, force: true }),
    rm(x64Destination, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(armDestination, { recursive: true }),
    mkdir(x64Destination, { recursive: true }),
  ]);
  run("/usr/bin/tar", ["-xzf", armArchive, "-C", armDestination]);
  run("/usr/bin/tar", ["-xzf", x64Archive, "-C", x64Destination]);
  const binaryPath = path.join(binDirectory, "lark-cli");
  run("/usr/bin/lipo", [
    "-create",
    path.join(armDestination, "lark-cli"),
    path.join(x64Destination, "lark-cli"),
    "-output",
    binaryPath,
  ]);
  await chmod(binaryPath, 0o755);
}

async function prepareMeegleCliRuntime() {
  const archivePath = await verifiedMeeglePackage();
  const destination = path.join(extractionDirectory, "meegle-package");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);
  const binDirectory = path.join(resourcesDirectory, "bin");
  const licensesDirectory = path.join(resourcesDirectory, "licenses");
  await mkdir(binDirectory, { recursive: true });
  await mkdir(licensesDirectory, { recursive: true });
  await copyFile(path.join(destination, "package", "LICENSE"), path.join(licensesDirectory, "meegle-LICENSE"));
  if (target === windowsTarget) {
    await copyFile(path.join(destination, "package", "bin", "meegle-win32-x64.exe"), path.join(binDirectory, "meegle.exe"));
    return;
  }
  if (target === linuxTarget) {
    await copyFile(path.join(destination, "package", "bin", "meegle-linux-x64"), path.join(binDirectory, "meegle"));
    await chmod(path.join(binDirectory, "meegle"), 0o755);
    return;
  }
  const armPath = path.join(destination, "package", "bin", "meegle-darwin-arm64");
  const x64Path = path.join(destination, "package", "bin", "meegle-darwin-x64");
  const binaryPath = path.join(binDirectory, "meegle");
  run("/usr/bin/lipo", ["-create", armPath, x64Path, "-output", binaryPath]);
  await chmod(binaryPath, 0o755);
}

await mkdir(runtimeCacheDirectory, { recursive: true });
await copyApplicationResources();
await prepareMeegleCliRuntime();
if (target === windowsTarget) await prepareWindowsNodeRuntime();
else if (target === linuxTarget) await prepareLinuxNodeRuntime();
else await prepareMacNodeRuntime();
await rm(extractionDirectory, { recursive: true, force: true });
console.log(`Prepared Tauri resources for ${target} with Node.js ${nodeVersion}`);
