# 飞书扫码授权与弹窗重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Taskboard 飞书接入弹窗内展示真实 Device Code 二维码，并用白底顶部进度与响应式双栏布局替换现有灰色步骤栏。

**Architecture:** 保留现有 Meegle Device Code 初始化、轮询、连接状态 API 和视图同步链路，只在 `feishu-cli.mjs` 将授权 URL 转为内存 PNG data URL，并让现有 `authorizationQrCode` 契约承载它。前端移除授权时强制打开外部空白窗口，让 `FeishuConnectionDialog` 按 `idle`、`pending`、`authorized` 状态呈现同一弹窗中的两个步骤。

**Tech Stack:** Node.js 22 ESM、`qrcode` 1.5.4、React 19、TypeScript、Vite、现有 CSS 主题变量、Taskboard Codex Injector

**Spec:** `docs/superpowers/specs/2026-08-28-feishu-scan-dialog-design.md`

## Global Constraints

- 保持 `POST /api/local/feishu-connection/authorize`、`GET /api/local/feishu-connection`、取消授权和保存视图 API 的路径与请求格式不变。
- 二维码只存在于当前 CLI 实例的内存授权状态中，不写入 `feishu-connection.json`。
- 保留显式“打开授权页”作为扫码失败时的备用动作，不在点击授权时自动打开新窗口。
- 不修改 Jira 弹窗、飞书需求同步模型、字段映射、项目绑定或 Meegle Device Code 协议。
- 桌面弹窗宽度约 620px；小于 560px 时双栏堆叠；390px 宽度下不得出现水平滚动。
- 根据项目交付规则，用户确认前不新增防御性扩展、兼容层或回归测试；本轮只验证二维码生成、弹窗 UI 和 Taskboard 注入刷新。
- 所有代码和依赖修改都发生在 `codex/cod-5-feishu-dialog` worktree，不直接修改 `main`。

---

### Task 1: 生成授权二维码

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/feishu-cli.mjs`

**Interfaces:**
- Consumes: `normalizeAuthorization(payload)` 返回的 `authorizationUrl: string` 与 `expiresAt: string`。
- Produces: `startAuthorization(): Promise<{ state: "pending"; authorizationUrl: string; authorizationQrCode: string; authorizationExpiresAt: string }>`；其中二维码为 `data:image/png;base64,...`。

- [ ] **Step 1: 安装运行时依赖**

Run:

```bash
npm install qrcode@1.5.4 --save
```

Expected: `package.json` 增加精确版本 `qrcode: "1.5.4"`，锁文件只包含该依赖及其传递依赖变化。

- [ ] **Step 2: 在授权初始化中生成二维码**

在 `server/feishu-cli.mjs` 顶部导入二维码库：

```js
import QRCode from "qrcode";
```

在 `startAuthorization()` 获取 `normalized` 后生成二维码，并放入现有 public response：

```js
const authorizationQrCode = await QRCode.toDataURL(normalized.authorizationUrl, {
  errorCorrectionLevel: "M",
  margin: 2,
  width: 320,
});
const publicAuthorization = {
  state: "pending",
  authorizationUrl: normalized.authorizationUrl,
  authorizationQrCode,
  authorizationExpiresAt: normalized.expiresAt,
};
```

- [ ] **Step 3: 用模拟 CLI 探针验证二维码契约**

Run:

```bash
node --input-type=module <<'NODE'
import { EventEmitter } from "node:events";
import { createFeishuCli } from "./server/feishu-cli.mjs";

let callCount = 0;
function spawn() {
  callCount += 1;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => child.emit("close", null, "SIGTERM");
  if (callCount === 1) {
    queueMicrotask(() => {
      child.stdout.emit("data", JSON.stringify({
        verification_uri_complete: "https://project.feishu.cn/auth/device?code=COD5",
        device_code: "COD5",
        client_id: "taskboard",
        interval: 5,
        expires_in: 1800
      }));
      child.emit("close", 0, null);
    });
  }
  return child;
}

const cli = createFeishuCli({
  executablePath: "/tmp/meegle",
  dataDirectory: "/tmp/cod-5-qr-probe",
  spawn
});
const result = await cli.startAuthorization();
if (!result.authorizationQrCode?.startsWith("data:image/png;base64,")) {
  throw new Error("二维码不是 PNG data URL");
}
console.log(result.state, result.authorizationQrCode.slice(0, 22));
await cli.close();
NODE
```

Expected: 输出 `pending data:image/png;base64,` 并以退出码 0 结束。

### Task 2: 重排弹窗状态与交互

**Files:**
- Modify: `web/src/components/FeishuConnectionDialog.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `FeishuConnection.authorizationState`、`authorized`、`authorizationQrCode`、`authorizationUrl`、`authorizationExpiresAt`、`displayName` 和 `viewUrl`。
- Produces: 同一 `FeishuConnectionDialog` 中的扫码步骤与选择视图步骤；`authorizeFeishu()` 只启动授权并轮询，不自动打开外部窗口。

- [ ] **Step 1: 移除强制授权窗口**

将 `web/src/App.tsx` 的 `authorizeFeishu()` 收窄为启动授权、更新连接状态和开始轮询：

```tsx
async function authorizeFeishu() {
  if (feishuSaving) return;
  setFeishuSaving(true);
  setFeishuError(null);
  try {
    const authorization = await startFeishuAuthorization(selectedProjectId);
    setFeishuConnection(authorization);
    setAnnouncement(text("请使用飞书移动端扫描二维码完成授权", "Scan the QR code with Feishu to authorize"));
    void pollFeishuAuthorization();
  } catch (error) {
    setFeishuError(errorMessage(error));
  } finally {
    setFeishuSaving(false);
  }
}
```

- [ ] **Step 2: 构建弹窗标题和顶部进度**

在 `FeishuConnectionDialog.tsx` 引入现有图标组件：

```tsx
import { LinearIcon } from "./LinearIcon";
```

使用 `feishu-dialog-header`、`feishu-dialog-progress` 和两个 `feishu-dialog-step` 节点呈现标题、关闭按钮、已完成状态与当前状态；关闭按钮使用 `LinearIcon name="close"` 并保留 `aria-label`。

- [ ] **Step 3: 构建扫码步骤**

当 `authorized === false` 时渲染 `feishu-dialog-main` 双栏。左栏在 `pending && authorizationQrCode` 时显示：

```tsx
<img
  className="feishu-qr-code"
  src={connection.authorizationQrCode}
  alt={text("飞书授权二维码", "Feishu authorization QR code")}
/>
```

右栏显示授权状态、过期时间、显式备用链接、错误和主动作。备用链接必须带 `target="_blank" rel="noreferrer"` 和 `LinearIcon name="openExternal"`。`idle` 或 `failed` 状态显示“生成授权二维码”，`pending` 状态显示“刷新二维码”和“取消授权”。

- [ ] **Step 4: 构建选择视图步骤**

当 `authorized === true` 时将第一步标记为完成、第二步标记为当前，在正文显示授权账号、`viewUrl` 输入框和“重新登录授权”；底部主按钮提交 `onSaveView(viewUrl.trim())`。保持现有表单状态同步和 `saving` 禁用逻辑。

- [ ] **Step 5: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: TypeScript 退出码 0，无未使用导入、属性或 JSX 类型错误。

### Task 3: 实现白底响应式视觉系统

**Files:**
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: Task 2 的 `feishu-dialog-*`、`feishu-qr-*` 与 `feishu-connection-*` class names。
- Produces: 620px 桌面双栏弹窗、560px 以下单栏、390px 无横向溢出，并复用现有主题变量和按钮样式。

- [ ] **Step 1: 替换旧飞书专属样式**

删除文件末尾旧的 440px 弹窗、居中授权块和通用 action 样式，增加以下视觉结构：

```css
.feishu-connection-dialog { width: min(620px, 100%); padding: 0; overflow: hidden; }
.feishu-dialog-header { display: flex; align-items: flex-start; gap: 12px; padding: 20px 22px 16px; }
.feishu-dialog-progress { display: grid; grid-template-columns: auto minmax(48px, 1fr) auto; align-items: center; padding: 14px 22px; border-block: var(--border-hairline) solid var(--border); }
.feishu-dialog-main { display: grid; grid-template-columns: minmax(220px, .9fr) minmax(0, 1.1fr); min-height: 286px; }
.feishu-qr-panel { display: grid; place-items: center; padding: 28px; background: var(--accent-soft); }
.feishu-dialog-details { min-width: 0; padding: 28px; }
.feishu-qr-code { width: min(210px, 100%); aspect-ratio: 1; object-fit: contain; border-radius: 6px; background: #fff; }
```

补齐标题、Feishu 标识、步骤圆点与连线、状态点、成功状态、字段、显式链接、底部按钮和 focus-visible 样式。所有卡片圆角不超过 8px，不使用渐变或灰色侧栏。

- [ ] **Step 2: 增加窄屏布局**

加入以下响应式边界并补齐内部间距：

```css
@media (max-width: 560px) {
  .feishu-dialog-main { grid-template-columns: minmax(0, 1fr); }
  .feishu-qr-panel { padding: 20px; }
  .feishu-dialog-details { padding: 22px; }
  .feishu-dialog-footer { flex-wrap: wrap; }
}

@media (max-width: 390px) {
  .feishu-connection-dialog { width: 100%; }
  .feishu-dialog-header,
  .feishu-dialog-progress,
  .feishu-dialog-details,
  .feishu-dialog-footer { padding-inline: 16px; }
}
```

- [ ] **Step 3: 构建生产前端**

Run:

```bash
npm run build:web
```

Expected: Vite 构建退出码 0，输出包含更新后的 Taskboard 前端资源。

### Task 4: 注入 Taskboard 并验证 UI 与二维码

**Files:**
- Verify: `.data/launcher-runtime.json`
- Verify: Taskboard Codex App surface

**Interfaces:**
- Consumes: worktree 构建输出、当前活跃 Taskboard runtime、COD-5 所属项目弹窗入口。
- Produces: 已刷新到最新 worktree 前端的 Taskboard 面板，以及可供用户验收的 UI/二维码直接证据。

- [ ] **Step 1: 确认注入脚本不会替换共享运行时**

Run:

```bash
node scripts/codex-injector.mjs --help
```

并阅读 `scripts/codex-injector.mjs` 中 `--refresh` / `--refresh-if-running` 的运行时解析路径。只有确认它刷新当前 Codex Webview 而不停止或覆盖 `.data/launcher-runtime.json` 后继续。

- [ ] **Step 2: 注入并刷新当前任务面板**

Run:

```bash
npm run build
```

Expected: Vite 构建成功，注入器报告已刷新正在运行的 Codex Taskboard；现有 runtime PID、URL 和描述文件保持不变。

- [ ] **Step 3: 在真实 Taskboard 表面检查扫码弹窗**

从项目菜单打开“接入飞书需求”，只检查：

```text
白底标题 -> 顶部水平步骤 -> 二维码主区域 -> 状态/过期时间 -> 授权页备用链接 -> 底部动作
```

确认二维码 `<img>` 的 `src` 以 `data:image/png;base64,` 开头，桌面布局没有灰色左侧空白，390px 视口下没有水平滚动、文字和按钮重叠。

- [ ] **Step 4: 记录精确结果并提交代码**

Run:

```bash
git diff --check
git status --short
git add package.json package-lock.json server/feishu-cli.mjs web/src/App.tsx web/src/components/FeishuConnectionDialog.tsx web/src/styles.css docs/superpowers/plans/2026-08-28-feishu-scan-dialog.md
git commit -m "feat(feishu): 支持扫码授权并重设计接入弹窗" -m "- 使用 Device Code 授权链接生成内存二维码 data URL
- 移除强制授权弹窗并保留显式授权页入口
- 重排白底顶部进度、响应式二维码和视图配置布局
- 增加二维码运行时依赖并记录直接验证流程"
```

Expected: 提交成功，工作区干净；随后把 COD-5 保持在 `in_progress` 并记录精确 commit、二维码探针、构建、注入和 UI 验证结果，等待用户确认后再进入评审流程。
