# 飞书需求入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在议题看板工具栏实现“接入飞书需求 / 同步飞书需求”双状态入口，并让已接入状态直接同步而不进入授权流程。

**Architecture:** 复用 `App.tsx` 已加载的 `FeishuConnection` 状态和现有 `openFeishuDialog`、`syncFeishuNow` 两条动作路径，只在议题看板工具区新增状态按钮。样式写入现有全局样式表，使用当前主题变量，并在窄屏收缩为图标按钮。

**Tech Stack:** React 19、TypeScript、CSS、现有 Taskboard HTTP API

---

### Task 1: 实现飞书需求入口状态与动作

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 定义当前入口文案**

在项目来源派生状态附近增加：

```tsx
const feishuRequirementsConnected = feishuConnection?.configured === true
  && feishuConnection.authorized === true;
const feishuRequirementsActionLabel = feishuSyncing
  ? text("同步中…", "Syncing…")
  : feishuRequirementsConnected
    ? text("同步飞书需求", "Sync Feishu requirements")
    : text("接入飞书需求", "Connect Feishu requirements");
```

- [ ] **Step 2: 避免议题看板出现两个同步入口**

将标题栏现有入口条件从：

```tsx
{isFeishuProject && (
```

改为：

```tsx
{isFeishuProject && (boardView !== "issues" || detailTask) && (
```

- [ ] **Step 3: 在搜索控件前增加双状态入口**

```tsx
{boardView === "issues" && (
  <button
    className={`feishu-requirements-action${feishuSyncing ? " is-syncing" : ""}`}
    type="button"
    disabled={feishuSyncing}
    onClick={() => {
      if (feishuRequirementsConnected) void syncFeishuNow();
      else openFeishuDialog();
    }}
    aria-label={feishuRequirementsActionLabel}
    title={feishuRequirementsActionLabel}
  >
    {feishuRequirementsConnected
      ? <RefreshIcon color="currentColor" size={14} />
      : <RelationIcon color="currentColor" size={14} />}
    <span>{feishuRequirementsActionLabel}</span>
  </button>
)}
```

- [ ] **Step 4: 运行类型检查**

Run: `npm run typecheck`

Expected: TypeScript exits with code 0.

### Task 2: 实现已确认的视觉与响应式表现

**Files:**
- Modify: `web/src/styles.css`

- [ ] **Step 1: 增加桌面按钮样式**

```css
.feishu-requirements-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  height: 28px;
  gap: 5px;
  padding: 0 9px;
  border: var(--border-hairline) solid color-mix(in srgb, var(--accent) 34%, var(--border));
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}

.feishu-requirements-action:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border-strong));
  background: color-mix(in srgb, var(--accent-soft) 82%, var(--surface-hover));
}

.feishu-requirements-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.feishu-requirements-action:disabled {
  cursor: default;
  opacity: 0.72;
}

.feishu-requirements-action svg {
  width: 14px;
  height: 14px;
}

.feishu-requirements-action.is-syncing svg {
  animation: feishu-requirements-spin 0.8s linear infinite;
}

@keyframes feishu-requirements-spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 2: 增加窄屏收缩规则**

在现有 `@media (max-width: 719px)` 内增加：

```css
.feishu-requirements-action {
  width: 28px;
  padding: 0;
}

.feishu-requirements-action > span {
  display: none;
}
```

- [ ] **Step 3: 运行 Web 构建**

Run: `npm run build:web`

Expected: Vite production build exits with code 0.

### Task 3: 验证真实 UI 路径并提交

**Files:**
- Verify: `web/src/App.tsx`
- Verify: `web/src/styles.css`

- [ ] **Step 1: 在真实 Web 界面验证未接入状态**

打开议题看板，确认入口位于搜索前，文案为“接入飞书需求”；点击后出现现有飞书接入弹窗。

- [ ] **Step 2: 在真实 Web 界面验证已接入状态**

确认入口文案为“同步飞书需求”；点击后按钮显示“同步中…”，直接触发同步请求且不打开授权弹窗，完成后出现“飞书需求已同步”。

- [ ] **Step 3: 验证桌面与窄屏布局**

在桌面与 360px 宽度检查按钮、视图标签、搜索和筛选入口，无重叠、溢出或不可见操作。

- [ ] **Step 4: 检查最终差异并提交**

Run: `git diff --check && git status --short`

Expected: 无空白错误，只有规格、计划、`web/src/App.tsx` 与 `web/src/styles.css` 属于本次改动。

```bash
git add docs/superpowers web/src/App.tsx web/src/styles.css
git commit -m "feat(feishu): 新增飞书需求快捷入口" \
  -m "- 在议题看板工具栏展示接入或同步飞书需求动作" \
  -m "- 已接入状态直接拉取最新需求并展示同步状态" \
  -m "- 补充桌面与窄屏响应式样式"
```

本次按项目规则不新增回归测试；在用户确认直接路径后，如用户明确要求，再补充针对性保护或测试。
