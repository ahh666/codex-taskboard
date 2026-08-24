# 飞书任务清单接入设计

## 目标与边界

在 Codex Taskboard 中接入飞书公开的任务 API。授权用户选择自己可读取的飞书任务清单后，Taskboard 同步这些清单中的全部任务到独立的“飞书任务”项目，并允许用户从面板回写标题、描述、截止日期和完成状态。

本期不是飞书 Project 的工作项集成。公开 API 不提供按飞书 Project 团队或工作项查询的能力，因此不实现项目空间、项目成员、需求类型或项目工作流同步。

不实现成员改派、清单归属、评论、附件、依赖、优先级、标签和 Taskboard 专有状态的回写。飞书任务仅有 `todo` 与 `done`，因此本期只允许这两个 Taskboard 状态用于飞书任务。

## 真实操作路径

1. 用户从项目菜单打开“连接飞书任务”。
2. Taskboard 服务端从 `CODEX_TASKBOARD_FEISHU_APP_ID` 和 `CODEX_TASKBOARD_FEISHU_APP_SECRET` 读取固定的飞书自建应用身份；用户只需在界面确认回调地址，并在飞书开发者后台登记该地址。
3. 用户点击授权，Taskboard 在浏览器打开飞书授权页，请求 `task:task:read`、`task:tasklist:read`、`task:task:write` 和 `offline_access`。
4. 本地回调校验 OAuth `state` 与 PKCE verifier，换取并保存 user/refresh token；随后读取当前用户有权限访问的任务清单。
5. 用户勾选要同步的团队清单并保存。Taskboard 分页读取每一个所选清单的任务摘要，再读取每项完整任务详情，投影为“飞书任务”项目下的外部议题。
6. 用户在议题编辑界面修改支持的字段，Taskboard 先调用飞书任务更新 API，再更新本地投影；用户移动任务到 `todo` 或 `done` 时，Taskboard 分别恢复或完成飞书任务。

## 架构

新增 `server/feishu-config.mjs` 与 `server/feishu-integration.mjs`，职责对应已有 Jira 配置和集成模块，但不复用 Jira Basic Auth 或状态机。

- `feishu-config.mjs`：验证并原子保存 App ID、App Secret、refresh token、token 到期时间和已选清单。配置文件权限固定为 `0600`，响应 API 永不返回 App Secret、access token 或 refresh token。固定应用身份由服务端环境配置提供，已存在的本地配置仍可兼容读取。
- `feishu-integration.mjs`：构造 OAuth 授权地址；保存一次性 `state` 和 PKCE verifier；处理回调并换取/刷新 token；列取可访问清单；对选中清单分页同步任务；将允许的本地变更回写飞书。
- `server/app.mjs`：挂载连接状态、授权开始、OAuth 回调、清单列取、选区保存和立即同步路由；在查询飞书项目任务时触发已有的一分钟同步节流；把飞书外部任务的 PATCH/move 分发给飞书适配器。
- `server/database.mjs`：增加飞书专用项目常量与飞书任务投影操作。飞书任务用稳定 task GUID 作为外部 ID，来源标记为 `feishu`，清单名称作为只读标签，用于辨识团队来源。
- Web：新增飞书连接对话框和 API/types；项目菜单新增入口，飞书项目显示同步按钮。飞书任务不能新建、删除、归档、改派或调整不受支持字段。

## OAuth 与本地接口

固定回调路由为 `GET /api/local/feishu-connection/callback`。任务面板由启动器注入时，授权 URI 使用当前任务面板的本地 origin；用户必须将显示的完整 URI 登记到飞书自建应用的重定向地址中。

本地路由仅在本机 companion 可用时提供：

- `GET /api/local/feishu-connection`：返回脱敏连接状态、授权用户展示名、已选清单和最近同步时间。
- `POST /api/local/feishu-connection/authorize`：使用服务端固定的飞书应用身份，创建 OAuth state 与 PKCE challenge，返回授权 URL。
- `GET /api/local/feishu-connection/callback`：校验回调并完成 token 交换，向浏览器显示成功或失败结果。
- `GET /api/local/feishu-connection/tasklists`：返回当前用户有读取权限的任务清单。
- `PUT /api/local/feishu-connection`：保存已选清单 GUID 并立即同步。
- `POST /api/local/feishu-connection/sync`：立即同步已选清单。

飞书刷新 token 为一次性使用。刷新操作与配置落盘在同一串行操作中完成，避免并发请求复用已消耗的 refresh token。

## 数据映射与同步

| 飞书任务 | Taskboard |
| --- | --- |
| `guid` | `externalId`，以及 `FEISHU:<guid>` 标识符 |
| `summary` | 标题 |
| `description` | 描述 |
| 任务成员中 `role=assignee` | 经办人 |
| `creator` | 创建人 |
| `due` | `YYYY-MM-DD` 截止日期 |
| `completed_at` / `status` | `todo` 或 `done` |
| 所选清单名称 | 只读标签 |
| `url` | 外部链接 |

任务清单列表只返回任务摘要，因此同步会对每个任务调用详情接口取得描述和完整成员。详情接口上限为每秒 10 次，适配器按不超过该上限的节奏串行获取。没有出现在任何已选清单的现有飞书投影会归档；这使修改清单选择结果立即可见。

Taskboard 的截止日期精度只有日。读取飞书的具体时刻时显示其 UTC 日期；用户从 Taskboard 写回截止日期时，以飞书的全天日期写入。标题、描述和完成状态保持一对一回写；`done` 写为当前毫秒时间，其他允许状态仅能恢复为 `todo`（`completed_at: "0"`）。

## 验证

本期完成后按真实路径验证，而不是添加额外回归套件：配置自建应用和回调地址，完成 OAuth，选择一个包含多个任务的清单，确认任务投影与飞书链接可见，然后分别修改标题、描述、截止日期并完成/恢复任务，确认飞书端同步变化。

## 外部前提

飞书自建应用必须已启用并向授权用户可用，且管理员在开发者后台批准 `task:task:read`、`task:tasklist:read`、`task:task:write` 和 `offline_access`。用户对每个被选清单必须有读取权限；回写还取决于用户对对应任务的编辑权限。
