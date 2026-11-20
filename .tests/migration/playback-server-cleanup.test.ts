import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { createFakeNavidrome } from "../helpers/fakeNavidrome.ts";

const [
  state,
  { db },
  { dbOps, userOps, userIdentityOps },
  { encryptWithKey },
  { getSettingsEncryptionKey },
  cleanup,
  { downloadTracker },
  { resolveDownloadRoot },
  { normalizePathMappings },
] = await setupIsolatedBackend(
  "playback-server-cleanup",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/encryption.ts"),
  () => import("../../backend/db/helpers/settings.ts"),
  () => import("../../backend/services/playbackServerCleanup.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadPaths.ts"),
  () => import("../../backend/services/pathMappings.ts"),
);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

async function writeFile(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "audio");
  return file;
}

test("forgets old server playlists and retained files without deleting anything", async () => {
  resetDatabase(db);
  downloadTracker.clearAll();
  const secret = (value: string) => encryptWithKey(value, getSettingsEncryptionKey());
  dbOps.updateSettings({
    integrations: {
      navidrome: {
        url: "http://navidrome.test",
        username: "admin",
        password: secret("password"),
      },
      jellyfin: { url: "http://jellyfin.test", apiKey: secret("key"), userId: "admin" },
    },
  });
  dbOps.setJSONSetting("navidromePlaylistPointers", {
    flow: { global: { playlistId: "nd-1" } },
  });
  dbOps.setJSONSetting("jellyfinPlaylistPointers", {
    flow: { global: { playlistId: "jf-1", serverUrl: "http://jellyfin.test/" } },
  });
  const root = resolveDownloadRoot();
  const retained = await writeFile(path.join(root, "Old", "Retained.flac"));
  dbOps.setJSONSetting("playbackRetainedFiles", { [retained]: { reason: "playback" } });
  const user = userOps.createUser("plex-user", "hash")!;
  userIdentityOps.link(user.id, { providerType: "plex", providerKey: "plex", subject: "p-1" });

  const navidrome = createFakeNavidrome({ playlists: ["nd-1"] });
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return navidrome.fetch(input, init);
  };

  assert.equal(cleanup.hasLegacyPlaybackServerData(), true);
  const result = await cleanup.cleanUpPlaybackServers();

  assert.deepEqual(result, { pending: [], removedFiles: [] });
  assert.deepEqual(calls, []);
  assert.deepEqual(navidrome.playlists, ["nd-1"]);
  assert.equal(await exists(retained), true);
  assert.equal(cleanup.hasLegacyPlaybackServerData(), false);
  assert.equal(userIdentityOps.countForUser(user.id), 0);
});

test("path mappings for retired media servers are dropped instead of applying everywhere", () => {
  assert.deepEqual(
    normalizePathMappings([
      { source: "plex", remote: "/plex/music", local: "/music" },
      { source: "lidarr", remote: "/data/music", local: "/music" },
      { remote: "/downloads", local: "/data/downloads" },
    ]),
    [
      { source: "lidarr", remote: "/data/music", local: "/music" },
      { source: "all", remote: "/downloads", local: "/data/downloads" },
    ],
  );
});
