import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("playlist-manager-library-path");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { WeeklyFlowPlaylistManager }, { downloadTracker }] =
  await Promise.all([
  importFromRepo("backend/config/db-sqlite.js"),
  importFromRepo("backend/services/weeklyFlowPlaylistManager.js"),
  importFromRepo("backend/services/weeklyFlowDownloadTracker.js"),
]);

test.beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  delete process.env.NAVIDROME_WEEKLY_FLOW_LIBRARY_PATH;
  delete process.env.WEEKLY_FLOW_LIBRARY_DIR;
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

test("uses configured weekly-flow library directory for local writes and Navidrome fallback", () => {
  process.env.DOWNLOAD_FOLDER = "/app/downloads";
  process.env.WEEKLY_FLOW_LIBRARY_DIR = "AurralFlows";

  const manager = new WeeklyFlowPlaylistManager("/app/downloads", {
    triggerEnsureOnInit: false,
  });

  assert.equal(
    manager.libraryRoot.replace(/\\/g, "/"),
    path.join("/app/downloads", "AurralFlows").replace(/\\/g, "/"),
  );
  assert.equal(manager._getWeeklyFlowLibraryHostPath(), "/app/downloads/AurralFlows");
});

test("preserves existing flow files during generation reset", async () => {
  const root = path.join(isolatedState.baseDir, "preserve-reset");
  const manager = new WeeklyFlowPlaylistManager(root, {
    triggerEnsureOnInit: false,
  });
  const playlistDir = path.join(manager.libraryRoot, "flow-a");
  const existingFile = path.join(playlistDir, "Artist", "Album", "Keep.flac");
  await fs.mkdir(path.dirname(existingFile), { recursive: true });
  await fs.writeFile(existingFile, "audio");
  downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, "flow-a");

  await manager.weeklyReset(["flow-a"], { deleteFiles: false });

  assert.equal(await fileExists(existingFile), true);
  assert.equal(downloadTracker.getByPlaylistType("flow-a").length, 0);
});

test("deletes existing flow files during destructive reset by default", async () => {
  const root = path.join(isolatedState.baseDir, "delete-reset");
  const manager = new WeeklyFlowPlaylistManager(root, {
    triggerEnsureOnInit: false,
  });
  const playlistDir = path.join(manager.libraryRoot, "flow-a");
  const existingFile = path.join(playlistDir, "Artist", "Album", "Delete.flac");
  await fs.mkdir(path.dirname(existingFile), { recursive: true });
  await fs.writeFile(existingFile, "audio");

  await manager.weeklyReset(["flow-a"]);

  assert.equal(await fileExists(existingFile), false);
});

test("removes stale files only after replacement jobs are done", async () => {
  const root = path.join(isolatedState.baseDir, "stale-prune");
  const manager = new WeeklyFlowPlaylistManager(root, {
    triggerEnsureOnInit: false,
  });
  const playlistDir = path.join(manager.libraryRoot, "flow-a");
  const keepFile = path.join(playlistDir, "Artist", "Album", "Keep.flac");
  const staleFile = path.join(playlistDir, "Old Artist", "Old Album", "Old.flac");
  await fs.mkdir(path.dirname(keepFile), { recursive: true });
  await fs.mkdir(path.dirname(staleFile), { recursive: true });
  await fs.writeFile(keepFile, "audio");
  await fs.writeFile(staleFile, "audio");
  const [jobId] = downloadTracker.addJobs(
    [{ artistName: "Artist", trackName: "Keep" }],
    "flow-a",
  );
  downloadTracker.setDone(jobId, keepFile);

  const removed = await manager.cleanupPlaylistFilesNotInDoneJobs("flow-a");

  assert.equal(removed, 1);
  assert.equal(await fileExists(keepFile), true);
  assert.equal(await fileExists(staleFile), false);
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
