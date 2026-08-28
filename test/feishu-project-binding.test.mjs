import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { createFeishuCli } from "../server/feishu-cli.mjs";
import { createFeishuIntegration } from "../server/feishu-integration.mjs";

test("Feishu view save syncs tasks into the requested project", async () => {
  const syncCalls = [];
  let savedConfig = null;
  const integration = createFeishuIntegration({
    configStore: {
      async read() {
        return { version: 4, projects: {} };
      },
      async save(config) {
        savedConfig = config;
        return config;
      },
    },
    database: {
      syncFeishuTasks(tasks, options) {
        syncCalls.push({ tasks, options });
      },
    },
    cli: {
      async status() {
        return { authorized: true, cliAvailable: true, displayName: "Tester" };
      },
      async decodeViewUrl() {
        return {
          url: "https://project.feishu.cn/space/storyView/view-1",
          host: "project.feishu.cn",
          simpleName: "space",
          viewId: "view-1",
          workItemType: "story",
        };
      },
      async listViewWorkItems() {
        return [{ id: "work-item-1", name: "Requirement" }];
      },
    },
  });

  const connection = await integration.saveView(
    "https://project.feishu.cn/space/storyView/view-1",
    { projectId: "pc" },
  );

  assert.equal(syncCalls[0].options.projectId, "pc");
  assert.equal(connection.projectId, "pc");
  assert.equal(savedConfig.projects.pc.url, "https://project.feishu.cn/space/storyView/view-1");
});

test("Feishu detail fields and document links are preserved in the synced description", async () => {
  const syncCalls = [];
  const integration = createFeishuIntegration({
    configStore: {
      async read() {
        return { version: 4, projects: {} };
      },
      async save(config) {
        return config;
      },
    },
    database: {
      syncFeishuTasks(tasks) {
        syncCalls.push(tasks);
      },
    },
    cli: {
      async status() {
        return { authorized: true, cliAvailable: true, displayName: "Tester" };
      },
      async decodeViewUrl() {
        return {
          url: "https://project.feishu.cn/space/storyView/view-1",
          host: "project.feishu.cn",
          simpleName: "space",
          viewId: "view-1",
          workItemType: "story",
        };
      },
      async listViewWorkItems() {
        return [{
          work_item_attribute: {
            work_item_id: "work-item-2",
            work_item_name: "Requirement with details",
          },
          work_item_fields: [
            { key: "requirement_background", name: "需求背景", value: "统一详情数据" },
            { key: "requirement_detail", name: "需求详述", value: { content: "同步正文" } },
            { key: "performance_requirement", name: "性能要求", value: "P99 < 200ms" },
            {
              key: "requirement_document",
              name: "需求文档",
              value: [{ name: "需求说明", url: "https://docs.example.test/requirement" }],
            },
            {
              key: "test_report",
              name: "测试报告",
              value: [{ name: "测试报告.xlsx", url: "https://files.example.test/report.xlsx" }],
            },
          ],
        }];
      },
    },
  });

  await integration.saveView(
    "https://project.feishu.cn/space/storyView/view-1",
    { projectId: "pc" },
  );

  assert.equal(
    syncCalls[0][0].description,
    "## 需求背景\n\n统一详情数据\n\n## 需求详述\n\n同步正文\n\n## 性能要求\n\nP99 < 200ms\n\n## 需求文档\n\n- [需求说明](https://docs.example.test/requirement)\n\n## 测试报告\n\n- [测试报告.xlsx](https://files.example.test/report.xlsx)",
  );
});

test("Feishu view detail reads all fields so document and attachment values are available", async () => {
  const calls = [];
  const spawn = (_executable, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      const isView = args.includes("view");
      child.stdout.end(JSON.stringify(isView
        ? { results: [{ work_item_id: "work-item-3" }] }
        : {
          results: [{
            data: {
              work_item_attribute: { work_item_id: "work-item-3" },
              work_item_fields: [{ key: "wiki", name: "需求文档(MRD)", value: "https://docs.example.test/mrd" }],
            },
          }],
        }));
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const cli = createFeishuCli({
    executablePath: "/tmp/meegle",
    dataDirectory: "/tmp/codex-taskboard-cod-6",
    spawn,
  });

  const items = await cli.listViewWorkItems({
    simpleName: "space",
    viewId: "view-1",
  });

  assert.equal(items[0].work_item_fields[0].key, "wiki");
  const detailArgs = calls.find((args) => args.includes("workitem"));
  const fieldsIndex = detailArgs.indexOf("--fields");
  assert.deepEqual(detailArgs.slice(fieldsIndex, fieldsIndex + 4), [
    "--fields",
    "_all",
    "--params",
    JSON.stringify({ page_size: 200 }),
  ]);
  await cli.close();
});
