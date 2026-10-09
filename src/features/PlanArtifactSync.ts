import * as crypto from "node:crypto";
import * as path from "node:path";

export type PlanSyncEntry = {
  planFile: string;
  revision: string;
  runId: string;
  sourceWorkerId: string;
  artifactPaths: string[];
  directoryPaths: string[];
  stalePaths?: Array<{ path: string; directory: boolean }>;
  destinations: Record<string, { status: "pending" | "synced"; syncedAt?: string }>;
};
export type PlanSyncLedger = { schemaVersion: 2; entries: Record<string, PlanSyncEntry> };

export const emptyPlanSyncLedger = (): PlanSyncLedger => ({ schemaVersion: 2, entries: {} });

function projectStorageId(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return crypto.createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex");
}

export function planSyncLedgerStoragePath(storageRoot: string, projectRoot: string): string {
  return path.join(storageRoot, "plan-sync-ledgers", `${projectStorageId(projectRoot)}.json`);
}

export function projectMirrorStateStoragePath(storageRoot: string, projectRoot: string): string {
  return path.join(storageRoot, "plan-sync-ledgers", `${projectStorageId(projectRoot)}.mirror.json`);
}

function canonicalPlan(value: string): string { return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(); }

export function latestPlanSyncEntry(ledger: PlanSyncLedger, planFile: string): PlanSyncEntry | undefined {
  let latest: PlanSyncEntry | undefined;
  for (const entry of Object.values(ledger.entries || {})) {
    if (canonicalPlan(entry.planFile) !== canonicalPlan(planFile)) continue;
    if (entry.runId !== "historic" || !latest) latest = entry;
  }
  return latest;
}

export function migratePlanSyncLedger(value: any): PlanSyncLedger {
  if (!value || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) throw new Error("Plan 同步记录格式无效。");
  if (value.schemaVersion === 2) return value;
  if (value.schemaVersion !== 1) throw new Error("Plan 同步记录版本不受支持。");
  return { schemaVersion: 2, entries: Object.fromEntries(Object.entries(value.entries).map(([key, raw]) => {
    const entry = raw as PlanSyncEntry;
    return [key, { ...entry, destinations: Object.fromEntries(Object.keys(entry.destinations || {}).map((id) => [id, { status: "pending" }])) }];
  })) };
}

export function safePlanArtifactPath(value: unknown): string | undefined {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || /[{}*?\[\]]/.test(normalized)) return undefined;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return normalized;
}

export function planArtifactPaths(plan: any, summary: any, sourceWorkerId: string): string[] {
  const paths = new Set<string>();
  const add = (value: unknown) => { const safe = safePlanArtifactPath(value); if (safe) paths.add(safe); };
  for (const signal of Array.isArray(plan?.outputSignals) ? plan.outputSignals : []) {
    const match = /^结果目录\s*[:：]\s*(.+)$/.exec(String(signal));
    if (match) add(match[1]);
  }
  for (const candidate of Array.isArray(plan?.outputCandidates) ? plan.outputCandidates : []) {
    const safe = safePlanArtifactPath(candidate);
    if (safe?.includes("/")) paths.add(safe);
  }
  for (const table of Array.isArray(summary?.workerResultTables) ? summary.workerResultTables : []) {
    if (String(table?.workerId || "").toLowerCase() !== sourceWorkerId.toLowerCase()) continue;
    for (const key of ["rawResultCsvPath", "aggregateCsvPath", "projectAggregateCsvPath", "finalCsvPath", "projectFinalCsvPath"]) add(table?.[key]);
  }
  const directories = planArtifactDirectories(plan);
  return [...paths].filter((value) => !directories.some((directory) => value !== directory && value.startsWith(`${directory}/`))).sort();
}

export function planArtifactDirectories(plan: any): string[] {
  return (Array.isArray(plan?.outputSignals) ? plan.outputSignals : []).flatMap((signal: unknown) => {
    const match = /^结果目录\s*[:：]\s*(.+)$/.exec(String(signal));
    const safe = match ? safePlanArtifactPath(match[1]) : undefined;
    return safe ? [safe] : [];
  });
}

export function planSyncKey(planFile: string, revision: string, sourceWorkerId: string, runId = "historic"): string {
  return [planFile.replace(/\\/g, "/"), revision, sourceWorkerId.toLowerCase(), runId].join("|");
}

export function queuePlanSync(
  ledger: PlanSyncLedger,
  planFile: string,
  revision: string,
  sourceWorkerId: string,
  artifactPaths: string[],
  destinationWorkerIds: string[],
  directoryPaths: string[] = [],
  runId = "historic",
): PlanSyncLedger {
  const key = planSyncKey(planFile, revision, sourceWorkerId, runId);
  const previous = ledger.entries[key];
  const latestPrior = Object.entries(ledger.entries).filter(([otherKey, entry]) => otherKey !== key && canonicalPlan(entry.planFile) === canonicalPlan(planFile) && entry.runId !== "historic").at(-1)?.[1];
  const stalePaths = previous?.stalePaths || (latestPrior ? [...new Map([
    ...(latestPrior.stalePaths || []),
    ...latestPrior.artifactPaths.filter((oldPath) => !artifactPaths.includes(oldPath) && !/\.log$/i.test(oldPath))
      .map((oldPath) => ({ path: oldPath, directory: latestPrior.directoryPaths.includes(oldPath) })),
  ].filter((item) => !/\.log$/i.test(item.path) && !artifactPaths.some((next) => next === item.path || item.path.startsWith(`${next}/`)))
    .map((item) => [item.path, item])).values()] : []);
  const newArtifacts = artifactPaths.some((path) => !previous?.artifactPaths.includes(path));
  const destinations = Object.fromEntries(Object.entries(previous?.destinations || {}).map(([id, value]) => [id, newArtifacts ? { status: "pending" as const } : value]));
  for (const id of destinationWorkerIds) {
    if (id.toLowerCase() !== sourceWorkerId.toLowerCase() && !destinations[id]) destinations[id] = { status: "pending" };
  }
  return { schemaVersion: 2, entries: { ...ledger.entries, [key]: {
    planFile,
    revision,
    runId,
    sourceWorkerId,
    artifactPaths: [...new Set([...(previous?.artifactPaths || []), ...artifactPaths])].sort(),
    directoryPaths: [...new Set([...(previous?.directoryPaths || []), ...directoryPaths])].sort(),
    stalePaths,
    destinations,
  } } };
}

export function markPlanSyncComplete(ledger: PlanSyncLedger, key: string, destinationWorkerId: string, syncedAt: string): PlanSyncLedger {
  const entry = ledger.entries[key];
  if (!entry || !entry.destinations[destinationWorkerId]) throw new Error("待同步记录不存在。");
  return { schemaVersion: 2, entries: { ...ledger.entries, [key]: {
    ...entry,
    destinations: { ...entry.destinations, [destinationWorkerId]: { status: "synced", syncedAt } },
  } } };
}

export function pendingPlanSyncs(ledger: PlanSyncLedger): Array<{ key: string; entry: PlanSyncEntry; destinationWorkerId: string }> {
  const entries = Object.entries(ledger.entries);
  const latestRun = new Map<string, string>();
  for (const [key, entry] of entries) {
    const scope = canonicalPlan(entry.planFile);
    if (entry.runId !== "historic") latestRun.set(scope, key);
  }
  return entries.filter(([key, entry]) => {
    const winner = latestRun.get(canonicalPlan(entry.planFile));
    return winner ? key === winner : entry.runId === "historic";
  }).flatMap(([key, entry]) => Object.entries(entry.destinations)
    .filter(([, value]) => value.status === "pending")
    .map(([destinationWorkerId]) => ({ key, entry, destinationWorkerId })));
}
