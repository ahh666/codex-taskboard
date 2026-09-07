import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../web/src/taskConversations.ts", import.meta.url), "utf8");

test("AI threads are indexed once by their originating task", () => {
  assert.match(source, /export function indexAiThreadsByTask\(aiThreads: AiChatThread\[\]\)/);
  assert.match(source, /const taskId = thread\.origin\.issueId;/);
  assert.match(source, /if \(!taskId\) continue;/);
  assert.match(source, /index\.set\(taskId, \[thread\]\)/);
});
