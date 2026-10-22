import { cleanupDigest } from "./PlanCleanup";
import { safeSyncPath } from "./SyncResolution";

const planKey = (value: string) => String(value || "").replace(/\\/g, "/").toLowerCase();

/** A newer submission owns each logical job even while it is incomplete. Never fall back to old outputs. */
export function newestJobOutputs(queue: any): Array<{ plan: any; job: any }> {
  const owners = new Map<string, { plan: any; job: any }>();
  const plans = (queue.plans || []).map((plan: any, index: number) => ({ plan, index }))
    .sort((a: any, b: any) => (Date.parse(a.plan.enqueuedAt) || 0) - (Date.parse(b.plan.enqueuedAt) || 0) || a.index - b.index);
  for (const { plan } of plans) for (const job of plan.jobs || [])
    owners.set(JSON.stringify([plan.projectId, planKey(plan.planFile), job.case, job.seed]), { plan, job });
  return [...owners.values()].filter(({ plan, job }) => !plan.cleanup && !job.cleanup && !job.outputRetiredAt);
}

/** Intersect only this job's declared artifacts with the saved Worker-to-Worker checkbox scope. */
export function jobArtifactScopes(job: any, selected: string[]): string[] {
  const owned = [job.outputDir, ...((job.actualExecutionMode || job.executionMode) !== "train" && job.collectionResultCsv ? [job.collectionResultCsv] : [])];
  for (const item of owned) safeSyncPath(item);
  const paths = new Set<string>();
  for (const scope of selected) {
    if (scope !== ".") safeSyncPath(scope);
    for (const item of owned) {
      if (scope === "." || item === scope || item.startsWith(scope + "/")) paths.add(item);
      else if (item === job.outputDir && scope.startsWith(item + "/")) paths.add(scope);
    }
  }
  return [...paths].filter(item => ![...paths].some(parent => parent !== item && item.startsWith(parent + "/"))).sort();
}

export const latestJobSyncKey = (plan: any, job: any, scopes: string[], targets: any[]) => cleanupDigest([
  plan.projectId, plan.id, job.commandId, job.workerId, job.outputDir, job.collectionResultCsv, scopes,
  targets.map(row => [row.id, row.host, row.port, row.user, row.remotePath]).sort(),
]);
