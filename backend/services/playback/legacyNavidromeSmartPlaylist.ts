import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { getPathMappings, resolveLocalPath } from "../pathMappings.ts";

const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

/**
 * Flows published in the preserved legacy layout are Navidrome smart playlists
 * imported from `AurralFlows/[A] <flow>.nsp`. Their rules (filepath contains the
 * flow id) own the membership, so Subsonic refuses track edits ("playlist tracks
 * are not editable") even for an administrator. Returns true when `playlistId`
 * is exactly that flow's rule-managed list; throws when a smart list claims the
 * flow but no longer matches its source, so it is never silently overwritten.
 *
 * The same media is mounted twice in the container (`/music` read-only, the
 * download root read-write), and path mapping keeps whichever path exists, so
 * the source is compared by file identity rather than by path string.
 */
export async function isManagedLegacyFlowPlaylist(
  downloadRoot: string,
  playlistId: string,
  entityId: string,
  flowName: string,
) {
  if (process.env.AURRAL_PRESERVE_LEGACY_MEDIA_LAYOUT !== "true") return false;
  const filename = process.env.AURRAL_LIFECYCLE_NAVIDROME_DB;
  if (!filename) throw new Error("Navidrome playlist metadata is unavailable");
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  let row: { path: string; sync: number; rules: string | null } | undefined;
  try {
    row = db.prepare("SELECT path, sync, rules FROM playlist WHERE id = ?").get(playlistId) as
      | typeof row
      | undefined;
  } finally {
    db.close();
  }
  if (!row?.sync || !row.rules || path.extname(row.path).toLowerCase() !== ".nsp") return false;
  const safeName = flowName.replace(/[<>:"/\\|?*]/g, "_").trim();
  const expected = path.join(path.resolve(downloadRoot), "AurralFlows", `[A] ${safeName}.nsp`);
  const local = path.resolve(resolveLocalPath(row.path, getPathMappings("navidrome")));
  const [localInfo, expectedInfo] = await Promise.all([
    fs.lstat(local).catch(() => null),
    fs.lstat(expected).catch(() => null),
  ]);
  if (
    !localInfo?.isFile() ||
    !expectedInfo?.isFile() ||
    (await fs.realpath(local)) !== local ||
    !sameFile(localInfo, expectedInfo)
  )
    throw new Error("Imported smart-playlist source is not this flow's managed file");
  const source = JSON.parse(await fs.readFile(local, "utf8"));
  const stored = JSON.parse(row.rules);
  const targetsFlow = (rules: { all?: { contains?: { filepath?: unknown } }[] }) =>
    Array.isArray(rules?.all) && rules.all.some((rule) => rule?.contains?.filepath === entityId);
  if (!targetsFlow(source) || !targetsFlow(stored))
    throw new Error("Imported smart-playlist rules no longer identify this flow");
  return true;
}
