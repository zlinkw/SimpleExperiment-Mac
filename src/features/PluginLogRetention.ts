import { createHash } from "node:crypto";
import { DistributedQueue } from "./DistributedPlanQueue";

// Local plugin log/cache copies are retained per logical job for at most the current run plus one
// previous run. Candidates are derived from persisted per-attempt queue facts (the same small
// completion facts the reconciler writes before releasing raw text) into an EXACT path ownership
// manifest — never basename substring guesses. Shared files (scheduler logs) are reference-counted:
// a path is proposed only when every referencing generation is terminal AND outside the retained
// window. Active, paused or unknown generations are protected even when a trusted terminal fact
// exists; trusted statuses only refine an already-terminal live status.
export const MANAGED_LOG_PREFIXES = [
  "simple_cluster/console_logs/",
  "simple_cluster/tmux_logs/",
  "simple_cluster/tmp/cluster_scheduler/",
  "simple_cluster/tmp/tmux_logs/",
  "simple_cluster/tmp/console_logs/",
  "tmp/console_logs/",
  "tmp/tmux_logs/",
  "tmp/cluster_scheduler/",
];

const terminalStates = new Set(["completed", "failed", "cancelled"]);
export const RETAINED_GENERATIONS = 2;

export type RetentionRow = { path: string; planFile: string; taskKey: string; reason: string };

export type RetentionIndex = {
  rows: RetentionRow[];
  byPath: Map<string, RetentionRow>;
  staleSessions: Set<string>;
  protectedSessions: Set<string>;
  ownedPaths: Set<string>;
  caseInsensitive: boolean;
};

const normalizeLogPath = (value: string) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const isManagedLogPath = (relative: string) => !relative.split("/").some(part => !part || part === "." || part === "..")
  && MANAGED_LOG_PREFIXES.some(prefix => relative.startsWith(prefix));

// Mirrors cluster_scheduler.slug(): console-log filenames embed slug()ed identity fields.
function slug(value: unknown, fallback: string, limit: number): string {
  const raw = String(value ?? "").trim();
  let text = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-_]+|[.-_]+$/g, "") || fallback;
  if (text.length > limit) {
    const digest = createHash("sha1").update(text).digest("hex").slice(0, 8);
    text = text.slice(0, Math.max(8, limit - 9)).replace(/[.-_]+$/g, "") + "-" + digest;
  }
  return text;
}

// Scheduler runs keep one log per plan file (same spelling the scheduler-log viewer reads).
function schedulerLogPath(planFile: string): string {
  return `simple_cluster/tmp/cluster_scheduler/${String(planFile).replace(/[^a-z0-9]/gi, "_")}.log`;
}

// Structured console-log grammar: exp-…__case-…__seed-…__worker-…__gpu-…__status-…__session-….log
// (the digest fallback keeps the same key=value fields). Parsing yields EXACT field ownership.
export function parseConsoleLogName(basename: string): { session: string; index?: string; case?: string; seed?: string } | undefined {
  const stem = basename.replace(/\.log$/i, "");
  const fields = new Map<string, string>();
  for (const part of stem.split("__")) {
    const split = part.indexOf("-");
    if (split > 0) fields.set(part.slice(0, split), part.slice(split + 1));
  }
  const session = fields.get("session");
  if (!session) return undefined;
  return { session, index: fields.get("exp"), case: fields.get("case"), seed: fields.get("seed") };
}

type Generation = {
  id: string;
  taskKey: string;
  planFile: string;
  at: number;
  attempt: number;
  terminal: boolean;
  active: boolean;
  sessions: Set<string>;
  paths: Set<string>;
  // Persisted dispatch facts: which Worker physically ran this generation. Existence of its
  // logs must be observed THERE (a local stat proves nothing about remote-only files).
  workers: Set<string>;
};

/** Logical identity: canonical plan + stable task position; worker, GPU and session churn share one generation. */
function collectGenerations(queue: DistributedQueue, fold: (value: string) => string): Map<string, Map<string, Generation>> {
  const tasks = new Map<string, Map<string, Generation>>();
  for (const plan of queue?.plans || []) {
    const planFile = normalizeLogPath(String(plan.planFile || ""));
    const at = Date.parse(String(plan.enqueuedAt || "")) || 0;
    const sharedSchedulerLog = schedulerLogPath(planFile);
    for (const job of plan.jobs || []) {
      const taskKey = `${fold(planFile)}|${Number.isInteger(job.index) ? job.index : -1}|${fold(String(job.case ?? ""))}|${fold(String(job.seed ?? ""))}`;
      const generations = tasks.get(taskKey) || new Map<string, Generation>();
      tasks.set(taskKey, generations);
      // One generation per STABLE RUN (plan.id): retries and extra batches of the same run merge
      // into that run's single generation instead of adding generations of their own.
      const add = (id: string, status: unknown, attempt: unknown, logPath: unknown, tmuxSession?: unknown, workerId?: unknown) => {
        const liveStatus = String(status || "unknown");
        const terminal = terminalStates.has(liveStatus);
        const generation: Generation = {
          id, taskKey, planFile, at, attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 0,
          terminal, active: !terminal,
          sessions: new Set<string>(), paths: new Set<string>([sharedSchedulerLog]),
          workers: new Set<string>(),
        };
        const relative = normalizeLogPath(String(logPath || ""));
        if (relative && !/^[A-Za-z]:/.test(relative) && !relative.startsWith("/") && isManagedLogPath(fold(relative)))
          generation.paths.add(relative);
        const session = String(tmuxSession || "");
        if (session && /^[A-Za-z0-9._-]+$/.test(session)) {
          generation.sessions.add(fold(session));
          generation.paths.add(`simple_cluster/tmux_logs/${session}.log`);
        }
        const worker = String(workerId || "").trim();
        if (worker) generation.workers.add(worker);
        const existing = generations.get(id);
        if (!existing) generations.set(id, generation);
        else {
          existing.sessions = new Set([...existing.sessions, ...generation.sessions]);
          existing.paths = new Set([...existing.paths, ...generation.paths]);
          existing.workers = new Set([...existing.workers, ...generation.workers]);
          existing.attempt = Math.max(existing.attempt, generation.attempt);
          // A generation is terminal only while every merged observation is terminal; any live or
          // unknown sibling keeps the whole generation protected regardless of trusted facts.
          existing.terminal = existing.terminal && terminal;
          existing.active = existing.active || generation.active;
          if (generation.active) existing.terminal = false;
        }
      };
      for (const record of job.history || [])
        add(String(plan.id), record.status, record.attempt,
          (record as { logPath?: string }).logPath, (record as { tmuxSession?: string }).tmuxSession,
          (record as { workerId?: string }).workerId);
      add(String(plan.id), job.status, job.attempt, job.logPath, job.tmuxSession, job.workerId);
    }
  }
  return tasks;
}

export function retentionIndex(queue: DistributedQueue, options: { caseInsensitive?: boolean } = {}): RetentionIndex {
  const caseInsensitive = options.caseInsensitive !== false;
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const tasks = collectGenerations(queue, fold);
  const owners = new Map<string, { row: RetentionRow; stale: boolean; anyProtected: boolean }>();
  const staleSessions = new Set<string>();
  const protectedSessions = new Set<string>();
  for (const [taskKey, generations] of tasks) {
    const ordered = [...generations.values()]
      .sort((a, b) => b.at - a.at || b.attempt - a.attempt || (b.id > a.id ? 1 : -1));
    ordered.forEach((generation, index) => {
      const stale = index >= RETAINED_GENERATIONS && generation.terminal && !generation.active;
      for (const session of generation.sessions) (stale ? staleSessions : protectedSessions).add(session);
      for (const path of generation.paths) {
        const key = fold(normalizeLogPath(path));
        const owner = owners.get(key);
        if (!owner) owners.set(key, { row: { path: normalizeLogPath(path), planFile: generation.planFile, taskKey, reason: "" }, stale, anyProtected: !stale });
        else {
          owner.stale = owner.stale && stale;
          owner.anyProtected = owner.anyProtected || !stale;
        }
      }
    });
  }
  const rows: RetentionRow[] = [];
  const byPath = new Map<string, RetentionRow>();
  for (const [key, owner] of owners) {
    // Reference-counted: a shared log stays while ANY referencing generation is retained or active.
    if (owner.anyProtected || !owner.stale) continue;
    const relative = owner.row.path;
    if (!isManagedLogPath(fold(relative))) continue;
    owner.row.reason = `已超出该任务两代保留窗口（当前＋上一次，归属清单精确路径）：${owner.row.taskKey.slice(0, 120)}`;
    rows.push(owner.row);
    byPath.set(key, owner.row);
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const ownedPaths = new Set<string>();
  for (const key of owners.keys()) if (isManagedLogPath(key)) ownedPaths.add(key);
  return { rows, byPath, staleSessions, protectedSessions, ownedPaths, caseInsensitive };
}

export type RetentionOwnership = "stale" | "protected" | "unowned" | "unmanaged";

/** Exact ownership class of one managed path: stale rows may enter candidates, protected rows
 * (current/previous/active generations) must never do so, and unowned managed files are shown
 * read-only — they belong to no generation the manifest can name, so nothing may be deleted. */
export function retentionOwnership(index: RetentionIndex, relativePath: string): RetentionOwnership {
  const normalized = normalizeLogPath(relativePath);
  if (!normalized) return "unmanaged";
  const fold = (value: string) => (index.caseInsensitive ? value.toLowerCase() : value);
  if (!isManagedLogPath(fold(normalized))) return "unmanaged";
  const key = fold(normalized);
  if (index.byPath.has(key)) return "stale";
  if (index.ownedPaths.has(key)) return "protected";
  if (fold(normalized).startsWith("simple_cluster/console_logs/")) {
    const parsed = parseConsoleLogName(normalized.slice(normalized.lastIndexOf("/") + 1));
    if (parsed) {
      const session = fold(parsed.session);
      if (index.protectedSessions.has(session)) return "protected";

    }
  }
  return "unowned";
}

export function isStaleRetentionRow(index: RetentionIndex, relativePath: string): RetentionRow | undefined {
  const normalized = normalizeLogPath(relativePath);
  if (!normalized) return undefined;
  const fold = (value: string) => (index.caseInsensitive ? value.toLowerCase() : value);
  if (!isManagedLogPath(fold(normalized))) return undefined;
  const row = index.byPath.get(fold(normalized));
  if (row) return row;
  // Only the persisted exact path manifest may authorize deletion. Console filenames
  // contain no run/project identity; parsing a session string cannot prove ownership.

  return undefined;
}

export type ProbeResult = "present" | "absent" | "error";

export type AdmissionPreview = { allowed: true; taskKeys: string[] } | {
  allowed: false;
  pending: { taskKey: string; planFile: string; reason: "old-generation-still-present" | "old-generation-active" | "existence-check-failed"; paths: string[]; workers: string[] }[];
};

/**
 * Read-only admission preview for one INCOMING run of a plan file. It virtually joins the new
 * generation first: after landing, the retained window is {incoming, newest existing}, so every
 * older existing generation of each affected taskKey is due to leave the window. Landing is only
 * allowed once every leaving generation satisfies BOTH rules:
 *  - it is terminal: active, paused or unknown generations hold admission even when their files
 *    are already gone (reads/transfers in flight are covered by the deletion executor's recheck);
 *  - every path it owns (and that no retained generation still references) is OBSERVED ABSENT on
 *    the Worker that physically ran that generation. The caller observes exact paths in batches
 *    per leaving generation; a missing, errored or unanswered observation is NEVER "absent".
 * Independent plan files never hold each other: only taskKeys derived from the target plan file
 * are evaluated, and shared paths (per-plan scheduler log) stay reference-counted.
 */
export async function admissionPreview(queue: DistributedQueue, planFile: string, options: {
  caseInsensitive?: boolean;
  observe: (paths: string[], context: { workers: string[] }) => Promise<Map<string, ProbeResult>>;
}): Promise<AdmissionPreview> {
  const caseInsensitive = options.caseInsensitive !== false;
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const target = fold(normalizeLogPath(planFile));
  const tasks = collectGenerations(queue, fold);
  const affected = new Set<string>();
  const orderedByTask = new Map<string, Generation[]>();
  for (const [taskKey, generations] of tasks) {
    const ordered = [...generations.values()].sort((a, b) => b.at - a.at || b.attempt - a.attempt || (b.id > a.id ? 1 : -1));
    orderedByTask.set(taskKey, ordered);
    if (ordered.length && fold(normalizeLogPath(ordered[0].planFile)) === target) affected.add(taskKey);
  }
  if (!affected.size) return { allowed: true, taskKeys: [] };
  // Retained references: newest existing generation per affected taskKey (kept next to incoming)
  // plus every generation of unaffected taskKeys (their windows are untouched by this run).
  const retainedPaths = new Set<string>();
  for (const [taskKey, ordered] of orderedByTask) {
    const generations = taskKey && affected.has(taskKey) ? ordered.slice(0, 1) : ordered;
    for (const generation of generations) for (const path of generation.paths) retainedPaths.add(fold(normalizeLogPath(path)));
  }
  const pending: { taskKey: string; planFile: string; reason: "old-generation-still-present" | "old-generation-active" | "existence-check-failed"; paths: string[]; workers: string[] }[] = [];
  for (const taskKey of affected) {
    const leaving = (orderedByTask.get(taskKey) || []).slice(1);
    for (const generation of leaving) {
      if (!generation.terminal || generation.active) {
        pending.push({ taskKey, planFile, reason: "old-generation-active", paths: [], workers: [...generation.workers] });
        continue;
      }
      const present: string[] = [];
      const failed: string[] = [];
      const checked: string[] = [];
      for (const path of generation.paths) {
        const key = fold(normalizeLogPath(path));
        if (!retainedPaths.has(key)) checked.push(path);
      }
      if (checked.length) {
        const outcomes = await options.observe(checked, { workers: [...generation.workers] });
        for (const path of checked) {
          const outcome = outcomes.get(path);
          if (outcome === "present") present.push(path);
          else if (outcome !== "absent") failed.push(path);
        }
      }
      if (failed.length) pending.push({ taskKey, planFile, reason: "existence-check-failed", paths: failed, workers: [...generation.workers] });
      else if (present.length) pending.push({ taskKey, planFile, reason: "old-generation-still-present", paths: present, workers: [...generation.workers] });
    }
  }
  if (!pending.length) return { allowed: true, taskKeys: [...affected] };
  return { allowed: false, pending };
}
