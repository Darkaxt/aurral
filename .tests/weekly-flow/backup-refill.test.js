import test from "node:test";
import assert from "node:assert/strict";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("backup-refill");
applyIsolatedBackendEnv(isolatedState);

const [{ db }, { dbOps }, workerModule, { downloadTracker }, { playlistSource }] =
  await Promise.all([
    importFromRepo("backend/config/db-sqlite.js"),
    importFromRepo("backend/config/db-helpers.js"),
    importFromRepo("backend/services/weeklyFlowWorker.js"),
    importFromRepo("backend/services/weeklyFlowDownloadTracker.js"),
    importFromRepo("backend/services/weeklyFlowPlaylistSource.js"),
  ]);

const { WeeklyFlowWorker } = workerModule;

test.beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    weeklyFlows: [
      {
        id: "flow-a",
        name: "Flow A",
        enabled: true,
        size: 5,
        mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
        tags: [],
        relatedArtists: [],
        scheduleDays: [1],
        scheduleTime: "00:00",
      },
    ],
  });
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("_enqueueBackupJobs only enqueues the shortfall and keeps extra tracks in reserve", async () => {
  const originalBuildFlowRunPlan = playlistSource.buildFlowRunPlan;
  playlistSource.buildFlowRunPlan = async () => ({
    primaryTracks: Array.from({ length: 10 }, (_, index) => ({
      artistName: `Artist ${index}`,
      trackName: `Track ${index}`,
    })),
    reserveTracks: [
      { artistName: "Reserve Artist", trackName: "Reserve Track" },
    ],
    diagnostics: { source: "test" },
  });

  try {
    const worker = new WeeklyFlowWorker();
    const added = await worker._enqueueBackupJobs("flow-a", 2);
    const jobs = downloadTracker.getByPlaylistType("flow-a");
    const runStatus = worker.getPlaylistRunStatus("flow-a");

    assert.equal(added, 2);
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      jobs.map((job) => job.trackName).sort(),
      ["Track 0", "Track 1"],
    );
    assert.equal(runStatus.reserveDepth, 9);
  } finally {
    playlistSource.buildFlowRunPlan = originalBuildFlowRunPlan;
  }
});

test("retryIncompletePlaylist caps failed requeues after backup jobs fill part of the shortfall", async () => {
  const doneJobs = downloadTracker.addJobs(
    [
      { artistName: "Done Artist 1", trackName: "Done Track 1" },
      { artistName: "Done Artist 2", trackName: "Done Track 2" },
    ],
    "flow-a",
  );
  for (const id of doneJobs) {
    downloadTracker.setDone(id, `/music/${id}.flac`);
  }

  const failedJobs = downloadTracker.addJobs(
    Array.from({ length: 6 }, (_, index) => ({
      artistName: `Failed Artist ${index}`,
      trackName: `Failed Track ${index}`,
    })),
    "flow-a",
  );
  for (const id of failedJobs) {
    downloadTracker.setFailed(id, "Previous failure");
  }

  const worker = new WeeklyFlowWorker();
  worker._enqueueBackupJobs = async (playlistType, shortfall) => {
    assert.equal(playlistType, "flow-a");
    assert.equal(shortfall, 3);
    return downloadTracker.addJobs(
      [
        { artistName: "Backup Artist 1", trackName: "Backup Track 1" },
        { artistName: "Backup Artist 2", trackName: "Backup Track 2" },
      ],
      playlistType,
    ).length;
  };
  worker.start = async () => {};

  const changed = await worker.retryIncompletePlaylist("flow-a");
  const stats = downloadTracker.getPlaylistTypeStats("flow-a");
  const pendingNames = downloadTracker
    .getByPlaylistType("flow-a")
    .filter((job) => job.status === "pending")
    .map((job) => job.trackName)
    .sort();

  assert.equal(changed, 3);
  assert.equal(stats.done, 2);
  assert.equal(stats.pending, 3);
  assert.equal(stats.failed, 5);
  assert.equal(pendingNames.filter((name) => name.startsWith("Backup ")).length, 2);
  assert.equal(pendingNames.filter((name) => name.startsWith("Failed ")).length, 1);
});
