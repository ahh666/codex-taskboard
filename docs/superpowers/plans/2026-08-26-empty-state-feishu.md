# 无议题状态与飞书入口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有项目空状态中保留任务状态导入逻辑，并新增“接入飞书需求”入口与重新设计后的三入口布局。

**Architecture:** 继续由 `App.tsx` 的项目空状态分支承载入口，不新增数据层或状态机。三个入口分别复用现有的 Codex 对话导入回调、议题编辑器打开逻辑和 `openFeishuDialog`；`styles.css` 只负责卡片布局、层级、响应式和主题适配。飞书授权、视图保存和同步仍由现有 `FeishuConnectionDialog` 与 API 链路处理。

**Tech Stack:** React 19、TypeScript、现有 Taskboard CSS 变量与 SemanticIcons、Vite。

---

### Task 1: 扩展项目空状态结构

**Files:**
- Modify: `web/src/App.tsx:3770-3805`

- [ ] 保留“导入当前项目任务状态”按钮的现有 `setAiOpenThreadRequest` 回调与双语文案。
- [ ] 将现有 `.page-empty-actions` 替换为三张 `button` 卡片，顺序固定为导入任务状态、添加议题、接入飞书需求。
- [ ] 为卡片加入现有 `PlusIcon`、`RefreshIcon`、`RelationIcon`，并让第三张卡片调用 `openFeishuDialog`。
- [ ] 保持所有入口使用 `text()` 国际化，并补充 `aria-label` 以便键盘和辅助技术识别。

### Task 2: 实现空状态视觉层级

**Files:**
- Modify: `web/src/styles.css:5291-5330`

- [ ] 将空状态容器调整为居中的窄内容列，保留现有页面伸缩行为。
- [ ] 为标题、说明和入口卡片建立清晰层级；首卡使用主色强调，创建议题保持中性，飞书卡片使用冷蓝色外部来源强调。
- [ ] 让卡片具备悬停、聚焦、按下和暗色主题状态，避免改变全局 `.button` 样式。
- [ ] 在小屏下将三列卡片堆叠为单列，并保证按钮宽度与文字可读性。

### Task 3: 聚焦验证

**Files:**
- Test path: `web/src/App.tsx` + `web/src/styles.css`

- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `node --test test/project-home.test.mjs`。
- [ ] 启动 worktree 的 Web 预览，验证空项目页可见三张卡片。
- [ ] 点击三张卡片，分别确认导入动作进入 Codex 对话请求、添加议题打开编辑器、飞书入口打开现有接入对话框。

