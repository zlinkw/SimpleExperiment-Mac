import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { LegacyHostOperationLeaseManager, defaultHostOperationLeasePath } from "../core/HostOperationLease";
import { readResourceLeaseRegistryWithOwnership } from "../core/ResourceOperationLease";

const execFileAsync = promisify(execFile);

export const UPDATE_ACTION = "paired-plugin-update";
// Reuse proof requires a trusted, non-future start time later than every known bound by more than this margin.
const REUSE_PROOF_MARGIN_MS = 5_000;
// One bounded batch per wait() run; the probe never extends the 300s budget (R55: timeout = min(cap, remaining)).
const PROBE_TIMEOUT_CAP_MS = 8_000;
const WAIT_BUDGET_MS = 300_000;
const START_TIMES_MAX_BUFFER = 1 << 20;
const START_TIMES_MAX_PIDS = 256;
const MAX_VALID_PID = 2 ** 31 - 1;

/** R63 (plan r20/F22): per-PID observation. A number is a trusted start time; "exited" is ONLY produced by a
 * complete trustworthy OS enumeration that provably omits the PID (same exit proof as ESRCH); everything else —
 * EPERM, missing rows from failed queries, incomplete/failed/aborted snapshots — stays "unknown" and waits. */
export type ProcessObservation = number | "unknown" | "exited";
export type ProcessSnapshot = { present: Set<number>; times: Map<number, number> };

export type UpdateGateDependencies = {
  /** Test seam (plan r13 §4): synchronous start time in epoch ms; untrusted values are treated as no time source. */
  processStartedAt?: (pid: number) => number | undefined;
  /** Batch provider override (plan r14/R55, R63 type widened): one bounded async query; timeoutMs is already min(cap, remaining budget). */
  processStartTimes?: (pids: number[], signal?: AbortSignal, timeoutMs?: number) => Promise<Map<number, ProcessObservation>>;
  /** Read-only observation latch (plan r15 R56): fired once per completed poll pass that is about to sleep. */
  onPoll?: (info: { probing: number }) => void;
};

function validPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_VALID_PID ? value : undefined;
}
function windowIdPid(windowId: unknown): number | undefined {
  if (typeof windowId !== "string") return undefined;
  const segment = windowId.split(":")[1] ?? "";
  if (!/^[0-9]+$/.test(segment)) return undefined;
  return validPid(Number(segment));
}
/** Only a trusted in-range non-future epoch ms counts (R51/R54). Understands explicit epoch numbers/strings,
 * legacy PowerShell "/Date(ms)/" JSON, and explicit ISO; anything else (including Date.parse of /Date/) is untrusted. */
export function parseProcessStartMs(value: unknown, nowMs: number): number | undefined {
  let ms: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) ms = value;
  else if (typeof value === "string") {
    const trimmed = value.trim();
    const dated = /^\/Date\((-?[0-9]+)\)\/$/.exec(trimmed); // host-verified shape "/Date(ms)/" — closing ")" then "/" (r19 fix approved in r16)
    if (/^-?[0-9]+$/.test(trimmed)) ms = Number(trimmed);
    else if (dated) ms = Number(dated[1]);
    else { const parsed = Date.parse(trimmed); if (Number.isFinite(parsed)) ms = parsed; }
  }
  if (ms === undefined || !Number.isSafeInteger(ms) || ms <= 0 || ms > nowMs) return undefined; // non-safe-integer/out-of-range/future never trusted
  return ms;
}
/** Parses the default provider's JSON: [{Id,StartMs}] with StartMs as explicit Unix milliseconds (R51). */
export function parseStartTimesOutput(stdout: string, nowMs: number): Map<number, number> {
  const out = new Map<number, number>();
  const parsed = JSON.parse(String(stdout).trim() || "[]");
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    const pid = Number.isInteger(row?.Id) ? validPid(row.Id) : validPid(Number(row?.Id));
    const start = parseProcessStartMs(row?.StartMs ?? row?.StartTime, nowMs);
    if (pid !== undefined && start !== undefined) out.set(pid, start);
  }
  return out;
}
/** R63 (plan r20/F22): ONE bounded full-enumeration snapshot per wait() run. The old per-PID `Get-Process -Id a,b`
 * exits 1 when ANY pid is missing and swallowed every valid row in the batch (host F22: 3 valid epochs lost).
 * $PID is a read-only PowerShell automatic variable — the foreach loop variable is $proc, never $PID.
 * Explicit epoch ms via DateTimeOffset (R51 host proof: bare StartTime serializes as /Date(ms)/, Date.parse=NaN). */
export function enumerationCommand(): string {
  return "$ErrorActionPreference='Stop'; $ids=New-Object System.Collections.Generic.List[int]; $rows=@(); " +
    "foreach ($proc in [System.Diagnostics.Process]::GetProcesses()) { $ids.Add($proc.Id); " +
    "try { $rows += [pscustomobject]@{ Id = $proc.Id; StartMs = ([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds() } } catch { } }; " +
    "ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ schemaVersion=1; complete=$true; queryPid=$PID; processIds=$ids; rows=$rows })";
}
/** Trustworthy envelope ONLY (r20 #2): exit-0 is enforced by the caller's execFile throw; here every structural
 * doubt — bad JSON, legacy array/object shape, wrong schemaVersion, complete!==true, invalid queryPid, any invalid
 * member ID (system PID 0 legal), or the querying process itself absent from the full set — yields undefined,
 * which can never produce an exit proof. Rows for PIDs outside the full set are ignored. */
export function parseProcessSnapshot(stdout: string, nowMs: number): ProcessSnapshot | undefined {
  let parsed: any;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (parsed.schemaVersion !== 1 || parsed.complete !== true) return undefined;
  if (validPid(parsed.queryPid) === undefined) return undefined; // plan r21 #5: query PID in the declared OS-valid domain
  if (!Array.isArray(parsed.processIds)) return undefined;
  const present = new Set<number>();
  for (const value of parsed.processIds) {
    // Members allow PID 0 only; every other member must be a validPid (r21 #5: 1e20/2^31 are NOT legal OS PIDs).
    if (!(value === 0 || validPid(value) !== undefined)) return undefined; // one bad member ID invalidates the whole set
    present.add(value);
  }
  if (!present.has(parsed.queryPid)) return undefined; // self absent ⇒ the snapshot cannot vouch for its own view
  const times = new Map<number, number>();
  for (const row of Array.isArray(parsed.rows) ? parsed.rows : []) {
    const id = Number.isInteger(row?.Id) ? row.Id : Number(row?.Id);
    const start = parseProcessStartMs(row?.StartMs, nowMs);
    if (Number.isInteger(id) && id >= 0 && present.has(id) && start !== undefined) times.set(id, start);
  }
  return { present, times };
}
/** Requested PIDs → observations: trusted time when present with a readable start; "exited" ONLY when the
 * trustworthy full set omits the PID; present-but-unreadable-start (EPERM-style) stays unknown (waits). */
export function observationsFromSnapshot(snapshot: ProcessSnapshot | undefined, requested: readonly number[]): Map<number, ProcessObservation> {
  const out = new Map<number, ProcessObservation>(requested.map((pid): [number, ProcessObservation] => [pid, "unknown"]));
  if (!snapshot) return out; // no trustworthy envelope: never an exit proof
  for (const pid of requested) {
    const start = snapshot.times.get(pid);
    if (start !== undefined) out.set(pid, start);
    else if (!snapshot.present.has(pid)) out.set(pid, "exited");
  }
  return out;
}
/** Default Windows provider: exactly ONE bounded async full enumeration per wait() run (never per file, never host
 * snapshots); timeout bounded by caller; failure/timeout/abort/truncated-or-oversized output ⇒ all unknown, never an exit proof. */
async function defaultStartTimes(pids: number[], signal: AbortSignal | undefined, timeoutMs: number): Promise<Map<number, ProcessObservation>> {
  const batch = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))].sort((a, b) => a - b).slice(0, START_TIMES_MAX_PIDS);
  if (!batch.length || timeoutMs <= 0) return observationsFromSnapshot(undefined, batch);
  if (process.platform !== "win32") return observationsFromSnapshot(undefined, batch); // No trustworthy time source here: stay unknown/wait.
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", enumerationCommand()],
      { timeout: timeoutMs, maxBuffer: START_TIMES_MAX_BUFFER, signal, windowsHide: true });
    return observationsFromSnapshot(parseProcessSnapshot(stdout, Date.now()), batch);
  } catch { return observationsFromSnapshot(undefined, batch); } // failure, timeout, abort or oversized output keeps every pid unknown
}
type ProofCandidate = { pid: number; boundMs: number | undefined };

/** Upper bound the old owner could not have started after; undefined (no proof possible) if ANY referenced
 * time is missing/invalid (R54: never fabricate a bound with ||0). admissionExpiresAt absent means 0. */
function proofBoundMs(record: any, mtimeMs: number): number | undefined {
  let bound = mtimeMs;
  { // R61 (plan r16/r17): admission must be a non-negative safe-integer epoch (0 legal); negative/string/missing ⇒ no exit proof.
    const admission = record.admissionExpiresAt;
    if (!Number.isSafeInteger(admission) || admission < 0) return undefined;
    bound = Math.max(bound, admission);
  }
  for (const lease of record.leases) for (const key of ["createdAt", "heartbeatAt", "expiresAt"]) {
    const value = Date.parse(String(lease?.[key] ?? ""));
    if (!Number.isFinite(value)) return undefined;
    bound = Math.max(bound, value);
  }
  return bound;
}

export class UpdateGate {
  private held: any;
  constructor(private leasePath = defaultHostOperationLeasePath(), private ownerAlive: (pid: number) => boolean = pid => {
    try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== "ESRCH"; }
  }, private deps: UpdateGateDependencies = {}) {}
  async begin(storagePath: string): Promise<void> {
    if (this.held) { await this.held.assertHeld(); return; }
    const manager = new LegacyHostOperationLeaseManager({ leasePath: this.leasePath, windowId: `${hostname()}:${process.pid}:${UPDATE_ACTION}:${randomUUID()}` });
    this.held = await manager.acquire({ pluginId: "simple-local.simple-experiment-mac", workspaceUri: "untitled://paired-plugin-update", hostProjectPath: storagePath,
      actionType: UPDATE_ACTION, actionLabel: "Mac 配套更新" });
  }
  async end(): Promise<void> { const lease = this.held; this.held = undefined; await lease?.release(); }
  async wait(signal?: AbortSignal): Promise<void> {
    const directory = this.leasePath + ".resources-v2", started = Date.now();
    let proofRun: Promise<Map<number, ProcessObservation>> | undefined; // at most one batch probe per wait() run
    const remaining = () => WAIT_BUDGET_MS - (Date.now() - started);
    const checkBudget = () => { if (remaining() <= 0) throw new Error("本地操作尚未结束；停止更新等待，现有传输继续运行。请稍后重试。"); };
    for (;;) {
      signal?.throwIfAborted(); checkBudget();
      await this.held?.assertHeld(); // R62 (plan r16): every round re-proves the v1 batch lease
      const names = await fs.readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
      signal?.throwIfAborted(); checkBudget(); await this.held?.assertHeld();
      // R53: deduplicated union of main slots AND legal ownership sidecars; orphan sidecars are never ignored.
      const slots = [...new Set(names.filter(name => /^[0-9a-f]{64}\.json(|\.ownership)$/.test(name)).map(name => name.replace(/\.ownership$/, "")))].sort();
      let active = false;
      const proofs: ProofCandidate[] = [];
      for (const slot of slots) {
        const entry = await readResourceLeaseRegistryWithOwnership(directory + "/" + slot); // secure reader + ownership recovery; corrupt ⇒ throw 无法核实
        signal?.throwIfAborted();
        if (!entry) continue; // Atomically consumed empty slot (main and sidecar both gone).
        const { record, mtimeMs } = entry;
        if (record.schemaVersion !== 2 || !Array.isArray(record.leases)) throw new Error("本地传输租约损坏，已阻止安装。");
        // R54: an explicit key (including null/string/negative/zero/huge) is explicit — only a truly absent key is legacy.
        const hasExplicit = Object.prototype.hasOwnProperty.call(record, "processId");
        let rootPid: number | undefined;
        if (hasExplicit) {
          rootPid = validPid(record.processId);
          if (rootPid === undefined) throw new Error("本地传输租约字段无效（进程号非法），已阻止安装。");
        } else rootPid = windowIdPid(record.windowId); // legacy writers (1b8acce2..ac3b9836): strict PID segment only
        // R54: inner identity must be fully trustworthy — missing/invalid/contradictory ⇒ reject, never best-effort.
        for (const lease of record.leases) {
          if (!lease || typeof lease !== "object" || Array.isArray(lease)) throw new Error("本地传输租约记录损坏，已阻止安装。");
          const leasePid = validPid(lease.processId);
          if (leasePid === undefined) throw new Error("本地传输租约字段无效（内层进程号缺失或非法），已阻止安装。");
          // R59 (plan r16): the inner PID itself must equal the root PID (explicit or recovered), not just be valid.
          if (rootPid !== undefined && leasePid !== rootPid) throw new Error("本地传输租约身份字段矛盾，已阻止安装。");
          if (typeof lease.windowId !== "string" || lease.windowId !== record.windowId) throw new Error("本地传输租约身份字段矛盾，已阻止安装。");
          const leaseWindowPid = windowIdPid(lease.windowId);
          if (leaseWindowPid !== undefined && rootPid !== undefined && leaseWindowPid !== rootPid) throw new Error("本地传输租约身份字段矛盾，已阻止安装。");
        }
        const heldFlags = Boolean(record.leases.length || record.choosing || record.ticket);
        // R52/R61 (plan r17 exact expression): a released explicit-idle registry never blocks ONLY under the strict
        // value/type check — null/odd-typed choosing/ticket/admission never take the idle fast path.
        const normalReleasedIdle = hasExplicit && record.leases.length === 0 && record.choosing === false &&
          Number.isSafeInteger(record.ticket) && record.ticket === 0 &&
          typeof record.admissionExpiresAt === "number" && record.admissionExpiresAt === 0 &&
          typeof record.windowId === "string" && record.windowId.length > 0;
        if (normalReleasedIdle) continue;
        if (rootPid === undefined) { active = true; continue; } // Owner not derivable: conservative wait, even when idle.
        if (!this.ownerAlive(rootPid)) continue; // Only ESRCH proves disappearance (permission failures keep waiting).
        // R52: unified StartTime exit proof for EVERY trustworthy root with a live/unknown owner — explicit modern
        // roots hit PID reuse on the host too (6397137…: PID 35152 reused by Edge identity_helper). Legacy idle
        // without a proven release still waits unless the proof says otherwise (r14 conservative rule).
        proofs.push({ pid: rootPid, boundMs: proofBoundMs(record, mtimeMs) });
      }
      if (proofs.length) {
        const unresolved: ProofCandidate[] = [];
        for (const candidate of proofs) {
          const sync = this.deps.processStartedAt ? this.deps.processStartedAt(candidate.pid) : undefined;
          const trusted = parseProcessStartMs(sync ?? undefined, Date.now()); // future/invalid sync values are untrusted
          if (trusted !== undefined) { if (!(candidate.boundMs !== undefined && trusted > candidate.boundMs + REUSE_PROOF_MARGIN_MS)) active = true; }
          else unresolved.push(candidate);
        }
        if (unresolved.length) {
          proofRun ??= this.collectStartTimes([...new Set(unresolved.map(row => row.pid))].sort((a, b) => a - b), signal, Math.min(PROBE_TIMEOUT_CAP_MS, remaining()));
          const proof = await proofRun;
          signal?.throwIfAborted(); checkBudget(); await this.held?.assertHeld(); // R55/R62: probe completion cannot bypass cancel, budget, or the holding proof
          for (const { pid, boundMs } of unresolved) {
            const observation = proof.get(pid) ?? "unknown";
            if (observation === "exited") continue; // R63: trustworthy complete enumeration omitting the PID is the SAME exit proof as ESRCH — no bound needed
            const start = parseProcessStartMs(observation === "unknown" ? undefined : observation, Date.now());
            if (boundMs === undefined) { active = true; continue; } // Incomplete bound: no exit proof from partial times.
            if (start !== undefined && start > boundMs + REUSE_PROOF_MARGIN_MS) continue; // Provably a different process.
            active = true; // Unknown/untrusted time (incl. present-without-StartTime), probe failure, or plausible original owner keeps waiting.
          }
        }
      }
      signal?.throwIfAborted(); checkBudget(); await this.held?.assertHeld(); // R55/R62: re-check cancel, budget, and holding proof immediately before returning
      if (!active) return;
      this.deps.onPoll?.({ probing: proofs.length });
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  private async collectStartTimes(pids: number[], signal: AbortSignal | undefined, timeoutMs: number): Promise<Map<number, ProcessObservation>> {
    try { return await (this.deps.processStartTimes ? this.deps.processStartTimes(pids, signal, timeoutMs) : defaultStartTimes(pids, signal, timeoutMs)); }
    catch { return new Map(pids.map(pid => [pid, "unknown" as const])); } // A failed batch is never an exit proof; abort re-checked by caller.
  }
}
