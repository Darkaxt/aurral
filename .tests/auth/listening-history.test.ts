import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps, dbOps }, { api }, discovery, { getUserDiscovery }] =
  await setupIsolatedBackend(
    "listening-history",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/routes/api.ts"),
    () => import("../../backend/services/discovery/index.ts"),
    () => import("../../backend/services/discovery/userDiscovery.ts"),
  );

let userId = 0;
const app = signedInAs(() => ({
  id: userId,
  username: "alice",
  role: "user",
  permissions: {},
})).route("/", api);

const patchHistory = async (json: unknown) => {
  const response = await app.request("/users/me/listening-history", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
  return { status: response.status, body: await response.json() };
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
  const user = userOps.createUser("alice", "hash");
  assert.ok(user);
  userId = user.id;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await cleanupIsolatedState(isolatedState);
});

test("a user keeps a history source for each service and can clear one", async () => {
  const saved = await patchHistory({
    listenbrainz: " brainz-listener ",
    koito: "http://koito.local:4110/apis/listenbrainz/",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, {
    listenbrainz: "brainz-listener",
    koito: "http://koito.local:4110",
    navidrome: null,
  });

  const cleared = await patchHistory({ listenbrainz: "" });
  assert.deepEqual(cleared.body, {
    listenbrainz: null,
    koito: "http://koito.local:4110",
    navidrome: null,
  });

  const response = await app.request("/users/me/listening-history");
  assert.deepEqual(await response.json(), cleared.body);
});

test("an invalid Koito URL is rejected without touching other sources", async () => {
  await patchHistory({ listenbrainz: "listener" });

  const rejected = await patchHistory({ listenbrainz: "someone-else", koito: "ftp://koito.local" });

  assert.equal(rejected.status, 400);
  const response = await app.request("/users/me/listening-history");
  assert.deepEqual(await response.json(), {
    listenbrainz: "listener",
    koito: null,
    navidrome: null,
  });
});

test("a removed Last.fm history source is not accepted", async () => {
  const saved = await patchHistory({ lastfm: "listener", listenbrainz: "brainz-listener" });
  const response = await app.request("/users/me/listening-history");
  const history = await response.json();
  assert.equal("lastfm" in history, false);
  assert.ok(saved.status === 400 || history.listenbrainz === "brainz-listener");
});

test("discovery builds from ListenBrainz history without Last.fm", async () => {
  const seed = "00000000-0000-4000-8000-000000000002";
  const similar = "00000000-0000-4000-8000-000000000003";
  const hosts = new Set<string>();
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    hosts.add(target.hostname);
    const body = target.pathname.includes("/stats/user/brainz-listener/artists")
      ? {
          payload: {
            artists: [
              {
                artist_name: "From Brainz",
                artist_mbid: seed,
                artist_mbids: [seed],
                listen_count: 40,
              },
            ],
          },
        }
      : target.hostname === "labs.api.listenbrainz.org" &&
          target.pathname === "/similar-artists/json"
        ? target.searchParams.get("artist_mbids") === seed
          ? [{ artist_mbid: similar, name: "Like From Brainz", score: 900, reference_mbid: seed }]
          : []
        : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await patchHistory({ listenbrainz: "brainz-listener" });

  await discovery.updateUserDiscoveryCache(userId);

  const { body } = getUserDiscovery(userId, 0);
  assert.deepEqual(
    body.recommendations.map((artist) => artist.name),
    ["Like From Brainz"],
  );
  assert.equal(hosts.has("ws.audioscrobbler.com"), false);
});
