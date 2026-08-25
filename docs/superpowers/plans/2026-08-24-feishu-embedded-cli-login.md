# Taskboard 内置飞书 CLI 登录实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将官方 `lark-cli` 固定版本随 Taskboard 打包，并让用户在点击“接入飞书”后通过二维码或授权链接登录、读取和操作其可访问的飞书任务。

**Architecture:** 服务端新增 `feishu-cli.mjs` 作为唯一 CLI 适配层，使用 Taskboard 独立 HOME/profile 调用内置二进制；`feishu-integration.mjs` 保留现有任务投影和同步逻辑，改用适配层执行认证及任务读写。Web 连接对话框负责展示授权会话和轮询状态，Tauri 资源准备脚本负责下载、校验并打包各平台 CLI。

**Tech Stack:** Node.js 22 ESM、Node `child_process.spawn`、官方 `@larksuite/cli` 原生二进制、React/TypeScript、Tauri 2 resources。

**Spec:** `docs/superpowers/specs/2026-08-24-feishu-embedded-cli-login-design.md`

## Global Constraints

- 授权只在用户点击“接入飞书”后触发，Taskboard 启动时不得自动打开授权页。
- 发布包不得依赖 PATH 中的全局 `lark-cli`，必须使用固定版本的内置二进制。
- CLI 使用 `<taskboard-data>/lark-cli-home` 和 `--profile taskboard`，不得读取或覆盖用户全局 `~/.lark-cli`。
- `App Secret` 通过 `--app-secret-stdin` 注入，不进入 argv、日志、Web API 或仓库。
- Web API 只能返回授权 URL、二维码、过期时间和脱敏状态，不返回 device code、token 或 Secret。
- 保留现有飞书任务字段映射和不支持字段限制；本期不接入飞书 Project 工作项。
- 先验证真实操作路径，再决定是否增加额外保护或回归测试；本次按项目规则不新增与主路径无关的测试套件。

### Task 1: 增加官方 CLI 适配层与授权会话

**Files:**
- Create: `server/feishu-cli.mjs`
- Modify: `server/app.mjs: imports and resolveServerOptions/createTaskboardServer wiring`

**Interfaces:**
- Consumes: `executablePath`, `dataDirectory`, `appId`, `appSecret` and an injectable `spawn` implementation.
- Produces: `createFeishuCli(options)` with `ensureProfile()`, `status()`, `startAuthorization()`, `completeAuthorization(deviceCode)`, `cancelAuthorization()`, `listTasklists()`, `listTasklistTasks(guid)`, `getTask(guid)`, and `patchTask(guid, data)`.

- [ ] **Step 1: Define command execution and output normalization.**

  Implement a single `run(args, { input, cwd, timeoutMs })` helper around `spawn` with `shell: false`, explicit `HOME`/`USERPROFILE`, bounded stdout/stderr collection, timeout termination, and a structured non-zero exit error. Parse CLI JSON from either the direct payload or a `data` envelope; never include raw stderr in the returned API error.

- [ ] **Step 2: Implement isolated profile provisioning.**

  Resolve `<taskboard-data>/lark-cli-home`, create a temporary working directory below it, and use:

  ```text
  lark-cli --profile taskboard profile add --name taskboard --app-id <app-id> --app-secret-stdin
  ```

  only when the profile marker is absent. Pass the Secret only through stdin, persist a mode `0600` marker after success, and report `FEISHU_APP_CONFIG_REQUIRED` when either configured application value is missing.

- [ ] **Step 3: Implement Device Flow start, QR generation, and completion.**

  Start authorization with `auth login --domain task --no-wait --json`, normalize `verification_url`, `device_code`, and expiry fields, then call `auth qrcode <url> --output <relative.png>` in the temporary working directory and return a PNG data URL. Run `auth login --device-code <code>` in the background, expose a pending/authorized/failed state, and confirm completion with `auth status --json --verify`.

- [ ] **Step 4: Implement task command wrappers.**

  Use `--as user --page-all --json` for task-list and task-list task reads, `tasks get --task-guid` for details, and `tasks patch --task-guid --data - --as user --json` with JSON on stdin for writes. Normalize pagination and command output into the existing tasklist/task shapes.

- [ ] **Step 5: Wire CLI path resolution into server options.**

  Add `feishuCliPath` and `feishuCliHomePath` options. Prefer an explicit `CODEX_TASKBOARD_FEISHU_CLI_PATH`; otherwise resolve the packaged sibling resource (`Resources/bin/lark-cli[.exe]`) and allow the development fallback to the locally installed `lark-cli` only when explicitly configured. Pass the CLI instance into the Feishu integration.

- [ ] **Step 6: Verify the adapter without contacting Feishu.**

  Run:

  ```bash
  node --check server/feishu-cli.mjs server/app.mjs
  ```

  Exercise the injected spawn path with fixed JSON/exit fixtures to confirm stdin Secret handling, URL/QR normalization, timeout cleanup, and token-free status results before connecting it to the application flow.

### Task 2: Replace direct OAuth/OpenAPI calls with the CLI integration

**Files:**
- Modify: `server/feishu-config.mjs`
- Modify: `server/feishu-integration.mjs`
- Modify: `server/app.mjs: Feishu construction and legacy callback route`

**Interfaces:**
- Consumes: Task 1 `FeishuCli` methods and existing `TaskboardDatabase.syncFeishuTasks` projection.
- Produces: `status`, `startAuthorization`, `cancelAuthorization`, `listTasklists`, `saveTasklists`, `sync`, `reconcile`, and `updateTask` with the same callers as today.

- [ ] **Step 1: Reduce local Feishu config to selected tasklists.**

  Change the file schema so it stores only versioned tasklist selections and synchronization metadata. Do not persist App Secret, access token, or refresh token in `feishu-connection.json`; treat old token-bearing files as legacy input and stop using their credentials for new authorization.

- [ ] **Step 2: Move connection status to CLI status.**

  Make `status()` combine selected tasklists from the local store with `FeishuCli.status()`. Return `authorizationState` (`idle`, `pending`, `authorized`, `failed`), `authorizationUrl`, QR data URL, expiry, display name, app ID, scopes, and existing project/sync fields. Keep all sensitive fields out of the object.

- [ ] **Step 3: Replace authorization and task reads/writes.**

  `startAuthorization()` must call `ensureProfile()` and `startAuthorization()` on the CLI only after the HTTP endpoint is invoked. `listTasklists`, tasklist pagination, detail reads, and `updateTask` must delegate to CLI wrappers while preserving existing normalization, throttling, archive behavior, status mapping, and unsupported-field errors.

- [ ] **Step 4: Add pending-session cancellation and expiry behavior.**

  Store only the active CLI authorization process handle and expiry in memory. Reuse a live pending session on repeated requests, terminate it on cancel/expiry/server close, and clear the pending state after success or failure. Keep synchronization serialized as before.

- [ ] **Step 5: Update server routes.**

  Change `POST /api/local/feishu-connection/authorize` to return the new URL/QR/session object and remove callback construction from the new path. Add `POST /api/local/feishu-connection/cancel`; keep the old callback route as a non-primary compatibility response that does not issue new tokens. Ensure the existing tasklists, save, and sync routes use the CLI-backed integration.

- [ ] **Step 6: Verify the server path with a fake CLI.**

  Start `createTaskboardServer` with an injected fake CLI and confirm:

  ```text
  GET status -> idle and no CLI login call
  POST authorize -> pending + verification URL + QR data
  GET status -> authorized after fake completion
  GET tasklists -> fake user tasklists
  PUT tasklists -> projected Taskboard tasks
  PATCH/move -> fake CLI patch received the expected body
  ```

### Task 3: Update the Web authorization experience

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/FeishuConnectionDialog.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: new `FeishuConnection` authorization fields and `/authorize`/`/cancel` responses.
- Produces: click-to-authorize dialog with QR, browser link, pending polling, cancellation, and automatic tasklist refresh.

- [ ] **Step 1: Extend client types and API functions.**

  Add typed `authorizationState`, `authorizationUrl`, `authorizationQrCode`, `authorizationExpiresAt`, `displayName`, and error fields. Change `startFeishuAuthorization()` to return the complete authorization session and add `cancelFeishuAuthorization()`.

- [ ] **Step 2: Make the dialog inert until the user clicks.**

  Remove the callback URI input and environment-variable setup message. Render only connection status and the “接入飞书” action before authorization; after clicking, render the QR image, an “打开飞书授权页” button, expiry state, cancel/regenerate actions, and tasklist controls after authorization.

- [ ] **Step 3: Add polling and browser navigation in App.**

  On the click handler, call the authorize API, set the returned session, open the returned URL only from that user action, and poll `getFeishuConnection()` while the state is pending. On authorized, fetch tasklists once, stop polling, and announce success. On cancel, call the cancel endpoint and clear the session without closing unrelated dialogs.

- [ ] **Step 4: Add stable QR/link layout styles.**

  Add a fixed QR preview size, readable expiry/error states, and responsive actions using existing button/dialog styles. Keep all text inside its parent and preserve the current Taskboard visual language.

- [ ] **Step 5: Verify the UI path in the real injected panel.**

  Run the web typecheck/build, open the Taskboard panel, open “接入飞书”, confirm no authorization request is made before the click, then confirm QR/link/pending states appear after the click using the local fake/configured CLI endpoint.

### Task 4: Package the official CLI for Tauri

**Files:**
- Modify: `scripts/prepare-tauri-app.mjs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/tauri.linux.conf.json`
- Modify: `src-tauri/tauri.windows.conf.json`
- Create: `src-tauri/resources/licenses/lark-cli-LICENSE`
- Create: `src-tauri/resources/lark-cli-version.json`

**Interfaces:**
- Consumes: official `lark-cli` v1.0.82 release archives and checksums.
- Produces: `resources/bin/lark-cli`, `lark-cli.exe`, or the platform-specific executable visible to the packaged server.

- [ ] **Step 1: Lock official archive metadata.**

  Add the v1.0.82 archive names and SHA-256 values for macOS arm64/x64, Linux x64, and Windows x64 from the official `larksuite/cli` release. Keep the MIT license and version metadata in resources; do not add credentials.

- [ ] **Step 2: Download, verify, extract, and place the binary.**

  Extend the existing cache/download helpers to fetch only allowlisted HTTPS release URLs, verify SHA-256 before extraction, extract the `lark-cli` executable, set mode `0755` on Unix, and copy it to `resources/bin` beside the taskctl wrapper.

- [ ] **Step 3: Keep platform resource paths consistent.**

  Ensure macOS universal, Linux x64, and Windows x64 Tauri resource configurations include the `resources/` directory and that the server resolver finds the correct executable name in each bundle.

- [ ] **Step 4: Verify packaged resource contents.**

  Run the existing app preparation command for the current macOS target and verify:

  ```bash
  test -x src-tauri/resources/bin/lark-cli
  src-tauri/resources/bin/lark-cli --version
  cat src-tauri/resources/lark-cli-version.json
  ```

  Confirm the output version and checksum match the lock metadata and no App Secret exists under `src-tauri/`.

### Task 5: Direct-path verification and delivery

**Files:**
- Modify: `docs/superpowers/specs/2026-08-24-feishu-embedded-cli-login-design.md` only if implementation details require a clarified contract.
- Modify: `docs/` operational configuration notes if the release injection command is not already documented.

**Interfaces:**
- Consumes: completed CLI bridge, server routes, UI, and packaged resources.
- Produces: verified Taskboard login-to-task-sync path and a reviewable implementation commit.

- [ ] **Step 1: Run focused static checks.**

  ```bash
  npm run typecheck
  npm run build:web
  node --check server/feishu-cli.mjs server/feishu-integration.mjs server/app.mjs
  git diff --check
  ```

- [ ] **Step 2: Run the real local operation path.**

  Start the injected Taskboard panel with the configured CLI profile, open the project menu, click “接入飞书”, scan/open the displayed authorization URL, confirm the authorized user and tasklists, select a list, sync, then edit a supported task field and verify the CLI patch call reaches Feishu.

- [ ] **Step 3: Rebuild and inject the panel.**

  Run the repository’s injector refresh command, leave the existing user data directory untouched, and confirm the active panel is serving the rebuilt UI.

- [ ] **Step 4: Record implementation evidence.**

  Record changed files, final commit SHA, build/typecheck results, direct browser path, packaging result, and any external prerequisite such as release-time Feishu app credential injection. Do not mark the feature done without explicit user acceptance.

- [ ] **Step 5: Commit the implementation.**

  Use the repository’s Chinese conventional commit format, for example:

  ```text
  feat(feishu): 内置 CLI 登录并同步飞书任务

  - 随 Taskboard 打包固定版本的官方 lark-cli
  - 点击接入后显示二维码并完成用户授权
  - 通过 CLI 读取和更新用户可访问的飞书任务
  - 保留现有任务清单投影和本地同步限制
  ```

## Self-Review Checklist

- [ ] Every design section has an implementation task: click-only authorization (Tasks 2–3), CLI reuse (Tasks 1–2), task mapping (Task 2), packaging (Task 4), error/session handling (Tasks 1–2), and direct verification (Task 5).
- [ ] No task depends on a global `lark-cli` in the production bundle.
- [ ] No plan step writes or returns an App Secret or user token through Web/API/logging.
- [ ] The plan has no unresolved placeholders and uses consistent names for the CLI profile and connection fields.
