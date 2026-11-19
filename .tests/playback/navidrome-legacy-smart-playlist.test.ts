import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { createPlaybackPlaylistSnapshot },
  { navidromePlaylistPointerStore },
  { NavidromePlaybackDestination },
  { NavidromeClient },
] = await setupIsolatedBackend(
  "navidrome-legacy-smart-playlist",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playback/playbackDestination.ts"),
  () => import("../../backend/services/navidrome/navidromePlaylistPointerStore.ts"),
  () => import("../../backend/services/playback/navidromePlaybackDestination.ts"),
  () => import("../../backend/services/navidrome.ts"),
);

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(downloadRoot != null);
// Production mounts the same media twice (/music read-only and the download
// root read-write); a hard link reproduces "same file, different path".
const nativeRoot = path.join(path.dirname(downloadRoot), "native-music");
const nativeDb = path.join(path.dirname(downloadRoot), "navidrome.db");

type Client = InstanceType<typeof NavidromeClient>;

class SmartClient extends NavidromeClient {
  members: string[] = [];
  mutations: string[] = [];
  constructor() {
    super("http://navidrome.test", "user", "password");
  }
  isConfigured() {
    return true;
  }
  async ensureAurralLibrary() {
    return null;
  }
  async getPlaylists() {
    return [{ id: "smart-1", name: "Discover" }];
  }
  async getPlaylist(id: string) {
    const playlist =
      id === "smart-1"
        ? { id, name: "Discover", entry: this.members.map((member) => ({ id: member })) }
        : null;
    return playlist as unknown as Awaited<ReturnType<Client["getPlaylist"]>>;
  }
  async findSong(title?: string | null) {
    return title ? { id: `song-${title}` } : null;
  }
  async createPlaylist(name: string): Promise<never> {
    this.mutations.push(`create:${name}`);
    throw new Error("must not create");
  }
  async updatePlaylist(id: string): Promise<never> {
    this.mutations.push(`update:${id}`);
    throw new Error("playlist tracks are not editable");
  }
  async renamePlaylist(id: string, name: string) {
    this.mutations.push(`rename:${id}:${name}`);
    return {};
  }
  async deletePlaylist(id: string) {
    this.mutations.push(`delete:${id}`);
    return {};
  }
}

class Destination extends NavidromePlaybackDestination {
  declare client: Client;

  constructor(client: Client) {
    super(downloadRoot, { client });
  }
}

async function setUpFlow({ linkSource = true, title = "Discover" } = {}) {
  const flow = flowPlaylistConfig.createFlow({ name: "Discover" });
  const rules = JSON.stringify({
    all: [{ is: { library_id: 1 } }, { contains: { filepath: flow.id } }],
    sort: "filepath",
  });
  const source = path.join(downloadRoot!, "AurralFlows", "[A] Discover.nsp");
  const native = path.join(nativeRoot, "AurralFlows", "[A] Discover.nsp");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.writeFile(source, rules);
  if (linkSource) await fs.link(source, native);
  else await fs.writeFile(native, rules);
  const metadata = new Database(nativeDb);
  metadata.exec("CREATE TABLE playlist (id TEXT PRIMARY KEY, path TEXT, sync INTEGER, rules TEXT)");
  metadata
    .prepare("INSERT INTO playlist VALUES ('smart-1', ?, 1, ?)")
    .run("/navidrome-music/AurralFlows/[A] Discover.nsp", rules);
  metadata.close();
  dbOps.updateSettings({
    pathMappings: [{ source: "navidrome", remote: "/navidrome-music", local: nativeRoot }],
  });
  navidromePlaylistPointerStore.setPointer(flow.id, "global", { playlistId: "smart-1", title });
  return flow;
}

const publish = (destination: Destination, flowId: string, titles: string[]) =>
  destination.publishPlaylist(
    createPlaybackPlaylistSnapshot({
      entityId: flowId,
      ownerUserId: null,
      displayName: "Discover",
      tracks: titles.map((title) => ({
        path: path.join(downloadRoot!, "AurralFlows", flowId, `${title}.flac`),
        title,
        artist: "Artist",
      })),
    }),
  );

beforeEach(async () => {
  await resetDatabase(db);
  dbOps.updateSettings({ pathMappings: [] });
  await fs.rm(downloadRoot, { recursive: true, force: true });
  await fs.rm(nativeRoot, { recursive: true, force: true });
  await fs.rm(nativeDb, { force: true });
  process.env.AURRAL_PRESERVE_LEGACY_MEDIA_LAYOUT = "true";
  process.env.AURRAL_LIFECYCLE_NAVIDROME_DB = nativeDb;
});

afterAll(async () => {
  delete process.env.AURRAL_PRESERVE_LEGACY_MEDIA_LAYOUT;
  delete process.env.AURRAL_LIFECYCLE_NAVIDROME_DB;
  await cleanupIsolatedState(isolatedState);
});

test("verifies a rule-managed flow playlist through a second mount without editing it", async () => {
  const flow = await setUpFlow({ title: "admin - Discover" });
  const client = new SmartClient();
  const destination = new Destination(client);

  // Rules have not picked the new files up yet: pending, nothing written.
  client.members = ["song-A"];
  assert.deepEqual(await publish(destination, flow.id, ["A", "B"]), { ok: true, pending: true });

  client.members = ["song-old", "song-A", "song-B"];
  assert.deepEqual(await publish(destination, flow.id, ["A", "B"]), { ok: true });
  assert.deepEqual(client.mutations, []);
  assert.equal(navidromePlaylistPointerStore.getPointer(flow.id, "global")?.playlistId, "smart-1");
});

test("refuses a smart playlist whose source is a different file", async () => {
  const flow = await setUpFlow({ linkSource: false });
  const client = new SmartClient();
  client.members = ["song-A"];
  await assert.rejects(
    publish(new Destination(client), flow.id, ["A"]),
    /not this flow's managed file/,
  );
  assert.deepEqual(client.mutations, []);
});

test("keeps the upstream editable-playlist path when the legacy layout is off", async () => {
  const flow = await setUpFlow();
  process.env.AURRAL_PRESERVE_LEGACY_MEDIA_LAYOUT = "false";
  const client = new SmartClient();
  client.members = ["song-A"];
  await publish(new Destination(client), flow.id, ["A"]).catch(() => null);
  assert.ok(client.mutations.includes("update:smart-1"));
});
