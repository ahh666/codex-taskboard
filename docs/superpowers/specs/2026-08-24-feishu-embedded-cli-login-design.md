# Taskboard 内置飞书 CLI 登录设计

## 目标

Taskboard 内置官方 `lark-cli` 的登录与飞书任务能力。用户不需要在 Taskboard 表单中填写 `App ID` 或 `App Secret`，也不需要单独安装 CLI；只有在用户点击“接入飞书”时，Taskboard 才发起授权并显示二维码或授权链接。

本期继续接入飞书任务清单，不扩展为飞书 Project 工作项集成。飞书 Project 团队、工作项、成员和项目工作流不在本设计范围内。

## 真实操作路径

1. 用户打开 Taskboard。服务端只查询授权状态，不自动跳转、不创建授权请求。
2. 用户点击项目菜单中的“接入飞书”。Web 调用 `POST /api/local/feishu-connection/authorize`。
3. 服务端在 Taskboard 专属 CLI 配置目录中调用内置 `lark-cli auth login --no-wait --json`，获取一次性 verification URL 和 device code。
4. 服务端调用 `lark-cli auth qrcode` 生成二维码数据，同时返回脱敏的授权 URL、二维码和过期时间。Web 显示“扫码授权”和“打开飞书授权页”两个入口。
5. 服务端后台调用 `lark-cli auth login --device-code <device_code>` 等待用户在飞书确认授权；Web 轮询连接状态。
6. 授权完成后，服务端调用 `lark-cli auth status --json --verify` 确认用户身份和有效权限，并调用 `lark-cli task tasklists list --as user --page-all --json` 读取用户可访问的任务清单。
7. 用户选择任务清单并保存。服务端使用内置 CLI 的任务命令分页读取清单任务、查询详情，并投影到现有“飞书任务”项目。
8. 用户编辑支持的字段或切换待办/完成状态时，服务端调用 `lark-cli task tasks patch --task-guid ... --data ...` 写回飞书，再更新本地投影并返回可观察结果。

这条路径的可观察结果是：用户点击后看到二维码/授权链接，授权完成后能看到自己的飞书任务清单，选择清单后任务出现在 Taskboard；Taskboard 中支持的修改会反映到飞书。

## 设计方案

### 1. CLI 集成边界

项目不复制 `lark-cli` 源码，也不依赖用户机器上的全局命令。发布包携带官方 CLI 对应平台的固定版本二进制，服务端通过 `child_process.spawn` 调用绝对路径，并传递参数数组，不经 shell 拼接。

新增 `server/feishu-cli.mjs` 作为唯一适配层，职责包括：

- 解析当前平台对应的内置 CLI 路径；
- 以 JSON 模式执行命令，分离 stdout、stderr 和退出码；
- 对 CLI 输出做结构化解析，禁止把原始 stderr 或 token 返回给 Web；
- 创建和管理授权进程，支持取消、超时和重复点击；
- 包装 `auth status`、`auth login`、`auth qrcode` 和任务清单/任务命令；
- 将 CLI 错误映射为稳定的 Taskboard 错误码和中文提示。

`server/feishu-integration.mjs` 保留任务投影、同步节流和本地数据库映射，只把当前直接请求飞书 OpenAPI 的认证与任务访问替换为 `feishu-cli.mjs` 调用。Web 和数据库中的飞书任务模型保持不变。

### 2. CLI 配置与凭据

Taskboard 为每个本地数据目录使用独立的 CLI 配置根目录，固定为 `<taskboard-data>/lark-cli-home`，并以 `--profile taskboard` 调用 CLI，不读取或覆盖用户全局 `~/.lark-cli` 配置。每次 CLI 子进程都显式传递该 HOME 和 profile，避免用户本机其他 CLI profile 产生串用。

首次发现 Taskboard profile 不存在时，服务端使用 `lark-cli profile add --name taskboard --app-id <app_id> --app-secret-stdin`，通过 stdin 写入发布环境注入的应用配置；不把 Secret 放进 argv、环境日志或进程列表。已有 profile 不重复写入应用配置，直接进入用户授权流程。

`App ID / App Secret` 是 OAuth 应用身份，不由用户登录产生，也不从公开 Git 仓库读取。它们不进入 Web API、HTML、日志或提交历史。开发运行时可从现有 `CODEX_TASKBOARD_FEISHU_APP_ID` 与 `CODEX_TASKBOARD_FEISHU_APP_SECRET` 注入；发行构建由发布环境注入并生成 CLI 初始配置。发行包中不提交明文 Secret 到仓库。

用户令牌由官方 CLI 按其现有策略写入操作系统密钥链。Taskboard 只读取脱敏状态和用户展示信息，不自行解析、复制或持久化 access token/refresh token。

如果发行包需要携带应用配置，必须明确它是桌面客户端可提取的凭据，不能把它当作绝对机密；应用权限应限制为任务集成所需最小范围，并支持在飞书开发者后台轮换或撤销。

### 3. 授权状态机

服务端内存中维护一次当前授权会话：

- `idle`：未发起授权；
- `pending`：已取得 verification URL/device code，等待用户确认；
- `authorized`：CLI 登录完成并通过 `auth status --verify`；
- `failed`：CLI 退出、用户拒绝、device code 过期或输出无效。

授权会话只保存一次性 device code 的哈希、过期时间、启动进程句柄和最近错误。状态接口返回 `state`、`verificationUrl`、二维码内容、用户展示名和错误提示，不返回 device code、token、App Secret 或 CLI 原始输出。

重复点击“接入飞书”时复用当前未过期的 `pending` 会话；已过期或失败后才创建新会话。授权进程在超时、取消、服务关闭和完成后必须回收。

### 4. 本地接口

保留现有本地接口路径，调整返回数据和行为：

- `GET /api/local/feishu-connection`：返回脱敏连接状态和授权会话状态；启动时只读，不发起登录。
- `POST /api/local/feishu-connection/authorize`：用户点击后创建 CLI Device Flow，返回授权 URL、二维码和过期时间。
- `POST /api/local/feishu-connection/cancel`：取消当前等待中的授权进程。
- `GET /api/local/feishu-connection/tasklists`：授权成功后通过 CLI 返回当前用户可访问的任务清单。
- `PUT /api/local/feishu-connection`：保存用户选择的清单并立即同步。
- `POST /api/local/feishu-connection/sync`：通过 CLI 立即同步已选清单。

现有 `/api/local/feishu-connection/callback` 仅用于兼容旧配置迁移时的过渡，不再作为新登录主路径；新授权不依赖浏览器回调地址。

### 5. Web 交互

连接对话框初始只显示连接状态和“接入飞书”按钮。点击后显示：

- 二维码；
- “打开飞书授权页”按钮；
- 授权等待状态和过期倒计时；
- “重新生成二维码”和“取消”操作。

授权成功后自动刷新任务清单。已授权状态显示用户展示名、“重新授权”和“刷新任务清单”，不显示 App ID、App Secret 或本地配置路径。

### 6. 任务能力映射

沿用现有飞书任务投影：

| 飞书字段/命令 | Taskboard 字段 |
| --- | --- |
| task `guid` | `externalId` 和 `FEISHU:<guid>` 标识 |
| `summary` | 标题 |
| `description` | 描述 |
| `due` | 截止日期 |
| `status` / `completed_at` | `todo` 或 `done` |
| tasklist 名称 | 只读来源标签 |
| `url` | 外部链接 |

只同步用户能读取的任务清单。仍不支持在 Taskboard 中创建、删除、改派、移动到本地项目、评论、附件、依赖、优先级和标签回写。

## 打包与版本

`scripts/prepare-tauri-app.mjs` 增加官方 CLI 的固定版本下载和校验，将二进制放入 Tauri resources。至少覆盖现有发行目标：macOS universal（arm64/x64）、Linux x64 和 Windows x64；下载使用官方发行校验文件，构建时校验 SHA-256，并随资源保留 MIT 许可文本和版本清单。

开发模式允许使用本机 CLI 作为明确的调试回退，但生产包不得依赖 PATH 中的 `lark-cli`。构建验证必须确认资源中的 CLI 可执行、版本固定且所有平台名称映射正确。

## 错误处理

- 内置 CLI 缺失或不可执行：显示“当前安装包缺少飞书登录组件”，并记录可诊断错误，不回退到全局命令。
- 应用配置缺失：显示“当前版本未配置飞书应用”，不显示 Secret，不生成空授权链接。
- 用户拒绝授权：保持未连接状态，允许重新发起。
- device code 过期：提示二维码已过期，允许重新生成。
- 权限不足：显示所需任务权限名称，并允许重新授权。
- CLI 返回非 JSON、退出码非零或超时：转换为稳定错误码，日志只保留命令名、退出码和脱敏摘要。

## 验证路径

实现后只验证这条直接路径：启动 Taskboard，确认未授权时不会自动弹出授权；点击“接入飞书”，确认出现二维码和授权链接；完成授权后确认用户身份和任务清单出现；选择一个清单并同步，确认任务投影；修改标题或完成状态，确认飞书端发生对应变化。

此外验证发行资源：每个支持平台都能启动内置 CLI，CLI 版本和 SHA-256 与锁定清单一致，仓库中不存在应用 Secret。

## 外部前提

发布方需要提前创建并配置 Taskboard 专属飞书应用，批准任务读取、任务清单读取、任务写入和离线授权所需权限，并在构建/部署环境注入应用配置。终端用户不需要完成应用初始化，也不需要单独安装 CLI。
