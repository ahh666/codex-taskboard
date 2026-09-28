import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import {
  buildTaskboardAutomationSpec,
  reconcileTaskboardAutomation,
  taskboardAutomationHasPendingWork,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const policySource = source.slice(
  source.indexOf("function usesLegacyRemoteAutomation"),
  source.indexOf("function storedAutomationPolicy"),
);
const request = {
  taskboardProjectId: "preview", codexProjectId: "preview", codexProjectKind: "local",
  codexHostId: "local", workspacePath: "/preview", projectName: "Preview",
  skillPath: "/preview/skills/manage-taskboard/SKILL.md", codexProjects: [],
  automationId: "preview-cron", enabledByUser: true, quotaAware: false,
  intervalMinutes: 5, model: "test-model", reasoningEffort: "high",
};

function host() {
  const tasks = [{
    id: "waiting", projectId: "preview", version: 1, title: "Waiting task",
    description: "Wait for approval", status: "todo", archivedAt: null,
    threadId: null, threadBinding: null, relations: { blockedBy: [] },
  }];
  const comments = [{ id: "comment", version: 1, body: "Do not start yet" }];
  const calls = [];
  let decisions = 0;
  let allowed = false;
  let item = { ...buildTaskboardAutomationSpec(request), id: request.automationId, status: "ACTIVE" };
  const record = { request, version: 1 };
  const records = new Map([[request.taskboardProjectId, record]]);
  const api = vm.runInNewContext(`(() => {
    ${policySource}
    return { applyTaskboardAutomationPolicy, evaluateLocalAutomationTodos };
  })()`, {
    createHash, taskboardAutomationHasPendingWork, taskboardAutomationPolicyOperation,
    reconcileTaskboardAutomation, taskboardBaseUrl: "http://preview.test",
    quotaPolicyRecords: records,
    fetch: async (url) => {
      const status = new URL(url).searchParams.get("status");
      return { ok: true, json: async () => ({ tasks: tasks.filter((task) => task.status === status) }) };
    },
    taskboardRequest: async (url) => {
      calls.push(url);
      if (url.includes("/comments")) return { comments };
      return { tasks: tasks.filter((task) => task.status === "todo") };
    },
    currentQuotaPolicyCdp: () => ({}),
    remoteAutomationCanStart: async (_cdp, _request, task, latestComments) => {
      assert.equal(item.status, "PAUSED", "pause cron before the read-only decision");
      assert.equal(task.status, "todo");
      assert.equal(latestComments.at(-1).body, comments.at(-1).body);
      decisions += 1;
      return allowed;
    },
  });
  const rpc = async (method, body) => {
    if (method === "list-automations") return { items: [item] };
    assert.equal(method, "automation-update");
    item = { ...item, ...body };
    return { item };
  };
  return {
    tasks, comments, calls,
    get item() { return item; },
    get decisions() { return decisions; },
    allow() { allowed = true; },
    evaluate: () => api.evaluateLocalAutomationTodos(record),
    async check(evaluatedTodoGate) {
      const result = await api.applyTaskboardAutomationPolicy(request, rpc, () => true, {
        previousTodoGate: record.todoGate, evaluatedTodoGate,
      });
      record.todoGate = result.todoGate;
      return result;
    },
  };
}

test("waiting todos pause the same cron until description or latest comment allows work", async () => {
  const h = host();
  assert.equal((await h.check()).idleReason, "checking-todos");
  assert.equal(h.item.status, "PAUSED");
  assert.equal(h.decisions, 0);
  assert.equal((await h.check(await h.evaluate())).idleReason, "waiting-todos");
  assert.equal((await h.check()).idleReason, "waiting-todos");
  assert.equal(h.decisions, 1, "reuse an unchanged waiting decision");

  h.comments[0].body = "Approved, proceed";
  h.allow();
  assert.equal((await h.check()).idleReason, "checking-todos");
  const ready = await h.check(await h.evaluate());
  assert.equal(ready.idleReason, undefined);
  assert.equal(h.item.status, "ACTIVE");
  assert.equal(h.item.id, "preview-cron");
  assert.equal(h.tasks[0].status, "todo", "the preflight does not claim the task");
  assert.equal(h.tasks[0].version, 1);
});

test("waiting todos do not suspend a bound in-progress conversation", async () => {
  const h = host();
  await h.check();
  await h.check(await h.evaluate());
  h.tasks.push({
    id: "worker", status: "in_progress", projectId: "preview", archivedAt: null,
    threadBinding: {
      threadId: "worker-thread", codexProjectId: "remote-project",
      codexProjectKind: "remote", codexHostId: "ssh-host", workspacePath: "/remote/project",
    },
  });
  const result = await h.check();
  assert.equal(result.idleReason, undefined);
  assert.equal(result.todoGate, undefined);
  assert.equal(h.item.status, "ACTIVE");
  assert.equal(h.decisions, 1);
  assert.ok(h.calls.every((url) => !url.includes("/worker/comments")));
  h.tasks.pop();
  assert.equal((await h.check()).idleReason, "checking-todos");
  assert.equal(h.item.status, "PAUSED");
});
