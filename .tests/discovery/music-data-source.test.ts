import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, musicData, listenbrainz] = await setupIsolatedBackend(
  "music-data-source",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/musicDataSource/index.ts"),
  () => import("../../backend/services/musicDataSource/listenbrainz.ts"),
);
const { fuseSimilarArtists, listenbrainzSource } = listenbrainz;

const mbid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const SEED = { name: "Seed Artist", mbid: mbid(1) };
const KEYLESS_ANSWER = [{ mbid: mbid(90), name: "Keyless Pick", image: null, match: 1 }];

const originalLastfmApiKey = process.env.LASTFM_API_KEY;

beforeAll(() => {
  resetDatabase(db);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(listenbrainzSource, "getSimilarArtists").mockResolvedValue(KEYLESS_ANSWER as never);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
  else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  await cleanupIsolatedState(isolatedState);
});

test("fusion ranks artists both providers agree on first and keeps single-provider proportions", () => {
  const listenbrainzList = [
    { mbid: mbid(11), name: "Popular Pick", image: null, score: 1 },
    { mbid: mbid(12), name: "Shared Pick", image: null, score: 0.6 },
    { mbid: SEED.mbid, name: SEED.name, image: null, score: 0.5 },
  ];
  const deezerList = [
    { mbid: null, name: "The Shared Pick", image: "https://img/shared.jpg", score: 1 },
    { mbid: null, name: "Seed Artist", image: null, score: 0.75 },
    { mbid: null, name: "Catalogue Pick", image: "https://img/catalogue.jpg", score: 0.5 },
  ];

  const fused = fuseSimilarArtists([listenbrainzList, deezerList], {
    limit: 10,
    exclude: [SEED.mbid, SEED.name],
  });

  assert.deepEqual(
    fused.map((artist) => [artist.name, artist.mbid, Math.round(artist.match * 100)]),
    [
      ["Shared Pick", mbid(12), 100],
      ["Popular Pick", mbid(11), 63],
      ["Catalogue Pick", null, 31],
    ],
  );
  // The Deezer image fills the ListenBrainz entry's gap.
  assert.equal(fused[0].image, "https://img/shared.jpg");

  const alone = fuseSimilarArtists([listenbrainzList], { limit: 2, exclude: [SEED.mbid] });
  assert.deepEqual(
    alone.map((artist) => [artist.name, artist.match]),
    [
      ["Popular Pick", 1],
      ["Shared Pick", 0.6],
    ],
  );
});

test("Last.fm is gone: a leftover key or preference still answers from the keyless providers", async () => {
  process.env.LASTFM_API_KEY = "leftover-key";
  dbOps.updateSettings({
    integrations: { lastfm: { apiKey: "leftover-key", musicDataSource: "lastfm" } },
  } as never);
  dbOps.invalidateSettingsCache();

  assert.equal(musicData.getMusicDataSourceName(), "listenbrainz");
  assert.deepEqual(await musicData.getSimilarArtists(SEED, { limit: 5 }), KEYLESS_ANSWER);
});
