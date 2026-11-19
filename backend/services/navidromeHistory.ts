import fs from "node:fs";
import Database from "better-sqlite3";

type Period = { start: number; end: number };
type PlayRow = {
  id: number; submission_time: number; title: string | null; artist: string | null;
  album: string | null; duration: number | null; mbz_recording_id: string | null;
  artist_mbid: string | null; mbz_album_id: string | null;
};

export class NavidromeHistoryError extends Error {}

export function requireNavidromeHistoryAccount(userId: number, account: string) {
  const filename = process.env.AURRAL_NAVIDROME_HISTORY_MAPPINGS;
  if (!filename) throw new NavidromeHistoryError("Navidrome listening history is not configured");
  try {
    const mappings = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (mappings.version !== 1 || mappings.users?.[String(userId)] !== account.trim())
      throw new NavidromeHistoryError("This Navidrome listening account is not assigned to you");
  } catch (error) {
    if (error instanceof NavidromeHistoryError) throw error;
    throw new NavidromeHistoryError("Navidrome listening account configuration is unavailable");
  }
  return account.trim();
}

export function hasNavidromeHistoryMapping(userId: number) {
  const filename = process.env.AURRAL_NAVIDROME_HISTORY_MAPPINGS;
  if (!filename) return false;
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (value.version !== 1 || !value.users || typeof value.users !== "object") return true;
    return typeof value.users[String(userId)] === "string";
  } catch {
    // Configured but unreadable state must not enable an implicit service-user fallback.
    return true;
  }
}

function withHistory<T>(userId: number, account: string, read: (db: Database.Database, nativeUserId: string) => T): T {
  requireNavidromeHistoryAccount(userId, account);
  const filename = process.env.AURRAL_NAVIDROME_HISTORY_DB;
  if (!filename) throw new NavidromeHistoryError("Navidrome listening history is unavailable");
  let db: Database.Database | undefined;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    db.exec("BEGIN");
    const listener = db.prepare("SELECT id FROM user WHERE user_name = ?").get(account) as { id: string } | undefined;
    if (!listener) throw new NavidromeHistoryError("The assigned Navidrome listener is unavailable");
    return read(db, listener.id);
  } catch (error) {
    if (error instanceof NavidromeHistoryError) throw error;
    throw new NavidromeHistoryError("Navidrome listening history is unavailable");
  } finally {
    db?.close();
  }
}

export function periodStart(period: string, now = Date.now()) {
  if (period === "overall") return 0;
  if (period === "7day") return now - 7 * 86400000;
  const months = ({ "1month": 1, "3month": 3, "6month": 6, "12month": 12 } as Record<string, number>)[period];
  if (!months) throw new NavidromeHistoryError("Unsupported listening-history period");
  const date = new Date(now), day = date.getUTCDate();
  date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));return date.getTime();
}

export function getNavidromeTopArtists(userId: number, account: string, period: string, { now = Date.now(), limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new NavidromeHistoryError("Invalid artist limit");
  const start = periodStart(period, now);
  return withHistory(userId, account, (db, nativeUserId) => db.prepare(`
    SELECT NULLIF(a.mbz_artist_id, '') AS mbid,
      COALESCE(NULLIF(a.name, ''), m.artist) AS artistName, COUNT(*) AS playcount
    FROM scrobbles s JOIN media_file m ON m.id = s.media_file_id
    LEFT JOIN artist a ON a.id = m.artist_id
    WHERE s.user_id = ? AND s.submission_time >= ? AND s.submission_time < ?
      AND trim(COALESCE(NULLIF(a.name, ''), m.artist, '')) <> ''
    GROUP BY COALESCE(NULLIF(a.mbz_artist_id, ''), NULLIF(m.artist_id, ''), lower(trim(m.artist)))
    ORDER BY playcount DESC, artistName COLLATE NOCASE, COALESCE(a.mbz_artist_id, m.artist_id)
    LIMIT ?`).all(nativeUserId, Math.ceil(start / 1000), Math.ceil(now / 1000), limit) as
      { mbid: string | null; artistName: string; playcount: number }[]);
}

export function readNavidromePlays(userId: number, account: string, period: Period) {
  if (!Number.isFinite(period.start) || !Number.isFinite(period.end) || period.end <= period.start)
    throw new NavidromeHistoryError("Invalid listening-history period");
  return withHistory(userId, account, (db, nativeUserId) => {
    const rows = db.prepare(`SELECT s.id, s.submission_time, m.title, m.artist, m.album,
      m.duration, m.mbz_recording_id, a.mbz_artist_id AS artist_mbid, m.mbz_album_id
      FROM scrobbles s LEFT JOIN media_file m ON m.id = s.media_file_id
      LEFT JOIN artist a ON a.id = m.artist_id
      WHERE s.user_id = ? AND s.submission_time >= ? AND s.submission_time < ?
      ORDER BY s.submission_time, s.id`).all(nativeUserId, Math.ceil(period.start / 1000), Math.ceil(period.end / 1000)) as PlayRow[];
    return rows.map((row) => ({
      source: "navidrome" as const, account, id: String(row.id), playedAt: row.submission_time * 1000,
      title: row.title || "", artist: row.artist || "", album: row.album || "",
      durationMs: row.duration ? row.duration * 1000 : undefined,
      trackMbid: row.mbz_recording_id || null, artistMbid: row.artist_mbid || null, albumMbid: row.mbz_album_id || null,
    }));
  });
}
