import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { isLifecycleEnabled, releaseCompletedLifecycleReservations } from "./lifecycleAdmission.ts";
import { logger } from "./logger.ts";

// minipc fork: deletion guard shared with the external music lifecycle.
//
// While AURRAL_LIFECYCLE_ENABLED=true, Aurral removes or rewrites a Library
// file only after the read-only Navidrome database proves no person relies on
// it: no favourite on the track, its album or artist, no reference from a
// person's playlist, and no explicit keep rule. A file that cannot be proven
// safe (unindexed, outside the music root, unreadable state) is kept. Keeping
// original paths keeps Navidrome IDs, stars and playlist references valid.

type Db = Database.Database;
type Row = Record<string, unknown>;
type ProtectionConfig = {
  aurral_music_root: string;
  service_users?: string[];
  generated_playlist_ids?: string[];
  keep_playlist_ids?: string[];
  keep_album_mbids?: string[];
  keep_artist_mbids?: string[];
};

export function nativeProtectionReason(
  db: Db,
  file: string,
  config: ProtectionConfig,
): string | null {
  const relative = path.relative(path.resolve(config.aurral_music_root), path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "lifecycle-unknown-path";
  const nativePath = relative.split(path.sep).join("/");
  const track = db
    .prepare(
      "SELECT id,album_id,artist_id,album_artist_id FROM media_file WHERE path=? AND missing=0",
    )
    .get(nativePath) as Row | undefined;
  if (!track) return "lifecycle-unindexed-path";
  const ownAlbum = db
    .prepare("SELECT id,mbz_album_id,mbz_release_group_id FROM album WHERE id=?")
    .get(track.album_id) as Row | undefined;
  if (!ownAlbum) return "lifecycle-unknown-album";
  const group = String(ownAlbum.mbz_release_group_id || "");
  const albums = db
    .prepare(
      "SELECT id,mbz_album_id,mbz_release_group_id FROM album WHERE id=? OR (?<>'' AND mbz_release_group_id=?)",
    )
    .all(track.album_id, group, group) as Row[];
  const placeholders = albums.map(() => "?").join(",");
  const ids = albums.map((row) => row.id);
  const members = db
    .prepare(
      `SELECT id,artist_id,album_artist_id FROM media_file WHERE album_id IN (${placeholders})`,
    )
    .all(...ids) as Row[];
  const artistIds = new Set(
    members.flatMap((row) => [row.artist_id, row.album_artist_id]).filter(Boolean),
  );
  const credited = db
    .prepare(
      `SELECT ma.artist_id FROM media_file_artists ma JOIN media_file m ON m.id=ma.media_file_id
       WHERE m.album_id IN (${placeholders}) AND ma.role IN ('artist','albumartist')`,
    )
    .all(...ids) as Row[];
  for (const row of credited) artistIds.add(row.artist_id);
  const artistMbid = db.prepare("SELECT mbz_artist_id FROM artist WHERE id=?");
  const mbidOf = (id: unknown) => (artistMbid.get(id) as Row | undefined)?.mbz_artist_id;
  const artistMbids = new Set([...artistIds].map(mbidOf).filter(Boolean));
  const memberIds = new Set(members.map((row) => row.id));
  const serviceUsers = new Set(config.service_users || []);
  const stars = db
    .prepare(
      "SELECT u.user_name,a.item_type,a.item_id FROM annotation a JOIN user u ON u.id=a.user_id WHERE a.starred",
    )
    .all() as Row[];
  if (
    stars.some(
      (row) =>
        !serviceUsers.has(String(row.user_name)) &&
        ((row.item_type === "media_file" && memberIds.has(row.item_id)) ||
          (row.item_type === "album" && ids.includes(row.item_id)) ||
          (row.item_type === "artist" &&
            (artistIds.has(row.item_id) || artistMbids.has(mbidOf(row.item_id))))),
    )
  )
    return "lifecycle-favourite-album";
  const excluded = new Set(config.generated_playlist_ids || []);
  const references = db
    .prepare(
      `SELECT DISTINCT p.id,u.user_name FROM playlist_tracks pt
       JOIN playlist p ON p.id=pt.playlist_id JOIN user u ON u.id=p.owner_id JOIN media_file m ON m.id=pt.media_file_id
       WHERE m.album_id IN (${placeholders})`,
    )
    .all(...ids) as Row[];
  if (
    references.some(
      (row) =>
        (config.keep_playlist_ids || []).includes(String(row.id)) ||
        (!excluded.has(String(row.id)) && !serviceUsers.has(String(row.user_name))),
    )
  )
    return "lifecycle-retained-playlist-album";
  if (
    (config.keep_album_mbids || []).some((id) =>
      albums.some((album) => id === album.mbz_album_id || id === album.mbz_release_group_id),
    )
  )
    return "lifecycle-explicit-album";
  if ([...artistMbids].some((id) => (config.keep_artist_mbids || []).includes(String(id))))
    return "lifecycle-explicit-artist";
  return null;
}

// Why each file must be kept; a file missing from the map may be removed.
// Empty while the lifecycle is off.
export async function lifecycleProtectedFiles(files: Iterable<string>) {
  const kept = new Map<string, string>();
  const list = [...new Set(files)];
  if (!isLifecycleEnabled() || list.length === 0) return kept;
  let db: Db | undefined;
  try {
    const config = JSON.parse(
      fs.readFileSync(process.env.AURRAL_LIFECYCLE_CONFIG!, "utf8"),
    ) as ProtectionConfig;
    db = new Database(process.env.AURRAL_LIFECYCLE_NAVIDROME_DB!, {
      readonly: true,
      fileMustExist: true,
    });
    for (const file of list) {
      const reason = nativeProtectionReason(db, file, config);
      if (reason) kept.set(file, reason);
    }
  } catch {
    // An unreadable source cannot authorize deleting a favourite.
    for (const file of list) kept.set(file, "lifecycle-native-state-unavailable");
  } finally {
    db?.close();
  }
  if (kept.size)
    logger.info("library", "Kept files the music lifecycle protects", {
      files: kept.size,
      reason: [...new Set(kept.values())].join(", "),
    });
  return kept;
}

export async function lifecycleProtectionReason(file: string) {
  return (await lifecycleProtectedFiles([file])).get(file) ?? null;
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(full) : Promise.resolve([full]);
    }),
  );
  return nested.flat();
}

// Removes a folder of downloads, keeping every file the lifecycle protects.
export async function removeTreeKeepingProtected(directory: string) {
  if (!isLifecycleEnabled()) {
    await fsp.rm(directory, { recursive: true, force: true });
    return { kept: 0 };
  }
  const files = await filesUnder(directory);
  const kept = await lifecycleProtectedFiles(files);
  if (kept.size === 0) {
    await fsp.rm(directory, { recursive: true, force: true });
    return { kept: 0 };
  }
  for (const file of files) if (!kept.has(file)) await fsp.rm(file, { force: true });
  return { kept: kept.size };
}

type FlowJob = {
  id: string;
  status: string;
  finalPath?: string | null;
  playlistGeneration?: number | null;
  artistMbid?: string | null;
  artistName?: string | null;
};
type FlowSelection = {
  flowId: string;
  generation: number;
  capturedAt: number;
  artists: { mbid: string | null | undefined; name: string | null | undefined }[];
};

// Called at a flow's weekly reset, right before the generation's jobs are
// deleted, so the lifecycle can follow the artists whose tracks arrived.
export async function captureLifecycleSelection(flowId: string, jobs: FlowJob[]) {
  if (!isLifecycleEnabled()) return;
  await releaseCompletedLifecycleReservations(jobs);
  const { dbOps } = await import("../db/helpers/index.ts");
  const { flowPlaylistConfig } = await import("./playlists/flowPlaylistConfig.ts");
  const { db } = await import("../config/db-sqlite.ts");
  const flow = flowPlaylistConfig.getFlow(flowId);
  const generation = Math.max(0, ...jobs.map((job) => Number(job.playlistGeneration) || 0));
  const arrived = jobs.filter(
    (job) =>
      (Number(job.playlistGeneration) || 0) === generation &&
      job.status === "done" &&
      job.finalPath,
  );
  // Record every artist whose track actually arrived, even when other jobs of
  // the week never finished; otherwise one stuck job discarded the whole week.
  if (!flow || arrived.length === 0) return;
  const now = Date.now() / 1000;
  if (db.inTransaction) throw new Error("Lifecycle selection must commit before flow deletion");
  const previousSync = db.pragma("synchronous", { simple: true });
  db.pragma("synchronous=FULL");
  try {
    db.transaction(() => {
      const raw = db
        .prepare<[], { value: string }>(
          "SELECT value FROM settings WHERE key='lifecycleFlowSelections'",
        )
        .get();
      const stored = (raw ? JSON.parse(raw.value) : {}) as Record<string, FlowSelection>;
      stored[`${flowId}:${generation}`] ??= {
        flowId,
        generation,
        capturedAt: now,
        artists: arrived.map((job) => ({ mbid: job.artistMbid, name: job.artistName })),
      };
      for (const [id, event] of Object.entries(stored))
        if (event.capturedAt < now - 90 * 86400) delete stored[id];
      db.prepare(
        "INSERT INTO settings(key,value) VALUES ('lifecycleFlowSelections',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(JSON.stringify(stored));
    })();
  } finally {
    db.pragma(`synchronous=${String(previousSync)}`);
  }
  dbOps.invalidateSettingsCache();
}
