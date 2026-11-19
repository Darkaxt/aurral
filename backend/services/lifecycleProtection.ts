import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { releaseCompletedLifecycleReservations } from './lifecycleAdmission.ts';

// Called by the app's existing pre-removal guard, including retained-file retries.
// Keep original paths: Navidrome IDs, stars and playlist references stay valid.
export function nativeProtectionReason(db: any, file: string, config: any): string | null {
  const relative = path.relative(path.resolve(config.aurral_music_root), path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "lifecycle-unknown-path";
  const nativePath = relative.split(path.sep).join("/");
  const track = db.prepare("SELECT id,album_id,artist_id,album_artist_id FROM media_file WHERE path=? AND missing=0").get(nativePath);
  if (!track) return "lifecycle-unindexed-path";
  const ownAlbum=db.prepare("SELECT id,mbz_album_id,mbz_release_group_id FROM album WHERE id=?").get(track.album_id);
  if(!ownAlbum)return "lifecycle-unknown-album";
  const albums=db.prepare("SELECT id,mbz_album_id,mbz_release_group_id FROM album WHERE id=? OR (?<>'' AND mbz_release_group_id=?)")
    .all(track.album_id,ownAlbum.mbz_release_group_id||'',ownAlbum.mbz_release_group_id||'');
  const placeholders=albums.map(()=>'?').join(',');const ids=albums.map((row:any)=>row.id);
  const members=db.prepare(`SELECT id,artist_id,album_artist_id FROM media_file WHERE album_id IN (${placeholders})`).all(...ids);
  const artistIds=new Set(members.flatMap((row:any)=>[row.artist_id,row.album_artist_id]).filter(Boolean));
  for(const row of db.prepare(`SELECT ma.artist_id FROM media_file_artists ma JOIN media_file m ON m.id=ma.media_file_id WHERE m.album_id IN (${placeholders}) AND ma.role IN ('artist','albumartist')`).all(...ids))artistIds.add(row.artist_id);
  const artistMbids=new Set([...artistIds].map(id=>db.prepare('SELECT mbz_artist_id FROM artist WHERE id=?').get(id)?.mbz_artist_id).filter(Boolean));
  const memberIds=new Set(members.map((row:any)=>row.id));
  const serviceUsers=new Set(config.service_users || []);
  const stars=db.prepare('SELECT u.user_name,a.item_type,a.item_id FROM annotation a JOIN user u ON u.id=a.user_id WHERE a.starred').all();
  if(stars.some((row:any)=>!serviceUsers.has(row.user_name) && (
    row.item_type==='media_file'&&memberIds.has(row.item_id) || row.item_type==='album'&&ids.includes(row.item_id) ||
    row.item_type==='artist'&&(artistIds.has(row.item_id)||artistMbids.has(db.prepare('SELECT mbz_artist_id FROM artist WHERE id=?').get(row.item_id)?.mbz_artist_id)))))
      return "lifecycle-favourite-album";
  const excluded = new Set(config.generated_playlist_ids || []);
  const references = db.prepare(`SELECT DISTINCT p.id,u.user_name FROM playlist_tracks pt
    JOIN playlist p ON p.id=pt.playlist_id JOIN user u ON u.id=p.owner_id JOIN media_file m ON m.id=pt.media_file_id
    WHERE m.album_id IN (${placeholders})`).all(...ids);
  if (references.some((row:any) => (config.keep_playlist_ids || []).includes(row.id) ||
      (!excluded.has(row.id) && !serviceUsers.has(row.user_name)))) return "lifecycle-retained-playlist-album";
  if ((config.keep_album_mbids || []).some((id:string) => albums.some((album:any)=>id===album.mbz_album_id || id===album.mbz_release_group_id)))
    return "lifecycle-explicit-album";
  if ([...artistMbids].some(id=>(config.keep_artist_mbids||[]).includes(id))) return "lifecycle-explicit-artist";
  return null;
}

export async function lifecycleProtectionReason(file:string):Promise<string|null> {
  if (process.env.AURRAL_LIFECYCLE_ENABLED!=="true") return null;
  let db:any;
  try {
    const config=JSON.parse(fs.readFileSync(process.env.AURRAL_LIFECYCLE_CONFIG!,"utf8"));
    const { flowPlaylistConfig }=await import("./playlists/flowPlaylistConfig.ts");
    const { navidromePlaylistPointerStore }=await import("./navidrome/navidromePlaylistPointerStore.ts");
    const generated=flowPlaylistConfig.getFlows().flatMap((flow:any)=>
      navidromePlaylistPointerStore.getPointersForEntity(flow.id).map((pointer:any)=>pointer.playlistId).filter(Boolean));
    config.generated_playlist_ids=[...(config.generated_playlist_ids || []),...generated];
    db=new Database(process.env.AURRAL_LIFECYCLE_NAVIDROME_DB!,{readonly:true,fileMustExist:true});
    return nativeProtectionReason(db,file,config);
  } catch {
    // An unreadable source cannot authorize deleting a favourite.
    return "lifecycle-native-state-unavailable";
  } finally { db?.close(); }
}

export async function captureLifecycleSelection(flowId:string,jobs:any[]) {
  if (process.env.AURRAL_LIFECYCLE_ENABLED!=="true") return;
  await releaseCompletedLifecycleReservations(jobs);
  const { dbOps }=await import("../db/helpers/index.ts");
  const { flowPlaylistConfig }=await import("./playlists/flowPlaylistConfig.ts");
  const { db }=await import("../config/db-sqlite.ts");
  const flow=flowPlaylistConfig.getFlow(flowId);
  const generation=Math.max(...jobs.map(job=>Number(job.playlistGeneration)||0));
  const current=jobs.filter(job=>(Number(job.playlistGeneration)||0)===generation);
  // Called at the weekly reset, right before the generation's jobs are deleted.
  // Record every artist whose track actually arrived, even when other jobs of
  // the week never finished; otherwise one stuck job discarded the whole week.
  if (!flow || !current.some(job=>job.status==='done' && job.finalPath)) return;
  const now=Date.now()/1000;
  if (db.inTransaction) throw new Error("Lifecycle selection must commit before flow deletion");
  const previousSync=db.pragma("synchronous",{simple:true});
  db.pragma("synchronous=FULL");
  try { db.transaction(()=>{
    const raw=db.prepare("SELECT value FROM settings WHERE key='lifecycleFlowSelections'").get() as any;
    const stored=raw?JSON.parse(raw.value):{};
    const key=flowId+":"+generation;
    stored[key]??={flowId,generation,capturedAt:now,artists:current.filter(job=>job.status==='done' && job.finalPath)
      .map(job=>({mbid:job.artistMbid,name:job.artistName}))};
    for (const [id,event] of Object.entries(stored) as [string,any][])
      if (event.capturedAt<now-90*86400) delete stored[id];
    db.prepare("INSERT INTO settings(key,value) VALUES ('lifecycleFlowSelections',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(stored));
  })(); } finally { db.pragma("synchronous="+previousSync); }
  dbOps.invalidateSettingsCache();
}
