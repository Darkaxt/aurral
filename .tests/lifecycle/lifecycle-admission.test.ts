import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { createTrackedJob } from "../download/fixtures.ts";

const [state, { db }, admission, { SlskdClient }, { downloadTracker }, pipeline] =
  await setupIsolatedBackend(
    "lifecycle-admission",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/lifecycleAdmission.ts"),
    () => import("../../backend/services/slskdClient.ts"),
    () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
    () => import("../../backend/services/downloadPipeline.ts"),
  );

const LIFECYCLE_ENV = [
  "AURRAL_LIFECYCLE_ENABLED",
  "AURRAL_LIFECYCLE_CONFIG",
  "AURRAL_LIFECYCLE_STATE",
];
const config = {
  ssd_uuid: "uuid",
  resume_bytes: 200,
  reserve_bytes: 100,
  max_inflight_acquisitions: 3,
  max_inflight_bytes: 10_000,
  transfer_reservation_factor: 1,
};

function lifecycleState() {
  const ledger = new Database(":memory:");
  ledger.exec(`CREATE TABLE reservations(identity TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes>0),
    phase TEXT NOT NULL, external_ids TEXT, created REAL NOT NULL);
    CREATE TABLE policy_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE evictions(mbid TEXT PRIMARY KEY, retirement TEXT NOT NULL, occurred REAL NOT NULL);`);
  return ledger;
}

async function enableWithStateFile() {
  const file = path.join(state.baseDir, "lifecycle-state.db");
  const ledger = new Database(file);
  ledger.exec(`CREATE TABLE IF NOT EXISTS reservations(identity TEXT PRIMARY KEY, bytes INTEGER NOT NULL,
    phase TEXT NOT NULL, external_ids TEXT, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS policy_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evictions(mbid TEXT PRIMARY KEY, retirement TEXT NOT NULL, occurred REAL NOT NULL);
    DELETE FROM reservations; DELETE FROM policy_state; DELETE FROM evictions;`);
  const configFile = path.join(state.baseDir, "lifecycle-config.json");
  await writeFile(configFile, JSON.stringify(config));
  process.env.AURRAL_LIFECYCLE_ENABLED = "true";
  process.env.AURRAL_LIFECYCLE_CONFIG = configFile;
  process.env.AURRAL_LIFECYCLE_STATE = file;
  return ledger;
}

beforeEach(() => resetDatabase(db));
afterEach(() => {
  for (const key of LIFECYCLE_ENV) delete process.env[key];
});
afterAll(() => cleanupIsolatedState(state));

const observed = { available: 1_000_000, external: 0 };
const request = (jobId: string) => ({
  username: "peer",
  files: [{ filename: "a.flac", size: 10 }],
  owner: { jobId, jobIds: [jobId], attempt: 0, albumGroupId: "album" },
});

test("admission is off unless AURRAL_LIFECYCLE_ENABLED=true", async () => {
  let ran = 0;
  const result = await admission.withLifecycleJob(
    { jobId: "j", phase: "search" },
    null,
    async () => ++ran,
  );
  assert.equal(result, 1);
  assert.equal(admission.isLifecycleSourceAllowed("ytdlp", "search"), true);
});

test("an unreadable lifecycle state holds the step instead of downloading", async () => {
  process.env.AURRAL_LIFECYCLE_ENABLED = "true";
  process.env.AURRAL_LIFECYCLE_CONFIG = path.join(state.baseDir, "missing.json");
  process.env.AURRAL_LIFECYCLE_STATE = path.join(state.baseDir, "missing.db");
  for (const phase of ["search", "download"]) {
    let ran = false;
    const result = await admission.withLifecycleJob({ jobId: "j", phase }, null, async () => {
      ran = true;
    });
    assert.equal(ran, false);
    assert.deepEqual(result, {
      jobId: "j",
      phase,
      delaySeconds: 60,
      lifecycleHold: "Lifecycle state unavailable; preserve the original queued job",
    });
  }
  // Steps after dispatch keep running so a started transfer is still imported.
  assert.equal(
    await admission.withLifecycleJob({ jobId: "j", phase: "poll" }, null, async () => "polled"),
    "polled",
  );
});

test("missing SSD observations and retired albums hold the search", async () => {
  const ledger = await enableWithStateFile();
  try {
    const search = await admission.withLifecycleJob(
      { jobId: "j", phase: "search" },
      null,
      async () => "searched",
    );
    assert.match(
      String((search as { lifecycleHold?: string }).lifecycleHold),
      /observation unavailable/,
    );
    ledger.prepare("INSERT INTO evictions VALUES('retired-album','r',0)").run();
    const download = await admission.withLifecycleJob(
      { jobId: "j", phase: "download" },
      { albumMbid: "retired-album" },
      async () => "downloaded",
    );
    assert.match(String((download as { lifecycleHold?: string }).lifecycleHold), /retired/);
  } finally {
    ledger.close();
  }
});

test("only slskd may search or download while admission is on", () => {
  process.env.AURRAL_LIFECYCLE_ENABLED = "true";
  assert.equal(admission.isLifecycleSourceAllowed("slskd", "search"), true);
  assert.equal(admission.isLifecycleSourceAllowed("ytdlp", "search"), false);
  assert.equal(admission.isLifecycleSourceAllowed("deemix", "download"), false);
  assert.equal(admission.isLifecycleSourceAllowed("ytdlp", "finalize"), true);
});

test("reservations are bounded by slot count and the SSD reserve", () => {
  const ledger = lifecycleState();
  for (const id of ["1", "2", "3"])
    assert.equal(admission.reserveBatch(ledger, id, 10, observed, config, request(id)), true);
  assert.equal(admission.reserveBatch(ledger, "4", 10, observed, config, request("4")), false);
  assert.equal(admission.reserveBatch(ledger, "1", 10, observed, config, request("1")), false);

  const tight = lifecycleState();
  assert.equal(
    admission.reserveBatch(tight, "x", 50, { available: 120, external: 0 }, config, request("x")),
    false,
  );
  const stopped = tight.prepare("SELECT value FROM policy_state WHERE key='space_stopped'").get();
  assert.deepEqual(stopped, { value: "true" });
  // Once stopped, admission waits for the larger resume margin.
  assert.equal(
    admission.reserveBatch(tight, "y", 1, { available: 150, external: 0 }, config, request("y")),
    false,
  );
});

test("active reservations are released only when every owned job is done", () => {
  const ledger = lifecycleState();
  const add = (id: string, jobIds: string[]) =>
    ledger
      .prepare("INSERT INTO reservations VALUES(?,10,'active',?,0)")
      .run(id, JSON.stringify({ request: { owner: { jobId: jobIds[0], jobIds } } }));
  add("a", ["1", "2"]);
  add("b", ["3"]);
  const status = new Map([
    ["1", "done"],
    ["2", "downloading"],
    ["3", "done"],
  ]);
  admission.releaseCompletedInDatabase(ledger, (id) => status.get(id));
  assert.deepEqual(
    ledger.prepare("SELECT identity,phase FROM reservations ORDER BY identity").all(),
    [
      { identity: "a", phase: "active" },
      { identity: "b", phase: "released" },
    ],
  );
});

test("slskd enqueue never POSTs without its job identity and a readable budget", async () => {
  const posts: string[] = [];
  const mock = await createMockHttpServer((req, res) => {
    req.resume();
    if (req.method === "POST") posts.push(String(req.url));
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ enqueued: [{ id: "t1", filename: "a.flac", size: 10 }], failed: [] }));
  });
  const slskdClient = new SlskdClient({ url: mock.url, apiKey: "key" });
  const ledger = await enableWithStateFile();
  try {
    await assert.rejects(
      () =>
        slskdClient.enqueueBatch({ username: "peer", files: [{ filename: "a.flac", size: 10 }] }),
      (error) => admission.isLifecycleHold(error),
    );
    // With its job identity but no fresh SSD observation, the dispatch is held.
    await assert.rejects(
      () =>
        admission.withLifecycleJob({ jobId: "j", phase: "poll" }, { albumMbid: "album" }, () =>
          slskdClient.enqueueBatch({ username: "peer", files: [{ filename: "a.flac", size: 10 }] }),
        ),
      /observation unavailable/,
    );
    assert.deepEqual(posts, []);
    assert.equal(
      ledger.prepare<[], { n: number }>("SELECT count(*) n FROM reservations").get()?.n,
      0,
    );
  } finally {
    ledger.close();
    await mock.close();
  }
});

test("the pipeline keeps a queued job unchanged while admission is unavailable", async () => {
  process.env.AURRAL_LIFECYCLE_ENABLED = "true";
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Artist", trackName: "Track" },
    "lifecycle-flow",
  );
  const next = await pipeline.processPipelinePayload({ jobId, phase: "search", source: "ytdlp" });
  assert.equal(next?.delaySeconds, 60);
  assert.equal(next?.phase, "search");
  assert.equal(next?.source, "ytdlp");
  assert.equal(downloadTracker.getJob(jobId)?.status, "pending");
});

test("a released identical request is never replayed or held forever", async () => {
  const { createHash } = await import("node:crypto");
  const ledger = await enableWithStateFile();
  const identity =
    "aurral:" +
    createHash("sha256")
      .update(JSON.stringify(request("j")))
      .digest("hex");
  ledger
    .prepare("INSERT INTO reservations VALUES(?,?,'released',?,?)")
    .run(identity, 10, JSON.stringify({ request: request("j") }), Date.now() / 1000);
  const files = [{ filename: "a.flac", size: 10 }];
  const run = (transfers: unknown[]) => {
    const posts: unknown[] = [];
    const result = admission.withLifecycleJob(
      { jobId: "j", phase: "poll" },
      { albumMbid: "album" },
      () =>
        admission.lifecycleBatch(
          "peer",
          files,
          async () => {
            posts.push(files);
            return { transfers: [] };
          },
          async () => [{ username: "peer", directories: [{ files: transfers }] }],
        ),
    );
    return { posts, result };
  };
  try {
    // Nothing left in slskd: give up on this candidate (not a hold), so the pipeline moves on.
    const gone = run([]);
    await assert.rejects(gone.result, (error: { lifecycleDefiniteReject?: boolean }) => {
      assert.equal(admission.isLifecycleHold(error), false);
      assert.equal(error.lifecycleDefiniteReject, true);
      return true;
    });
    const failed = run([{ id: "t0", filename: "a.flac", size: 10, state: "Completed, Errored" }]);
    await assert.rejects(failed.result, (error) => !admission.isLifecycleHold(error));
    // A transfer that is still running keeps the job waiting.
    const running = run([{ id: "t1", filename: "a.flac", size: 10, state: "InProgress" }]);
    await assert.rejects(running.result, (error) => admission.isLifecycleHold(error));
    // A finished transfer is reused instead of being downloaded again.
    const done = run([{ id: "t2", filename: "a.flac", size: 10, state: "Completed, Succeeded" }]);
    const receipt = (await done.result) as { transferId?: string };
    assert.equal(receipt.transferId, "t2");
    for (const attempt of [gone, failed, running, done]) assert.deepEqual(attempt.posts, []);
    assert.equal(
      ledger.prepare<[], { phase: string }>("SELECT phase FROM reservations").get()?.phase,
      "released",
    );
  } finally {
    ledger.close();
  }
});
