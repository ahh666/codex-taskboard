# 飞书任务清单接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入 OAuth、团队任务清单同步和允许字段回写。

**Architecture:** 新增独立飞书配置和适配器，扩展现有外部任务投影，前端提供连接和清单选择界面。

**Tech Stack:** Node.js ESM、SQLite、React、TypeScript、飞书 OAuth 2.0、Task v2 API。

**Spec:** `docs/superpowers/specs/2026-08-21-feishu-task-integration-design.md`

## Global Constraints

- 仅接入公开的飞书 Task v2 API。
- 授权范围固定为 `task:task:read`、`task:tasklist:read`、`task:task:write`、`offline_access`。
- 凭据文件为 `0600`，任何 API 响应都不返回密钥或令牌。
- 只同步已选清单的全部任务，仅回写标题、描述、截止日期及 `todo`/`done`。
- 本期直接验证主路径，不扩展成员、评论、附件或飞书 Project 工作项。

---

### Task 1: 飞书配置和服务端适配器

**Files:**

- Create: `server/feishu-config.mjs`
- Create: `server/feishu-integration.mjs`
- Modify: `shared/domain.mjs`

- [ ] 实现原子 `0600` 配置存储，保存 App ID、App Secret、访问/刷新令牌、到期时间、用户展示名和选中清单。
- [ ] 实现 PKCE OAuth 授权 URL、回调换令牌、一次性 refresh token 串行刷新和脱敏状态接口。
- [ ] 实现清单和任务分页读取、每项任务详情读取、`todo`/`done` 映射以及 PATCH 回写。
- [ ] 使用 `FEISHU_PROJECT_ID = "feishu-tasks"` 和外部来源 `feishu` 识别稳定投影。
- [ ] 运行 `node --check server/feishu-config.mjs` 与 `node --check server/feishu-integration.mjs`，提交服务端适配器。

### Task 2: 任务投影和本地 API

**Files:**

- Modify: `server/database.mjs`
- Modify: `server/app.mjs`

- [ ] 增加 `syncFeishuTasks()`，以飞书 GUID 做外部 ID，同步标题、描述、经办人、创建人、截止日期、完成状态、清单名称标签和链接；归档退出选中范围的任务。
- [ ] 注册飞书配置和集成服务，支持独立的 `feishu-connection.json` 和可注入 fetch/config store。
- [ ] 添加连接状态、OAuth 开始、回调、可读清单、清单保存、手动同步路由；回调 URI 使用当前本地服务 host 和实例路由前缀。
- [ ] 让 GET 任务查询同步飞书项目；将飞书任务的 PATCH 和 move 分发至适配器；拒绝不支持的创建、删除、归档、改派、标签、优先级和状态操作。
- [ ] 运行 `node --check server/database.mjs` 与 `node --check server/app.mjs`，提交本地 API 和投影改动。

### Task 3: 面板连接与外部任务体验

**Files:**

- Create: `web/src/components/FeishuConnectionDialog.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`

- [ ] 定义 `FeishuConnection`、`FeishuTasklist` 和 API 客户端请求。
- [ ] 实现两阶段对话框：使用服务端固定应用身份打开授权页；授权完成后勾选可访问的团队清单并保存同步。
- [ ] 项目菜单添加“连接飞书任务”；飞书项目显示同步按钮；统一处理 Jira 和飞书的外部项目限制。
- [ ] 飞书项目只显示 `todo` 和 `done` 看板列，隐藏/禁用外部不支持的创建、属性编辑、删除、归档和开发工作流。
- [ ] 运行 `npm run typecheck` 与 `npm run build:web`，提交前端改动。

### Task 4: 主路径验证与文档

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] 记录自建应用 OAuth 回调配置及四项权限。
- [ ] 构建并启动本地面板；完成 OAuth，选择包含多人任务的共享清单。
- [ ] 确认队友负责的任务和飞书链接在“飞书任务”项目可见；在 Taskboard 修改标题、描述、截止日期、完成状态，并确认飞书端变化。
- [ ] 提交文档和验证结果，并将 head SHA、验证证据和限制写入 `COD-3`。
