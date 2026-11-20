import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { createTrackedJob } from "../download/fixtures.ts";

const [
  state,
  { db },
  sources,
  { runMissingTrackSearch },
  { runQualityUpgradeCheck },
  tracker,
  pipeline,
] = await setupIsolatedBackend(
  "downloads-disabled",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadSourceService.ts"),
  () => import("../../backend/services/missingTrackSearch.ts"),
  () => import("../../backend/services/qualityProfileService.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
);

beforeEach(() => resetDatabase(db));
afterEach(() => {
  delete process.env.AURRAL_DOWNLOADS_DISABLED;
});
afterAll(() => cleanupIsolatedState(state));

test("AURRAL_DOWNLOADS_DISABLED turns every source off, bundled yt-dlp included", async () => {
  process.env.AURRAL_DOWNLOADS_DISABLED = "true";
  assert.deepEqual(sources.getEnabledDownloadSources(), []);
  assert.equal(sources.isAnyDownloadSourceConfigured(), false);
  assert.equal(await runMissingTrackSearch(), 0);
  assert.equal(await runQualityUpgradeCheck({ force: true }), 0);
});

test("a share-link download fails instead of fetching while downloads are disabled", async () => {
  process.env.AURRAL_DOWNLOADS_DISABLED = "true";
  const { downloadTracker } = tracker;
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "A", trackName: "T" },
    "share-flow",
  );
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response(null, { status: 500 });
  };
  try {
    assert.equal(
      await pipeline.processPipelinePayload({ jobId, phase: "search", source: "share" }),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetched, false);
  assert.equal(downloadTracker.getJob(jobId)?.status, "failed");
});
