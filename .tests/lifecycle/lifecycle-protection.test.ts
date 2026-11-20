import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import { afterAll, afterEach, test } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, protection] = await setupIsolatedBackend(
  "lifecycle-protection",
  () => import("../../backend/services/lifecycleProtection.ts"),
);

afterEach(() => {
  for (const key of [
    "AURRAL_LIFECYCLE_ENABLED",
    "AURRAL_LIFECYCLE_CONFIG",
    "AURRAL_LIFECYCLE_NAVIDROME_DB",
  ])
    delete process.env[key];
});
afterAll(() => cleanupIsolatedState(state));

const root = path.resolve("/music");
const config = { aurral_music_root: root, service_users: ["aurral"] };

function navidrome() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE media_file(id TEXT, path TEXT, album_id TEXT, artist_id TEXT, album_artist_id TEXT, missing INTEGER);
    CREATE TABLE album(id TEXT, mbz_album_id TEXT, mbz_release_group_id TEXT);
    CREATE TABLE artist(id TEXT, mbz_artist_id TEXT);
    CREATE TABLE media_file_artists(media_file_id TEXT, artist_id TEXT, role TEXT);
    CREATE TABLE user(id TEXT, user_name TEXT);
    CREATE TABLE annotation(user_id TEXT, item_type TEXT, item_id TEXT, starred INTEGER);
    CREATE TABLE playlist(id TEXT, owner_id TEXT);
    CREATE TABLE playlist_tracks(playlist_id TEXT, media_file_id TEXT);
    INSERT INTO media_file VALUES('t1','Artist/Album/01.flac','al1','ar1','ar1',0);
    INSERT INTO album VALUES('al1','rel1','rg1');
    INSERT INTO artist VALUES('ar1','artist-mbid');
    INSERT INTO user VALUES('u1','person'),('u2','aurral');`);
  return db;
}
const file = path.join(root, "Artist", "Album", "01.flac");

test("an unstarred, unreferenced album may be removed", () => {
  assert.equal(protection.nativeProtectionReason(navidrome(), file, config), null);
});

test("favourites, personal playlists and keep rules protect the whole album", () => {
  const starred = navidrome();
  starred.exec("INSERT INTO annotation VALUES('u1','artist','ar1',1)");
  assert.equal(
    protection.nativeProtectionReason(starred, file, config),
    "lifecycle-favourite-album",
  );
  const serviceStar = navidrome();
  serviceStar.exec("INSERT INTO annotation VALUES('u2','media_file','t1',1)");
  assert.equal(protection.nativeProtectionReason(serviceStar, file, config), null);

  const listed = navidrome();
  listed.exec(
    "INSERT INTO playlist VALUES('p1','u1'); INSERT INTO playlist_tracks VALUES('p1','t1')",
  );
  assert.equal(
    protection.nativeProtectionReason(listed, file, config),
    "lifecycle-retained-playlist-album",
  );
  assert.equal(
    protection.nativeProtectionReason(listed, file, { ...config, generated_playlist_ids: ["p1"] }),
    null,
  );
  assert.equal(
    protection.nativeProtectionReason(navidrome(), file, { ...config, keep_album_mbids: ["rg1"] }),
    "lifecycle-explicit-album",
  );
});

test("unknown and unindexed paths are kept", () => {
  const db = navidrome();
  assert.equal(
    protection.nativeProtectionReason(db, path.resolve("/elsewhere/x.flac"), config),
    "lifecycle-unknown-path",
  );
  assert.equal(
    protection.nativeProtectionReason(db, path.join(root, "New", "x.flac"), config),
    "lifecycle-unindexed-path",
  );
});

test("an unreadable Navidrome state keeps every file", async () => {
  assert.equal((await protection.lifecycleProtectedFiles([file])).size, 0);
  process.env.AURRAL_LIFECYCLE_ENABLED = "true";
  process.env.AURRAL_LIFECYCLE_CONFIG = path.join(state.baseDir, "missing.json");
  assert.equal(
    await protection.lifecycleProtectionReason(file),
    "lifecycle-native-state-unavailable",
  );
});

test("a flow folder keeps its protected files and removes the rest", async () => {
  const dir = path.join(state.baseDir, "flow");
  await fs.mkdir(path.join(dir, "Artist"), { recursive: true });
  const track = path.join(dir, "Artist", "a.flac");
  await fs.writeFile(track, "audio");
  process.env.AURRAL_LIFECYCLE_ENABLED = "true";
  assert.deepEqual(await protection.removeTreeKeepingProtected(dir), { kept: 1 });
  assert.equal(await fs.readFile(track, "utf8"), "audio");
  delete process.env.AURRAL_LIFECYCLE_ENABLED;
  assert.deepEqual(await protection.removeTreeKeepingProtected(dir), { kept: 0 });
  await assert.rejects(fs.access(dir));
});
