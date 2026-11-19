import Database from "better-sqlite3";
import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveDownloadRoot } from "./downloadPaths.ts";

const owner=new AsyncLocalStorage<any>();
export class LifecycleHold extends Error { code="MUSIC_LIFECYCLE_HOLD"; }
export function isLifecycleHold(error:any) { return error?.code==="MUSIC_LIFECYCLE_HOLD"; }
const enabled=()=>process.env.AURRAL_LIFECYCLE_ENABLED==="true";
function openState() {
  const config=JSON.parse(fs.readFileSync(process.env.AURRAL_LIFECYCLE_CONFIG!,"utf8"));
  const db=new Database(process.env.AURRAL_LIFECYCLE_STATE!,{fileMustExist:true});
  db.pragma("synchronous=FULL");db.pragma("busy_timeout=5000");
  return {db,config};
}
function state(db:any,key:string) {
  const row=db.prepare("SELECT value FROM policy_state WHERE key=?").get(key);
  if(!row)throw new LifecycleHold("Lifecycle observation unavailable: "+key);
  return JSON.parse(row.value);
}
function metrics(db:any,config:any) {
  const now=Date.now()/1000,health=state(db,"health"),external=state(db,"external_work");
  const root=resolveDownloadRoot();
  if(health.uuid!==config.ssd_uuid || health.smart_passed!==true || now-health.checked_at<0 || now-health.checked_at>900 ||
    now-external.checked_at<0 || now-external.checked_at>900 || external.complete!==true)
    throw new LifecycleHold("Fresh complete SSD and queue observations are required");
  if(health.boot_id!==fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim() || fs.statSync(root).dev!==health.device)
    throw new LifecycleHold("SSD mount identity changed");
  const disk=fs.statfsSync(root);
  const mounted=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(line=>line.includes(' - '))
    .map(line=>{const [left,right]=line.split(' - ');return {fields:left.split(' '),filesystem:right.split(' ')};})
    .filter(row=>root===row.fields[4]||root.startsWith(row.fields[4]+'/')).sort((a,b)=>b.fields[4].length-a.fields[4].length)[0];
  if(Number(disk.type)!==0xef53 || !mounted || mounted.filesystem[0]!=='ext4' || !mounted.fields[5].split(',').includes('rw'))
    throw new LifecycleHold("Expected writable ext4 SSD is unavailable");
  return {available:Number(disk.bavail)*Number(disk.bsize),external:Number(external.bytes_remaining)};
}
export function reserveBatch(db:any,key:string,bytes:number,metrics:any,config:any,request:any) {
  return db.transaction(()=>{
    if(db.prepare("SELECT 1 FROM reservations WHERE identity=?").get(key))return false;
    const usage=db.prepare("SELECT count(*) count,coalesce(sum(bytes),0) bytes FROM reservations WHERE phase!='released'").get();
    const stopped=db.prepare("SELECT value FROM policy_state WHERE key='space_stopped'").get()?.value==="true";
    const remaining=metrics.available-metrics.external-usage.bytes;
    if(!Number.isSafeInteger(bytes)||bytes<=0||!Number.isSafeInteger(metrics.external)||metrics.external<0)return false;
    if(stopped&&remaining<config.resume_bytes)return false;
    if(remaining-bytes<config.reserve_bytes){
      db.prepare("INSERT INTO policy_state VALUES('space_stopped','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();return false;
    }
    if(usage.count>=config.max_inflight_acquisitions || usage.bytes+bytes>config.max_inflight_bytes)return false;
    db.prepare("INSERT INTO policy_state VALUES('space_stopped','false') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    db.prepare("INSERT INTO reservations VALUES(?,?,'dispatching',?,?)").run(key,bytes,JSON.stringify({request}),Date.now()/1000);
    return true;
  }).immediate();
}
export async function withLifecycleJob(payload:any,job:any,operation:()=>Promise<any>,jobIds:string[]=[payload.jobId]) {
  if(!enabled())return operation();
  const context={jobId:payload.jobId,jobIds,attempt:payload.downloadAttemptId||payload.playlistGeneration||0,albumGroupId:job?.albumMbid||null};
  if(!['search','download'].includes(payload.phase))
    return owner.run(context,operation);
  let db:any;
  try {
    ({db}=openState());
    if(['search','download'].includes(payload.phase)) {
      for(const mbid of [job?.albumMbid,job?.releaseMbid,payload.releaseMbid].filter(Boolean))
        if(db.prepare("SELECT 1 FROM evictions WHERE mbid=?").get(mbid))throw new LifecycleHold("Album was deliberately retired; explicit restore is required");
      const {config}=openConfig();
      if(payload.phase==='search'){
        const observed=metrics(db,config);
        const usage=db.prepare("SELECT coalesce(sum(bytes),0) bytes FROM reservations WHERE phase!='released'").get().bytes;
        const stopped=db.prepare("SELECT value FROM policy_state WHERE key='space_stopped'").get()?.value==='true';
        if(observed.available-observed.external-usage<(stopped?config.resume_bytes:config.reserve_bytes))throw new LifecycleHold("SSD admission reserve is occupied");
      }
      lifecycleSourceAllowed(payload.source,payload.phase);
    }
  } catch(error) {
    return {...payload,delaySeconds:60,lifecycleHold:isLifecycleHold(error)?(error as Error).message:'Lifecycle state unavailable; preserve the original queued job'};
  } finally { db?.close(); }
  try{return await owner.run(context,operation);}
  catch(error){if(isLifecycleHold(error))return {...payload,delaySeconds:60,lifecycleHold:(error as Error).message};throw error;}
}
export function lifecycleSourceAllowed(source:any,phase:string){
  if(enabled()&&['search','download'].includes(phase)&&source&&source!=='slskd')
    throw new LifecycleHold("This download source has no qualified bounded-size admission contract");
}
function openConfig(){return {config:JSON.parse(fs.readFileSync(process.env.AURRAL_LIFECYCLE_CONFIG!,"utf8"))};}

export function releaseCompletedInDatabase(db:any,statusOf:(id:string)=>string|undefined) {
  for(const row of db.prepare("SELECT identity,external_ids FROM reservations WHERE phase='active'").all()) {
    const owned=JSON.parse(row.external_ids||'{}')?.request?.owner;
    const ids=owned?.jobIds|| (owned?.jobId?[owned.jobId]:[]);
    if(ids.length && ids.every((id:string)=>statusOf(id)==='done'))
      db.prepare("UPDATE reservations SET phase='released' WHERE identity=?").run(row.identity);
  }
}
export async function releaseCompletedLifecycleReservations(jobs:any[]=[]) {
  if(!enabled()||!process.env.AURRAL_LIFECYCLE_STATE)return;
  const {db}=openState();
  try {
    const {db:native}=await import('../config/db-sqlite.ts');
    const observed=new Map(jobs.map(job=>[job.id,job.status]));
    releaseCompletedInDatabase(db,id=>observed.get(id)||native.prepare('SELECT status FROM playlist_download_jobs WHERE id=?').get(id)?.status);
  } finally {db.close();}
}

function transferRows(value:any):any[] {
  const rows:any[]=[];
  function visit(item:any,user:string|null=null){
    if(Array.isArray(item)){for(const child of item)visit(child,user);return;}
    if(!item||typeof item!=='object')return;
    user=item.username||user;
    if(item.id&&item.filename)rows.push({...item,username:user});
    for(const child of Object.values(item))if(typeof child==='object')visit(child,user);
  }
  visit(value);return rows;
}
function observedResponse(request:any,rows:any[]) {
  const matches=request.files.map((file:any)=>rows.filter(row=>row.username===request.username&&row.filename===file.filename&&Number(row.size)===file.size));
  if(matches.some((found:any[])=>found.length!==1))return null;
  return {username:request.username,transfers:matches.map((found:any[])=>found[0]),transferId:matches[0]?.[0].id};
}

export async function lifecycleBatch(username:string,files:any[],submit:()=>Promise<any>,observe:()=>Promise<any>) {
  if(!enabled())return submit();
  let db:any;
  try {
    const opened=openState();db=opened.db;const config=opened.config;
    const context=owner.getStore();
    if(!context)throw new LifecycleHold("Transfer requires its original Aurral job identity");
    const request={username,files,owner:context};
    const key="aurral:"+crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const prior=db.prepare("SELECT phase,external_ids FROM reservations WHERE identity=?").get(key);
    if(prior) {
      const saved=JSON.parse(prior.external_ids||"{}");
      if(prior.phase==='active' && saved.response)return saved.response;
      if(prior.phase==='released')throw new LifecycleHold("Original transfer is terminal; do not automatically replay it");
      const response=observedResponse(request,transferRows(await observe()));
      if(!response)throw new LifecycleHold("Original transfer dispatch outcome remains ambiguous; no duplicate POST");
      db.prepare("UPDATE reservations SET phase='active',external_ids=? WHERE identity=?").run(JSON.stringify({request,response}),key);
      return response;
    }
    // A retry token or changing album-group membership cannot erase the original
    // dispatch. Reconcile overlapping ownership before considering a new POST.
    const ids=new Set(context.jobIds||[context.jobId]);let observed:any[]|null=null;
    for(const row of db.prepare("SELECT identity,phase,external_ids FROM reservations WHERE phase!='released'").all()){
      const saved=JSON.parse(row.external_ids||'{}'),old=saved.request;
      if(!old?.owner || !(old.owner.jobIds||[old.owner.jobId]).some((id:string)=>ids.has(id)))continue;
      if(row.phase==='dispatching'){
        observed??=transferRows(await observe());
        saved.response=observedResponse(old,observed);
        if(!saved.response)throw new LifecycleHold("An overlapping original dispatch is unresolved; retain its request identity");
        db.prepare("UPDATE reservations SET phase='active',external_ids=? WHERE identity=?").run(JSON.stringify(saved),row.identity);
      }
      if(!saved.response?.transfers?.length)throw new LifecycleHold("Original transfer receipt is incomplete");
      if(old.username===username && JSON.stringify(old.files)===JSON.stringify(files))return saved.response;
      observed??=transferRows(await observe());
      const current=observedResponse(request,observed),oldIds=new Set(saved.response.transfers.map((item:any)=>item.id));
      if(current&&current.transfers.every((item:any)=>oldIds.has(item.id)))return current;
      if(saved.response.transfers.some((item:any)=>observed!.some(actual=>actual.id===item.id&&!String(actual.state||'').startsWith('Completed'))))
        throw new LifecycleHold("The original candidate still owns an active transfer");
      db.prepare("UPDATE reservations SET phase='released' WHERE identity=?").run(row.identity);
    }
    if(!context.albumGroupId && db.prepare('SELECT 1 FROM evictions LIMIT 1').get())
      throw new LifecycleHold('Stable album identity is required to check retirement exclusions');
    if(files.length===0||files.some(file=>!Number.isSafeInteger(file.size)||file.size<=0))throw new LifecycleHold("Unknown transfer size; hold for metadata");
    await releaseCompletedLifecycleReservations();
    const bytes=files.reduce((total,file)=>total+file.size,0)*config.transfer_reservation_factor;
    if(!reserveBatch(db,key,bytes,metrics(db,config),config,request))throw new LifecycleHold("SSD reservation or concurrency budget is occupied");
    try {
      const response=await submit();
      if(!Array.isArray(response?.transfers)||response.transfers.length!==files.length||response.transfers.some((item:any)=>!item.id))
        throw new LifecycleHold("Transfer receipt was incomplete; retain the original dispatch for observation");
      db.prepare("UPDATE reservations SET phase='active',external_ids=? WHERE identity=?").run(JSON.stringify({request,response}),key);
      return response;
    } catch(error) {
      if((error as any)?.lifecycleDefiniteReject===true){
        db.prepare("UPDATE reservations SET phase='released' WHERE identity=?").run(key);throw error;
      }
      throw new LifecycleHold("Transfer dispatch was not confirmed; retain its original reservation and inspect the native outcome");
    }
  } catch(error) {
    if(isLifecycleHold(error))throw error;
    if((error as any)?.lifecycleDefiniteReject===true)throw error;
    throw new LifecycleHold("Lifecycle state unavailable; preserve the queued operation");
  } finally {db?.close();}
}
