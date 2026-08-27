import assert from "node:assert/strict";
import { test } from "node:test";

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
