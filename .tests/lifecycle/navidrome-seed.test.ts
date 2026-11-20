import assert from "node:assert/strict";
import { afterAll, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, playEvents, pipeline] = await setupIsolatedBackend(
  "navidrome-seed",
  () => import("../../backend/services/playEventService.ts"),
  () => import("../../backend/services/discovery/recommendationPipeline.ts"),
);
const { db } = await import("../../backend/config/db-sqlite.ts");

beforeEach(() => {
  resetDatabase(db);
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("listener", "test");
});
afterAll(() => cleanupIsolatedState(state));

const insert = db.prepare(
  `INSERT INTO play_events (user_id, track_id, title, artist, played_at, source, created_at, external_id)
   VALUES (1, ?, 'Song', ?, ?, ?, 0, ?)`,
);

test("artists played through a Navidrome history server seed discovery as navidrome", () => {
  insert.run("navidrome:1", "Heard On Navidrome", 1000, "navidrome", "n1");
  insert.run("navidrome:2", "Both", 1001, "navidrome", "n2");
  insert.run("song:3", "Both", 1002, "subsonic", null);
  insert.run("song:4", "Only Here", 1003, "native-player", null);

  const seeds = playEvents.getTopPlayedSeedArtists(1, { limit: 10 });
  assert.deepEqual(Object.fromEntries(seeds.map((seed) => [seed.artistName, seed.source])), {
    "Heard On Navidrome": "navidrome",
    Both: "navidrome",
    "Only Here": "local",
  });
  const list = pipeline.buildDiscoverySeedList({ historyArtists: seeds });
  assert.equal(list.find((seed) => seed.artistName === "Both")?.source, "navidrome");
});
