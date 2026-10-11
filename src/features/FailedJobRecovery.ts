import * as path from "node:path";
import * as Queue from "./DistributedPlanQueue";

export function recoveryServerIdentity(server: any): string {
  if (!server || !String(server.host || "").trim() || !String(server.user || "").trim()
    || !Number.isInteger(Number(server.port)) || Number(server.port) < 1 || Number(server.port) > 65535)
    throw new Error("原 Worker 的服务器身份不完整，未召回或移动。");
  return JSON.stringify([server.host, server.user, Number(server.port), String(server.remotePath || "").replace(/\/+$/, "")]);
}

export function failedAttemptPaths(remoteRoot: string, outputDir: string) {
  const root = String(remoteRoot || "").replace(/\/+$/, "");
  const parts = String(outputDir || "").split("/");
  if (!root.startsWith("/") || root === "/" || path.posix.normalize(root) !== root
    || root.split("/").some(part => part === "..") || parts.length < 4 || parts.at(-2) !== "attempts"
    || !(parts[0] === "work_dirs" || parts[0] === "experiments" && parts[1] === "runs")
    || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || [".", "..", ".git", "clean_dir", "simple_cluster", ".runtime"].includes(part)))
    throw new Error("失败 attempt 的精确路径无效，未召回。");
  return { remoteRoot: root, absolutePath: root + "/" + outputDir, destination: root + "/clean_dir/" + outputDir };
}

const jobIdentity = (plan: Queue.QueuedPlan, job: Queue.QueuedJob) =>
  JSON.stringify([plan.id, plan.projectId, plan.planFile, plan.revision, plan.codeFingerprint,
    job.index, job.case, job.seed, job.attempt, job.workerId, job.commandId, job.outputDir]);

/** One local transaction creates the new attempt and persists the separately owned remote obligation. */
export function recallFailedJob(queue: Queue.DistributedQueue, planId: string, jobIndex: number,
  expectedIdentity: string, attemptId: string, recoveryId: string, server: any, authorizedAt: string): Queue.DistributedQueue {
  const plan = queue.plans.find(p => p.id === planId), job = plan?.jobs.find(j => j.index === jobIndex);
  if (!plan || !job || jobIdentity(plan, job) !== expectedIdentity || job.status !== "failed"
    || !job.workerId || !job.commandId || !plan.projectId || job.recoveryConflict || plan.recoveryConflict
    || plan.executionModeBlocked || !["train", "test", "train_test"].includes(plan.executionMode || ""))
    throw new Error("job 身份、状态或原 Plan 模式已变化，未召回。");
  const paths = failedAttemptPaths(server.remotePath, job.outputDir);
  const next = Queue.retryVerifiedJob(queue, planId, jobIndex, attemptId);
  const target = next.plans.find(p => p.id === planId)!.jobs.find(j => j.index === jobIndex)!;
  Object.assign(target, { projectId: job.projectId || plan.projectId, localQueueOnly: true });
  const obligation: Queue.FailedAttemptRecovery = { id: recoveryId,
    plan: { id: plan.id, projectId: plan.projectId, planFile: plan.planFile, revision: plan.revision,
      codeFingerprint: plan.codeFingerprint, planJobCount: plan.planJobCount },
    job: { index: job.index, case: job.case, seed: job.seed, attempt: job.attempt, outputDir: job.outputDir,
      workerId: job.workerId, commandId: job.commandId, runKey: job.runKey || job.commandId, gpuId: job.gpuId },
    ...paths, serverIdentity: recoveryServerIdentity(server), authorizedAt, status: "pending" };
  return { ...next, failedAttemptRecoveries: [...(queue.failedAttemptRecoveries || []), obligation] };
}

export async function recallFailedJobFromUi(host: any, message: any, confirm: (detail: string) => Promise<boolean>, makeId: (kind: string) => string) {
  const context = host.captureProjectContext();
  const queue: Queue.DistributedQueue = await host.loadDistributedQueue(context.root);
  const plan = queue.plans.find(p => p.id === String(message.planId || ""));
  if (!plan || !host.projectContextIsCurrent(context)) throw new Error("Plan context changed.");
  if (plan.resultPathPolicy === "declared") return host.retryDistributedJobFromUi(message);
  throw new Error("HISTORICAL_ATTEMPT_READ_ONLY: old attempts cannot be requeued or moved automatically.");
}

/** Legacy signals remain available to the independent, explicitly confirmed cleanup workflow. */
export async function processFailedAttemptRecoveries(host: any, root: string, makeId: (kind: string) => string, now = Date.now()) {
  return { status: "manual_review_required", automaticExecution: false };
}
