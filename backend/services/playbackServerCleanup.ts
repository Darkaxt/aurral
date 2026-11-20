import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import { logger } from "./logger.ts";

// Aurral used to publish playlists to Navidrome, Plex, and Jellyfin through
// their APIs. Playlist files replace them, so this forgets the old pointers and
// connections once.
//
// minipc fork: forget only, never delete. The old playlists on the media
// servers and the files listed in playbackRetainedFiles belong to the user's
// running library (and to the external music lifecycle), so this never calls a
// media server's delete API and never removes a file.

const SERVERS = ["navidrome", "plex", "jellyfin"] as const;
const POINTER_KEYS = [
  "navidromePlaylistPointers",
  "plexPlaylistPointers",
  "jellyfinPlaylistPointers",
] as const;
const LEGACY_KEYS = [...POINTER_KEYS, "plexConnections", "playbackRetainedFiles"];
const ATTEMPTS_KEY = "playbackServerCleanup";

const settingRow = db.prepare<[string], { value: string | null }>(
  "SELECT value FROM settings WHERE key = ?",
);
const deleteSetting = db.prepare<[string]>("DELETE FROM settings WHERE key = ?");
const plexIdentity = db.prepare(
  "SELECT 1 FROM user_identities WHERE provider_type = 'plex' LIMIT 1",
);
const deletePlexIdentities = db.prepare("DELETE FROM user_identities WHERE provider_type = 'plex'");

export function hasLegacyPlaybackServerData() {
  const integrations: Record<string, unknown> = dbOps.getSettings().integrations;
  return (
    SERVERS.some((server) => integrations[server] !== undefined) ||
    LEGACY_KEYS.some((key) => settingRow.get(key) !== undefined) ||
    plexIdentity.get() !== undefined
  );
}

export async function cleanUpPlaybackServers() {
  const integrations: Record<string, unknown> = { ...dbOps.getSettings().integrations };
  for (const server of SERVERS) delete integrations[server];
  dbOps.updateSettings({ integrations });
  for (const key of [...LEGACY_KEYS, ATTEMPTS_KEY]) deleteSetting.run(key);
  deletePlexIdentities.run();
  logger.info("playback", "Forgot old media server playlist pointers without deleting anything");
  return { pending: [] as string[], removedFiles: [] as string[] };
}
