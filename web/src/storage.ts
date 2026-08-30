const memoryStorage = new Map<string, string>();
const PROJECT_BOARD_DISPLAY_SETTINGS_LEGACY_KEY = "taskboard.project-board-display-settings.v3";
export const PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX = "taskboard.project-board-display-settings.v3.";
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
let localStorageBackend: Storage | null = null;
let serverBacked = false;
let storageWrite = Promise.resolve();
let storageRefresh = Promise.resolve();

function isProjectBoardDisplaySettingsKey(key: string) {
  return key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX);
}

async function readServerStorage() {
  const response = await fetch(new URL("api/client-storage", document.baseURI));
  if (!response.ok) throw new Error(`Taskboard storage returned ${response.status}`);
  const payload = await response.json() as { entries: Record<string, string> };
  if (localStorageBackend) {
    for (const key of memoryStorage.keys()) {
      if (isProjectBoardDisplaySettingsKey(key)) memoryStorage.delete(key);
    }
    for (const [key, value] of Object.entries(payload.entries)) {
      if (isProjectBoardDisplaySettingsKey(key)) memoryStorage.set(key, value);
    }
    return;
  }
  memoryStorage.clear();
  for (const [key, value] of Object.entries(payload.entries)) {
    memoryStorage.set(key, value);
  }
  serverBacked = true;
}

async function refreshServerStorage() {
  storageRefresh = storageRefresh.catch(() => {}).then(readServerStorage);
  await storageRefresh;
}

function persist(key: string, value: string | null) {
  storageWrite = storageWrite.then(async () => {
    const body = JSON.stringify({ key, value });
    const keepalive = new TextEncoder().encode(body).byteLength <= 64 * 1024;
    let retryDelay = RETRY_DELAY_MS;
    while (true) {
      try {
        const response = await fetch(new URL("api/client-storage", document.baseURI), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body,
          keepalive,
        });
        if (response.ok) return;
        const error = new Error(`Taskboard storage returned ${response.status}`);
        if (response.status >= 400 && response.status < 500) {
          console.error(error);
          return;
        }
        throw error;
      } catch (error) {
        console.error(error);
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    }
  });
}

function migrateProjectBoardDisplaySettings() {
  const raw = localStorageBackend?.getItem(PROJECT_BOARD_DISPLAY_SETTINGS_LEGACY_KEY)
    ?? memoryStorage.get(PROJECT_BOARD_DISPLAY_SETTINGS_LEGACY_KEY);
  if (!raw) return;
  try {
    const legacySettings = JSON.parse(raw) as Record<string, unknown>;
    for (const [projectId, settings] of Object.entries(legacySettings)) {
      if (!projectId || !settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      const key = `${PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX}${projectId}`;
      if (memoryStorage.has(key)) continue;
      const value = JSON.stringify(settings);
      memoryStorage.set(key, value);
      persist(key, value);
    }
  } catch {
    // Leave malformed legacy data untouched.
  }
}

export async function initializeTaskboardStorage() {
  try {
    localStorageBackend = window.localStorage;
  } catch {
    localStorageBackend = null;
  }
  await refreshServerStorage();
  migrateProjectBoardDisplaySettings();
}

export async function refreshProjectBoardDisplaySettingsStorage() {
  await storageWrite;
  await refreshServerStorage();
}

export function projectBoardDisplaySettingsStorageEntries() {
  return [...memoryStorage.entries()].filter(([key]) => isProjectBoardDisplaySettingsKey(key));
}

export const taskboardStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key) {
    if (isProjectBoardDisplaySettingsKey(key)) return memoryStorage.get(key) ?? null;
    return localStorageBackend?.getItem(key) ?? memoryStorage.get(key) ?? null;
  },
  setItem(key, value) {
    if (isProjectBoardDisplaySettingsKey(key)) {
      memoryStorage.set(key, value);
      persist(key, value);
      return;
    }
    if (localStorageBackend) {
      localStorageBackend.setItem(key, value);
      return;
    }
    memoryStorage.set(key, value);
    if (serverBacked) persist(key, value);
  },
  removeItem(key) {
    if (isProjectBoardDisplaySettingsKey(key)) {
      memoryStorage.delete(key);
      persist(key, null);
      return;
    }
    if (localStorageBackend) {
      localStorageBackend.removeItem(key);
      return;
    }
    memoryStorage.delete(key);
    if (serverBacked) persist(key, null);
  },
};
