import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const storageSource = await readFile(new URL("../web/src/storage.ts", import.meta.url), "utf8");

test("display settings migrate the legacy aggregate key into per-project entries", () => {
  assert.match(storageSource, /taskboard\.project-board-display-settings\.v3"/);
  assert.match(storageSource, /PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX/);
  assert.match(storageSource, /initializeTaskboardStorage[\s\S]*migrat/);
  assert.match(storageSource, /projectBoardDisplaySettingsStorageEntries/);
  assert.match(storageSource, /catch \(error\)[\s\S]*localStorageBackend/);
});
