import type { TaskObservation } from "./TaskLifecycle";

/** A compact confirmed fact, never permission to launch, stop or delete. */
export type VerifiedCompletion = { schemaVersion: 1; identity: string; verifiedAt: string; exitCode: 0 };
export function completionIdentity(plan: any, job: any): string {
  return JSON.stringify([plan.projectId, plan.id, job.index, job.workerId, job.commandId, job.outputDir, job.collectionResultCsv || ""]);
}
export function hasVerifiedCompletion(plan: any, job: any): boolean {
  const proof = job.verifiedCompletion;
  return Boolean(!job.unavailable && !job.retainExistingOutputs && job.commandId && plan.projectId && job.workerId && job.outputDir
    && proof?.schemaVersion === 1 && proof.exitCode === 0 && Number.isFinite(Date.parse(proof.verifiedAt))
    && proof.identity === completionIdentity(plan, job));
}
export function verifiedCompletionProjection(plan: any, job: any) {
  if (!hasVerifiedCompletion(plan, job)) return {};
  return { status: "completed" as const, executionState: "exited", resultState: "complete", completionState: "verified" as const,
    exitCode: 0, statusQueryError: undefined, error: undefined, blockReason: undefined,
    runtimeDiagnostics: { schemaVersion: 1 as const, commandId: job.commandId, runId: job.commandId,
      state: "clear" as const, count: 0, scanComplete: true } };
}
export function nextVerifiedCompletion(plan: any, job: any, observation: TaskObservation, state: any, now: number): VerifiedCompletion | undefined {
  const exact = !observation.queryError;
  const confirmed = hasVerifiedCompletion(plan, job);
  const newer = (lane: "execution" | "artifacts" | "logs") => !confirmed
    || Date.parse(String(observation.evidence?.[lane]?.networkStartedAt || "")) > Date.parse(job.verifiedCompletion.verifiedAt);
  const artifactIssue = exact && newer("artifacts") && !observation.resultQueryError && (observation.artifactIssue
    || observation.result && (observation.result.runId !== job.commandId || observation.result.identityMatches === false
      || observation.result.status === "failed" || observation.result.present === false || observation.result.artifactsComplete === false));
  const executionIssue = exact && newer("execution") && !observation.executionQueryError && state.execution === "failed";
  const runtimeIssue = exact && newer("logs") && state.runtimeDiagnostics?.count > 0;
  if (artifactIssue || executionIssue || runtimeIssue) return undefined;
  if (confirmed) return job.verifiedCompletion;
  if (exact && !observation.executionQueryError && !observation.resultQueryError && state.status === "completed"
    && state.result === "complete" && state.completionState === "verified" && state.exitCode === 0)
    return { schemaVersion: 1, identity: completionIdentity(plan, job), verifiedAt: new Date(now).toISOString(), exitCode: 0 };
  return undefined;
}
