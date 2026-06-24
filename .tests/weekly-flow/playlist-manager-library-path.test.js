import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("playlist-manager-library-path");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { WeeklyFlowPlaylistManager }] = await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/services/weeklyFlowPlaylistManager.js"),
]);

test.beforeEach(() => {
  resetDatabase(db);
  delete process.env.NAVIDROME_WEEKLY_FLOW_LIBRARY_PATH;
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("uses Navidrome-visible weekly-flow library path when configured", () => {
  process.env.NAVIDROME_WEEKLY_FLOW_LIBRARY_PATH = "/music/";

  const manager = new WeeklyFlowPlaylistManager("/app/downloads", {
    triggerEnsureOnInit: false,
  });

  assert.equal(manager._getWeeklyFlowLibraryHostPath(), "/music");
});

test("falls back to the Aurral download staging path when no Navidrome path is configured", () => {
  process.env.DOWNLOAD_FOLDER = "/app/downloads";

  const manager = new WeeklyFlowPlaylistManager("/app/downloads", {
    triggerEnsureOnInit: false,
  });

  assert.equal(
    manager._getWeeklyFlowLibraryHostPath(),
    "/app/downloads/aurral-weekly-flow",
  );
});
