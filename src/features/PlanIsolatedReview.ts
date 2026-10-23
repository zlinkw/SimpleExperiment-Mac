import { randomUUID } from "node:crypto";
import { canonicalProjectId } from "./DistributedPlanQueue";
import { cleanupDigest, cleanupRelative } from "./PlanCleanup";
import { loadIsolatedBatchLedger, saveIsolatedBatchLedger, withIsolatedBatchLedger, eligibleIsolatedReviews,
  type IsolatedFrozenBatch, type IsolatedCleanupRecord, type IsolatedReviewEvent, type ReviewedIsolatedBatch } from "./PlanIsolatedBatchLedger";

const denied = (code: string): never => { throw new Error(code); };

/** Local identity can revoke a prior native fact; it cannot create a startup fact. */
export function assertLiveIsolatedBoundary(batch: IsolatedFrozenBatch, root: string, queue: any): void {
  const projectId = canonicalProjectId(root);
  if (batch.projectRoot !== root || batch.canonicalProjectId !== projectId || !eligibleIsolatedReviews([batch], root).length)
    denied("ISOLATED_BATCH_NOT_READY");
  for (const plan of batch.plans) {
    const card = queue.plans?.find((row: any) => row.id === plan.queuePlanId && row.projectId === projectId && row.planFile === plan.planFile);
    if (!card || !plan.jobs?.some(job => job.proof)) denied("ISOLATED_BATCH_IDENTITY_CHANGED");
    for (const identity of plan.jobs || []) {
      const jobs = card.jobs.filter((job: any) => job.index === identity.jobIndex);
      if (jobs.length !== 1) denied("ISOLATED_BATCH_IDENTITY_CHANGED");
      const job = jobs[0];
      if (identity.proof && (job.commandId !== identity.expectedCommandId || job.workerId !== identity.proof.workerId))
        denied("ISOLATED_BATCH_IDENTITY_CHANGED");
      if (identity.expectedCommandId && (job.commandId || job.nextCommandId)
        && (job.commandId || job.nextCommandId) !== identity.expectedCommandId) denied("ISOLATED_BATCH_IDENTITY_CHANGED");
    }
  }
}

/** Resolve the registered operation. Ledger path strings alone never authorize deletion. */
export function assertFrozenIsolationOperation(record: IsolatedCleanupRecord, operation: any): void {
  if (operation?.id !== record.cleanupOperationId || operation?.preview?.action !== "isolate" || operation.state !== "completed"
    || operation.continuedBy || operation.restoredBy) denied("ISOLATED_OPERATION_UNVERIFIED");
  const rows = operation.preview.rows.filter((row: any) => row.disposition === "isolate");
  if (!rows.length || rows.some((row: any) => operation.targets?.[row.id]?.state !== "completed"
    || !["file", "directory"].includes(row.type) || !row.node?.id || !row.node?.root
    || cleanupRelative(row.relativePath) !== row.relativePath || cleanupRelative(row.destination) !== row.destination))
    denied("ISOLATED_OPERATION_UNVERIFIED");
  const keys = (targets: any[]) => targets.map(target => JSON.stringify([target.nodeId, target.host || "", target.sourceRelativePath,
    target.isolationRelativePath, target.archiveBatch || ""])).sort();
  const actual = rows.map((row: any) => ({ nodeId: row.node.id, host: row.node.host || "", sourceRelativePath: row.relativePath,
    isolationRelativePath: row.destination, archiveBatch: row.archiveBatch }));
  if (cleanupDigest(keys(actual)) !== cleanupDigest(keys(record.targets))) denied("ISOLATED_OPERATION_TARGET_CHANGED");
}

export async function resolveIsolatedBatchReview(file: string, root: string, operationId: string, queue: any,
  loadOperation: (id: string) => Promise<any>): Promise<{ batch: ReviewedIsolatedBatch; operation: any } | undefined> {
  const batches = await loadIsolatedBatchLedger(file) as ReviewedIsolatedBatch[];
  const matches = batches.flatMap(batch => batch.plans.flatMap(plan => plan.cleanup
    .filter(record => record.cleanupOperationId === operationId).map(record => ({ batch, plan, record }))));
  if (!matches.length) return undefined; // Ordinary standalone file review retains its existing scope.
  if (matches.length !== 1) denied("ISOLATED_OPERATION_BATCH_CONFLICT");
  const { batch, plan, record } = matches[0];
  assertLiveIsolatedBoundary(batch, root, queue);
  const operation = await loadOperation(operationId);
  if (operation?.preview?.scope?.planFile !== plan.planFile) denied("ISOLATED_OPERATION_PLAN_CHANGED");
  assertFrozenIsolationOperation(record, operation);
  return { batch, operation };
}

/** Append independent events, including late replies. They never mutate PLAN state or schedule work. */
export async function recordIsolatedReviewEvent(file: string, batchId: string, operationId: string,
  event: Pick<IsolatedReviewEvent, "kind" | "reviewOperationId" | "detail">): Promise<void> {
  await withIsolatedBatchLedger(file, async fence => {
    const batches = await loadIsolatedBatchLedger(file) as ReviewedIsolatedBatch[];
    const batch = batches.find(row => row.batchId === batchId);
    if (!batch?.plans.some(plan => plan.cleanup.some(record => record.cleanupOperationId === operationId))) denied("ISOLATED_OPERATION_BATCH_CONFLICT");
    (batch!.reviews ||= []).push({ eventId: randomUUID(), cleanupOperationId: operationId, kind: event.kind,
      ...(event.reviewOperationId ? { reviewOperationId: event.reviewOperationId } : {}), at: new Date().toISOString(),
      ...(event.detail ? { detail: String(event.detail).slice(0, 1200) } : {}) });
    await saveIsolatedBatchLedger(file, batches, fence);
  });
}
