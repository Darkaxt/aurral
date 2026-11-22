import Database from "better-sqlite3";
import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveDownloadRoot } from "./downloadPaths.ts";

// minipc fork: download admission shared with the external music lifecycle.
//
// Off unless AURRAL_LIFECYCLE_ENABLED=true (the name the production overlay and
// the lifecycle's deployment already use). When on, every search and download
// step is admitted against the lifecycle's state database: a fresh SSD/queue
// observation, a bounded byte and slot budget, and the retirement list. Any
// state that cannot be read holds the step instead of downloading (fail closed).
// Only slskd has a bounded-size dispatch contract; every other source fails
// over like any other source failure.

type Db = Database.Database;
type Row = Record<string, unknown>;
type Owner = { jobId: string; jobIds: string[]; attempt: unknown; albumGroupId: string | null };
type TransferFile = { filename: string; size: number };
type TransferRequest = { username: string; files: TransferFile[]; owner: Owner };
type Transfer = Row & { id?: unknown; filename?: unknown; size?: unknown; username?: unknown };
type TransferResponse = { username: string; transfers: Transfer[]; transferId?: unknown };
type Saved = { request?: TransferRequest; response?: TransferResponse | null };
type Config = {
  ssd_uuid?: unknown;
  resume_bytes: number;
  reserve_bytes: number;
  max_inflight_acquisitions: number;
  max_inflight_bytes: number;
  transfer_reservation_factor: number;
};
type Metrics = { available: number; external: number };
type LifecyclePayload = {
  jobId: string;
  phase: string;
  downloadAttemptId?: string | null;
  playlistGeneration?: number | null;
  releaseMbid?: string | null;
};
type LifecycleJob = { albumMbid?: string | null; releaseMbid?: string | null } | null | undefined;

const owner = new AsyncLocalStorage<Owner>();
const ADMITTED_PHASES = ["search", "download"];
const HOLD_SECONDS = 60;

export class LifecycleHold extends Error {
  code = "MUSIC_LIFECYCLE_HOLD";
}
export function isLifecycleHold(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "MUSIC_LIFECYCLE_HOLD";
}
const isDefiniteReject = (error: unknown) =>
  (error as { lifecycleDefiniteReject?: unknown } | null)?.lifecycleDefiniteReject === true;
export const isLifecycleEnabled = () => process.env.AURRAL_LIFECYCLE_ENABLED === "true";

const parse = <T>(raw: unknown, fallback: T): T =>
  typeof raw === "string" && raw ? (JSON.parse(raw) as T) : fallback;

function readConfig(): Config {
  return JSON.parse(fs.readFileSync(process.env.AURRAL_LIFECYCLE_CONFIG!, "utf8")) as Config;
}
function openState() {
  const config = readConfig();
  const db = new Database(process.env.AURRAL_LIFECYCLE_STATE!, { fileMustExist: true });
  db.pragma("synchronous=FULL");
  db.pragma("busy_timeout=5000");
  return { db, config };
}
function state(db: Db, key: string): Row {
  const row = db.prepare("SELECT value FROM policy_state WHERE key=?").get(key) as Row | undefined;
  if (!row) throw new LifecycleHold("Lifecycle observation unavailable: " + key);
  return parse<Row>(row.value, {});
}
const spaceStopped = (db: Db) =>
  (db.prepare("SELECT value FROM policy_state WHERE key='space_stopped'").get() as Row | undefined)
    ?.value === "true";
const setSpaceStopped = (db: Db, stopped: boolean) =>
  db
    .prepare(
      "INSERT INTO policy_state VALUES('space_stopped',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(String(stopped));
const reservedUsage = (db: Db) =>
  db
    .prepare(
      "SELECT count(*) count,coalesce(sum(bytes),0) bytes FROM reservations WHERE phase!='released'",
    )
    .get() as { count: number; bytes: number };

function metrics(db: Db, config: Config): Metrics {
  const now = Date.now() / 1000;
  const health = state(db, "health");
  const external = state(db, "external_work");
  const root = resolveDownloadRoot();
  const healthAge = now - Number(health.checked_at);
  const externalAge = now - Number(external.checked_at);
  if (
    health.uuid !== config.ssd_uuid ||
    health.smart_passed !== true ||
    !(healthAge >= 0 && healthAge <= 900) ||
    !(externalAge >= 0 && externalAge <= 900) ||
    external.complete !== true
  )
    throw new LifecycleHold("Fresh complete SSD and queue observations are required");
  if (
    health.boot_id !== fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
    fs.statSync(root).dev !== health.device
  )
    throw new LifecycleHold("SSD mount identity changed");
  const disk = fs.statfsSync(root);
  const mounted = fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .filter((line) => line.includes(" - "))
    .map((line) => {
      const [left = "", right = ""] = line.split(" - ");
      return { fields: left.split(" "), filesystem: right.split(" ") };
    })
    .map((row) => ({ ...row, point: row.fields[4] ?? "", options: row.fields[5] ?? "" }))
    .filter((row) => row.point && (root === row.point || root.startsWith(row.point + "/")))
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (
    Number(disk.type) !== 0xef53 ||
    !mounted ||
    mounted.filesystem[0] !== "ext4" ||
    !mounted.options.split(",").includes("rw")
  )
    throw new LifecycleHold("Expected writable ext4 SSD is unavailable");
  return {
    available: Number(disk.bavail) * Number(disk.bsize),
    external: Number(external.bytes_remaining),
  };
}

export function reserveBatch(
  db: Db,
  key: string,
  bytes: number,
  observed: Metrics,
  config: Config,
  request: TransferRequest,
) {
  return db
    .transaction(() => {
      if (db.prepare("SELECT 1 FROM reservations WHERE identity=?").get(key)) return false;
      const usage = reservedUsage(db);
      const remaining = observed.available - observed.external - usage.bytes;
      if (!Number.isSafeInteger(bytes) || bytes <= 0) return false;
      if (!Number.isSafeInteger(observed.external) || observed.external < 0) return false;
      if (spaceStopped(db) && remaining < config.resume_bytes) return false;
      if (remaining - bytes < config.reserve_bytes) {
        setSpaceStopped(db, true);
        return false;
      }
      if (
        usage.count >= config.max_inflight_acquisitions ||
        usage.bytes + bytes > config.max_inflight_bytes
      )
        return false;
      setSpaceStopped(db, false);
      db.prepare("INSERT INTO reservations VALUES(?,?,'dispatching',?,?)").run(
        key,
        bytes,
        JSON.stringify({ request }),
        Date.now() / 1000,
      );
      return true;
    })
    .immediate();
}

const holdPayload = <P>(payload: P, reason: string) => ({
  ...payload,
  delaySeconds: HOLD_SECONDS,
  lifecycleHold: reason,
});

// Runs one pipeline step under the job's lifecycle identity. A search or
// download step is admitted first; a step that cannot be admitted keeps its
// original queued payload and runs again in a minute.
export async function withLifecycleJob<P extends LifecyclePayload, R>(
  payload: P,
  job: LifecycleJob,
  operation: () => Promise<R>,
  jobIds: string[] = [payload.jobId],
): Promise<R | (P & { delaySeconds: number; lifecycleHold: string })> {
  if (!isLifecycleEnabled()) return operation();
  const context: Owner = {
    jobId: payload.jobId,
    jobIds,
    attempt: payload.downloadAttemptId || payload.playlistGeneration || 0,
    albumGroupId: job?.albumMbid || null,
  };
  if (!ADMITTED_PHASES.includes(payload.phase)) return owner.run(context, operation);
  let db: Db | undefined;
  try {
    const opened = openState();
    db = opened.db;
    for (const mbid of [job?.albumMbid, job?.releaseMbid, payload.releaseMbid].filter(Boolean))
      if (db.prepare("SELECT 1 FROM evictions WHERE mbid=?").get(mbid))
        throw new LifecycleHold("Album was deliberately retired; explicit restore is required");
    if (payload.phase === "search") {
      const observed = metrics(db, opened.config);
      const reserved = reservedUsage(db).bytes;
      const floor = spaceStopped(db) ? opened.config.resume_bytes : opened.config.reserve_bytes;
      if (observed.available - observed.external - reserved < floor)
        throw new LifecycleHold("SSD admission reserve is occupied");
    }
    // Source admission is decided in the pipeline, where a disallowed source
    // fails over like any other source failure instead of holding forever.
  } catch (error) {
    return holdPayload(
      payload,
      isLifecycleHold(error)
        ? (error as Error).message
        : "Lifecycle state unavailable; preserve the original queued job",
    );
  } finally {
    db?.close();
  }
  try {
    return await owner.run(context, operation);
  } catch (error) {
    if (isLifecycleHold(error)) return holdPayload(payload, (error as Error).message);
    throw error;
  }
}

export const LIFECYCLE_SOURCE_REJECTED =
  "This download source has no qualified bounded-size admission contract";
export function isLifecycleSourceAllowed(source: unknown, phase: unknown) {
  return !(
    isLifecycleEnabled() &&
    ADMITTED_PHASES.includes(String(phase)) &&
    source &&
    source !== "slskd"
  );
}

export function releaseCompletedInDatabase(db: Db, statusOf: (id: string) => string | undefined) {
  const rows = db
    .prepare("SELECT identity,external_ids FROM reservations WHERE phase='active'")
    .all() as Row[];
  for (const row of rows) {
    const owned = parse<Saved>(row.external_ids, {}).request?.owner;
    const ids = owned?.jobIds || (owned?.jobId ? [owned.jobId] : []);
    if (ids.length && ids.every((id) => statusOf(id) === "done"))
      db.prepare("UPDATE reservations SET phase='released' WHERE identity=?").run(row.identity);
  }
}
export async function releaseCompletedLifecycleReservations(
  jobs: { id: string; status: string }[] = [],
) {
  if (!isLifecycleEnabled() || !process.env.AURRAL_LIFECYCLE_STATE) return;
  const { db } = openState();
  try {
    const { db: native } = await import("../config/db-sqlite.ts");
    const observed = new Map(jobs.map((job) => [job.id, job.status]));
    const status = native.prepare<[string], { status?: string }>(
      "SELECT status FROM download_jobs WHERE id=?",
    );
    releaseCompletedInDatabase(db, (id) => observed.get(id) || status.get(id)?.status);
  } finally {
    db.close();
  }
}

function transferRows(value: unknown): Transfer[] {
  const rows: Transfer[] = [];
  function visit(item: unknown, user: unknown = null) {
    if (Array.isArray(item)) {
      for (const child of item) visit(child, user);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as Transfer;
    user = record.username || user;
    if (record.id && record.filename) rows.push({ ...record, username: user });
    for (const child of Object.values(record)) if (typeof child === "object") visit(child, user);
  }
  visit(value);
  return rows;
}
function observedResponse(request: TransferRequest, rows: Transfer[]): TransferResponse | null {
  const matches = request.files.map((file) =>
    rows.filter(
      (row) =>
        row.username === request.username &&
        row.filename === file.filename &&
        Number(row.size) === file.size,
    ),
  );
  if (matches.some((found) => found.length !== 1)) return null;
  const transfers = matches.flat();
  return { username: request.username, transfers, transferId: transfers[0]?.id };
}

// Wraps one slskd batch enqueue in a lifecycle reservation. The reservation
// identity is the exact request, so a retried or ambiguous dispatch is
// reconciled against slskd's transfer list and never POSTed twice.
export async function lifecycleBatch<T>(
  username: string,
  files: TransferFile[],
  submit: () => Promise<T>,
  observe: () => Promise<unknown>,
): Promise<T> {
  // A replayed or observed receipt has the shape slskd's enqueue answer has.
  const receipt = (response: TransferResponse) => response as T;
  if (!isLifecycleEnabled()) return submit();
  let db: Db | undefined;
  try {
    const opened = openState();
    db = opened.db;
    const config = opened.config;
    const context = owner.getStore();
    if (!context) throw new LifecycleHold("Transfer requires its original Aurral job identity");
    const request: TransferRequest = { username, files, owner: context };
    const key =
      "aurral:" + crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const prior = db
      .prepare("SELECT phase,external_ids FROM reservations WHERE identity=?")
      .get(key) as Row | undefined;
    if (prior) {
      const saved = parse<Saved>(prior.external_ids, {});
      if (prior.phase === "active" && saved.response) return receipt(saved.response);
      if (prior.phase === "released") {
        // The identical request was dispatched before and its reservation has
        // been released. Never POST it again. Holding it, though, would retry
        // the same request every minute forever. Instead, reuse a finished
        // transfer, wait for one that is still running, or give up on this
        // candidate so the pipeline moves on to the next one.
        const earlier = observedResponse(request, transferRows(await observe()));
        const states = earlier?.transfers.map((item) => String(item.state || "")) ?? [];
        if (earlier && states.some((value) => !value.startsWith("Completed")))
          throw new LifecycleHold("The original candidate still owns an active transfer");
        if (earlier && states.every((value) => value === "Completed, Succeeded"))
          return receipt(earlier);
        throw Object.assign(
          new Error(
            "Original transfer is terminal; trying the next candidate instead of replaying it",
          ),
          { lifecycleDefiniteReject: true },
        );
      }
      const response = observedResponse(request, transferRows(await observe()));
      if (!response)
        throw new LifecycleHold(
          "Original transfer dispatch outcome remains ambiguous; no duplicate POST",
        );
      db.prepare("UPDATE reservations SET phase='active',external_ids=? WHERE identity=?").run(
        JSON.stringify({ request, response }),
        key,
      );
      return receipt(response);
    }
    // A retry token or changing album-group membership cannot erase the original
    // dispatch. Reconcile overlapping ownership before considering a new POST.
    const ids = new Set(context.jobIds || [context.jobId]);
    let observed: Transfer[] | null = null;
    const open = db
      .prepare("SELECT identity,phase,external_ids FROM reservations WHERE phase!='released'")
      .all() as Row[];
    for (const row of open) {
      const saved = parse<Saved>(row.external_ids, {});
      const old = saved.request;
      if (!old?.owner || !(old.owner.jobIds || [old.owner.jobId]).some((id) => ids.has(id)))
        continue;
      if (row.phase === "dispatching") {
        observed ??= transferRows(await observe());
        saved.response = observedResponse(old, observed);
        if (!saved.response)
          throw new LifecycleHold(
            "An overlapping original dispatch is unresolved; retain its request identity",
          );
        db.prepare("UPDATE reservations SET phase='active',external_ids=? WHERE identity=?").run(
          JSON.stringify(saved),
          row.identity,
        );
      }
      if (!saved.response?.transfers?.length)
        throw new LifecycleHold("Original transfer receipt is incomplete");
      if (old.username === username && JSON.stringify(old.files) === JSON.stringify(files))
        return receipt(saved.response);
      observed ??= transferRows(await observe());
      const current = observedResponse(request, observed);
      const oldIds = new Set(saved.response.transfers.map((item) => item.id));
      if (current && current.transfers.every((item) => oldIds.has(item.id)))
        return receipt(current);
      const live = observed;
      if (
        saved.response.transfers.some((item) =>
          live.some(
            (actual) =>
              actual.id === item.id && !String(actual.state || "").startsWith("Completed"),
          ),
        )
      )
        throw new LifecycleHold("The original candidate still owns an active transfer");
      db.prepare("UPDATE reservations SET phase='released' WHERE identity=?").run(row.identity);
    }
    if (!context.albumGroupId && db.prepare("SELECT 1 FROM evictions LIMIT 1").get())
      throw new LifecycleHold("Stable album identity is required to check retirement exclusions");
    if (
      files.length === 0 ||
      files.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0)
    )
      throw new LifecycleHold("Unknown transfer size; hold for metadata");
    await releaseCompletedLifecycleReservations();
    const bytes =
      files.reduce((total, file) => total + file.size, 0) * config.transfer_reservation_factor;
    if (!reserveBatch(db, key, bytes, metrics(db, config), config, request))
      throw new LifecycleHold("SSD reservation or concurrency budget is occupied");
    try {
      const response = await submit();
      const transfers = (response as { transfers?: Transfer[] } | null)?.transfers;
      if (
        !Array.isArray(transfers) ||
        transfers.length !== files.length ||
        transfers.some((item) => !item.id)
      )
        throw new LifecycleHold(
          "Transfer receipt was incomplete; retain the original dispatch for observation",
        );
      db.prepare("UPDATE reservations SET phase='active',external_ids=? WHERE identity=?").run(
        JSON.stringify({ request, response }),
        key,
      );
      return response;
    } catch (error) {
      if (isDefiniteReject(error)) {
        db.prepare("UPDATE reservations SET phase='released' WHERE identity=?").run(key);
        throw error;
      }
      throw new LifecycleHold(
        "Transfer dispatch was not confirmed; retain its original reservation and inspect the native outcome",
      );
    }
  } catch (error) {
    if (isLifecycleHold(error) || isDefiniteReject(error)) throw error;
    throw new LifecycleHold("Lifecycle state unavailable; preserve the queued operation");
  } finally {
    db?.close();
  }
}
