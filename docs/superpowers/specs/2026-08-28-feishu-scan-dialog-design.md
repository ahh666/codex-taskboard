# 飞书扫码授权与弹窗重设计

## 背景

COD-5 要求飞书需求接入支持扫码登录，并重新设计授权弹窗。仓库已经有完整的飞书 Device Code 授权链路，但授权初始化只返回 `verification_uri_complete`，`authorizationQrCode` 字段一直为 `null`；现有 `FeishuConnectionDialog` 复用删除/创建弹窗样式，左侧步骤栏在窄屏会形成大面积空白，二维码不是弹窗内的主路径。

## 已确认的真实操作路径

```text
项目菜单或看板的“接入飞书需求”
  -> App.tsx 的 openFeishuDialog 打开 FeishuConnectionDialog
  -> 用户点击“接入飞书”
  -> App.tsx authorizeFeishu 调用 api.ts startFeishuAuthorization
  -> POST /api/local/feishu-connection/authorize
  -> server/app.mjs 路由调用 feishu-integration.startAuthorization
  -> feishu-cli.mjs 执行 meegle auth login --device-code --phase init
  -> 生成二维码并返回授权 URL、二维码 data URL、过期时间
  -> 用户使用飞书移动端扫码，meegle poll 进程持续运行
  -> App.tsx 每秒 GET /api/local/feishu-connection
  -> 授权完成后弹窗切换到“选择视图”步骤
  -> 用户提交需求视图 URL
  -> PUT /api/local/feishu-connection
  -> feishu-integration.syncWithView 写入飞书需求
  -> 当前项目刷新并显示同步后的需求
```

## 目标

1. 在 Taskboard 弹窗内直接展示真实的飞书 Device Code 二维码。
2. 保留“打开授权页”作为无法扫码时的备用路径。
3. 授权完成后在同一弹窗内从“扫码授权”切换到“选择视图”，不重新打开或丢失上下文。
4. 用白色主体、顶部水平进度和紧凑双栏内容替换大面积灰色左侧步骤栏。
5. 维持现有 API、配置文件、授权轮询、视图同步和多语言文本能力。

## 非目标

- 不替换 Meegle Device Code 协议，不实现新的 OAuth 服务端回调。
- 不把令牌、二维码或授权 URL 写入 `feishu-connection.json`。
- 不修改飞书需求同步的数据模型、字段映射或项目绑定规则。
- 不改动 Jira 弹窗或其他 Taskboard 弹窗。
- 不在用户确认直接主路径工作前新增与本需求无关的防御逻辑或回归测试。

## 设计方案

### 服务端二维码

在 `server/feishu-cli.mjs` 的 `startAuthorization()` 中复用已获取的 `verification_uri_complete`，调用 `qrcode` Node API 生成 PNG data URL。生成结果只保存在当前 CLI 实例的内存授权状态 `authorization.public.authorizationQrCode` 中，并随现有 `connectionStatus()` 返回；授权取消、完成、失败或过期时随当前授权状态一起清理。

生成配置使用短期授权链接作为输入，二维码输出为 `data:image/png;base64,...`。如果二维码生成失败，授权初始化整体失败并沿用现有 CLI 错误映射；前端仍可在已有授权 URL 可用时显示“打开授权页”备用动作。

`normalizeAuthorization()` 的输入输出仍只包含授权初始化所需的 URL、device code、client id、轮询间隔和有效期；二维码生成属于 public response 组装，不改变 Meegle 返回格式。

### API 与状态

`POST /api/local/feishu-connection/authorize`、`GET /api/local/feishu-connection` 和取消/同步路由保持现有路径和请求格式。`FeishuConnection.authorizationQrCode` 字段继续作为前后端契约，授权初始化和轮询状态均可携带它。

状态映射保持现有四种值：

- `idle`：未开始授权，显示生成二维码主动作。
- `pending`：已生成二维码，显示二维码、过期时间、授权 URL 备用动作和取消/刷新动作。
- `authorized`：轮询发现授权成功，显示账号并进入视图 URL 配置。
- `failed`：授权进程或 CLI 出错，在当前步骤显示错误和重试动作。

### 弹窗结构

`web/src/components/FeishuConnectionDialog.tsx` 继续负责单一弹窗和表单提交，但改成以下结构：

```text
┌────────────────────────────────────────────────────────┐
│ 飞书标识  接入飞书需求                         关闭     │
│           授权账号并选择需要同步的需求视图              │
├────────────────────────────────────────────────────────┤
│  ① 扫码授权 ─────────────────────────────── ② 选择视图 │
├──────────────────────┬─────────────────────────────────┤
│ 浅蓝二维码区          │ 当前步骤说明                     │
│                      │ 状态 / 过期时间 / 备用授权链接    │
│      QR              │ 或：已授权账号 / 视图 URL 输入框  │
├──────────────────────┴─────────────────────────────────┤
│ Taskboard · 飞书项目                 取消  次要动作  主动作 │
└────────────────────────────────────────────────────────┘
```

未授权状态的主内容是二维码和“使用飞书移动端扫码”；底部只显示取消和刷新二维码，保存按钮不出现。已授权状态隐藏二维码区内容、将第一步标记为完成并高亮第二步，右侧显示成功账号、需求视图 URL 和“保存并同步”。“重新登录授权”复用次要动作位置。

样式写入 `web/src/styles.css` 的飞书弹窗专属选择器，复用现有主题变量、按钮基础类和 focus 样式，不改变全局删除/创建弹窗规则。桌面宽度约 620px；宽度小于 560px 时双栏堆叠，步骤进度保留在顶部，底部按钮允许换行；390px 宽度下不得产生水平滚动。

### App 交互

`web/src/App.tsx` 保留现有授权函数和轮询函数，只移除授权时强制打开空白 popup 的主路径：二维码在弹窗中直接显示，授权 URL 仍由显式链接打开。授权轮询发现 `authorized` 后更新连接状态和公告，组件根据状态自动切换步骤。刷新二维码调用现有 `startFeishuAuthorization`，取消调用现有 `cancelFeishuAuthorization`。

## 错误与边界

- CLI 不可用：弹窗显示现有错误文案，不渲染二维码，授权主动作禁用。
- 二维码生成失败：显示错误文案和刷新动作；不持久化半成品二维码。
- 授权过期：保留当前弹窗，显示“授权已超时”和刷新二维码动作。
- 用户选择“打开授权页”：打开 `authorizationUrl`，不改变轮询和弹窗步骤。
- 视图 URL 保存/同步失败：留在第二步，保留输入内容和错误信息。
- 用户取消授权：停止现有轮询进程并回到 `idle`，不改动已保存的视图配置。

## 验证标准

实现完成后只验证这条直接路径：

1. 从看板打开飞书接入弹窗，确认白底顶部进度和二维码区域可见。
2. 点击授权并确认接口返回真实二维码 data URL；二维码视觉上可被扫码设备识别。
3. 完成一次扫码后确认弹窗自动进入“选择视图”，显示授权账号。
4. 输入一个真实需求视图 URL，保存并确认当前项目出现同步成功提示和飞书需求。
5. 在 390px 窄屏检查步骤、二维码、表单和底部按钮无溢出。

按项目规则，以上直接路径得到用户确认前不扩展为通用兼容矩阵或额外回归测试。

## 变更文件边界

- `server/feishu-cli.mjs`：生成二维码并把短期二维码放入现有 public 授权状态。
- `package.json`、`package-lock.json`：增加二维码生成运行时依赖。
- `web/src/components/FeishuConnectionDialog.tsx`：重排授权/视图两个状态的弹窗结构。
- `web/src/App.tsx`：保留轮询状态流，调整授权窗口主路径和状态切换所需的最小交互。
- `web/src/styles.css`：新增飞书弹窗白底、进度、二维码区、双栏和窄屏样式。

