import { createHash } from "node:crypto";
import * as path from "node:path";
import { cloneDistributedQueue, DistributedQueue, QueuedPlan } from "./DistributedPlanQueue";
import { selectLatestCompletePlanRun } from "../results/PlanRunFreshness";

export type OutputRetirementCandidate = {
  planFile: string;
  replacementRunId: string;
  outputDir: string;
  workerIds: string[];
  type: "directory";
};
export type OutputInspection = {
  exists: boolean;
  safeForDeletion: boolean;
  type: "directory";
  relativePath: string;
  remoteRoot: string;
  absolutePath: string;
  parent: string;
  child: string;
  fingerprint: string;
  bytes: number;
  fileCount: number;
};
export type ReviewedOutput = OutputRetirementCandidate & { workerId: string; inspection: OutputInspection };

const terminal = new Set(["completed", "failed", "cancelled"]);
const normalizePlan = (value: string) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const ordered = (plans: QueuedPlan[]) => plans.map((plan, index) => ({ plan, index }))
  .sort((a, b) => (Date.parse(a.plan.enqueuedAt) || 0) - (Date.parse(b.plan.enqueuedAt) || 0) || a.index - b.index)
  .map(({ plan }) => plan);
const codeVersion = (plan: QueuedPlan): string => plan.codeFingerprint && plan.revision
  ? JSON.stringify([plan.codeFingerprint, plan.revision]) : "";

/** Count code/config versions, not seeds, copies or repeat submissions. Unknown identities stay separate. */
export function outputVersionReview(queue: DistributedQueue, limit = 5): {
  planFile: string; versionCount: number; olderRunIds: string[]; signature: string;
}[] {
  const reports = [];
  for (const file of new Set(queue.plans.map(plan => normalizePlan(plan.planFile)))) {
    const versions = new Map<string, QueuedPlan[]>();
    for (const plan of ordered(queue.plans.filter(plan => normalizePlan(plan.planFile) === file))) {
      if (!plan.jobs.flatMap(job => [job, ...(job.history || [])]).some(job => !job.outputRetiredAt && isAttemptOutputDir(job.outputDir))) continue;
      const key = codeVersion(plan) || `unknown:${plan.id}`;
      const runs = versions.get(key) || [];
      runs.push(plan);
      versions.delete(key);
      versions.set(key, runs);
    }
    if (versions.size <= limit) continue;
    const olderRunIds = [...versions.values()].slice(0, versions.size - limit).flatMap(runs => runs.map(plan => plan.id));
    reports.push({ planFile: queue.plans.find(plan => normalizePlan(plan.planFile) === file)!.planFile,
      versionCount: versions.size, olderRunIds,
      signature: createHash("sha256").update(JSON.stringify([...versions].map(([key, runs]) => [key, runs.map(plan => plan.id)]))).digest("hex") });
  }
  return reports;
}

/** Upgrade legacy subset counts only from an exact current revision, without touching the display cache. */
export function withValidatedPlanJobCounts(queue: DistributedQueue, metadata: readonly Record<string, any>[] = []): DistributedQueue {
  const next = cloneDistributedQueue(queue);
  for (const plan of next.plans) {
    const current = metadata.find((row) => normalizePlan(row.planFile || row.file) === normalizePlan(plan.planFile) && row.revision === plan.revision);
    if (!current) continue;
    const cases = Array.isArray(current.cases) ? current.cases.length : Number(current.caseCount || current.case_count);
    const seeds = Array.isArray(current.seeds) ? current.seeds.length : Number(current.seedCount || current.seed_count);
    const count = cases > 0 && seeds > 0 ? cases * seeds : Number(current.jobCount || current.job_count);
    if (Number.isInteger(count) && count > 0) plan.fullPlanJobCount = count;
  }
  return next;
}

/** Only the complete authority and newer staging runs need artifact transfer. History is metadata. */
export function plansForOutputSync(queue: DistributedQueue): QueuedPlan[] {
  const keep = new Set<string>();
  for (const file of new Set(queue.plans.map((plan) => normalizePlan(plan.planFile)))) {
    const plans = ordered(queue.plans.filter((plan) => normalizePlan(plan.planFile) === file));
    const complete = selectLatestCompletePlanRun({ plans }, file);
    if (complete) keep.add(complete.runId);
    const latest = plans.at(-1);
    if (latest) keep.add(latest.id);
    for (const plan of plans) if (plan.jobs.some((job) => !terminal.has(job.status))) keep.add(plan.id);
  }
  return queue.plans.filter((plan) => keep.has(plan.id));
}

/** Only a single literal attempt leaf can ever be retired, never the Plan/job/project root. */
export function isAttemptOutputDir(value: string): boolean {
  const parts = String(value || "").split("/");
  return parts.length >= 4 && parts.at(-2) === "attempts"
    && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")
    && ["work_dirs", "experiments"].includes(parts[0])
    && (parts[0] !== "experiments" || parts[1] === "runs")
    && !parts.some((part) => [".git", "clean_dir", "simple_cluster", ".runtime"].includes(part));
}

export function outputRetirementCandidates(queue: DistributedQueue, publishedRunIds: readonly string[], requiredPaths: readonly string[], reviewedOlderRunIds: readonly string[] = []): OutputRetirementCandidate[] {
  const candidates = new Map<string, OutputRetirementCandidate>();
  const protectedDirs = queue.plans.flatMap((plan) => plan.jobs.filter((job) => !terminal.has(job.status)).map((job) => job.outputDir));
  for (const id of publishedRunIds) {
    const plan = queue.plans.find((row) => row.id === id);
    // A legacy missing-job submission may report only its subset count. Do not retire a full fallback without the validation count.
    if (!plan || typeof plan.fullPlanJobCount !== "number" || !Number.isInteger(plan.fullPlanJobCount) || !(plan.fullPlanJobCount > 0)) continue;
    const plans = ordered(queue.plans.filter((row) => normalizePlan(row.planFile) === normalizePlan(plan.planFile)));
    const complete = selectLatestCompletePlanRun({ plans }, plan.planFile);
    if (!complete || complete.runId !== id || plan.jobs.some((job) => job.outputRetiredAt
      || !requiredPaths.every((file) => /^[a-f0-9]{64}$/i.test(job.artifacts?.[`${job.outputDir}/${file}`] || "")))) continue;
    const completeIndex = plans.findIndex((row) => row.id === id);
    const retained = [...protectedDirs, ...plans.slice(completeIndex).flatMap((row) => row.jobs.map((job) => job.outputDir))];
    const add = (outputDir: string, workerIds: (string | undefined)[], status: string, retiredAt?: string) => {
      if (retiredAt || !terminal.has(status) || !isAttemptOutputDir(outputDir)) return;
      if (retained.some((current) => current === outputDir || current.startsWith(outputDir + "/") || outputDir.startsWith(current + "/"))) return;
      if (queue.plans.some((row) => normalizePlan(row.planFile) !== normalizePlan(plan.planFile)
        && row.jobs.flatMap((job) => [job, ...(job.history || [])]).some((job) => job.outputDir === outputDir
          || job.outputDir.startsWith(outputDir + "/") || outputDir.startsWith(job.outputDir + "/"))))
        throw new Error("旧 attempt 被其他 Plan 引用；禁止自动替换。");
      const existing = candidates.get(outputDir);
      if (existing && existing.planFile !== plan.planFile) throw new Error("不同 Plan 共享旧 attempt 路径；禁止自动替换。");
      candidates.set(outputDir, { planFile: plan.planFile, replacementRunId: id, outputDir, type: "directory",
        workerIds: [...new Set([...(existing?.workerIds || []), ...workerIds].filter((id): id is string => Boolean(id)))] });
    };
    for (const old of plans.slice(0, completeIndex + 1)) {
      // Changed code/config is history, not an implicit replacement target. An
      // overflow review can select older versions, still behind exact-path approval.
      if (!(codeVersion(plan) && codeVersion(old) === codeVersion(plan)) && !reviewedOlderRunIds.includes(old.id)) continue;
      for (const job of old.jobs) {
        add(job.outputDir, [job.workerId, ...(job.mirroredWorkerIds || []), ...(job.fragmentWorkerIds || [])], job.status, job.outputRetiredAt);
        for (const history of job.history || [])
          add(history.outputDir, [history.workerId], history.status, history.outputRetiredAt);
      }
    }
  }
  return [...candidates.values()];
}

export function validateOutputInspection(candidate: OutputRetirementCandidate, proof: OutputInspection, root: string): void {
  if (!isAttemptOutputDir(candidate.outputDir) || !root || root === "/" || !root.startsWith("/")
    || path.posix.normalize(root) !== root || proof.remoteRoot !== root
    || proof.relativePath !== candidate.outputDir || proof.type !== "directory"
    || proof.absolutePath !== `${root}/${candidate.outputDir}` || proof.parent !== path.posix.dirname(proof.absolutePath)
    || proof.child !== `./${path.posix.basename(candidate.outputDir)}` || !proof.safeForDeletion
    || !/^[a-f0-9]{64}$/i.test(proof.fingerprint) || !Number.isSafeInteger(proof.bytes) || proof.bytes < 0
    || !Number.isSafeInteger(proof.fileCount) || proof.fileCount < 0)
    throw new Error(`旧 attempt 安全检查不通过：${candidate.outputDir}`);
}

export function retirementIdentity(candidates: readonly OutputRetirementCandidate[]): string {
  return createHash("sha256").update(JSON.stringify([...candidates].sort((a, b) => a.outputDir.localeCompare(b.outputDir)))).digest("hex");
}

export function markOutputsRetired(queue: DistributedQueue, candidate: OutputRetirementCandidate, retiredAt: string): DistributedQueue {
  const next = cloneDistributedQueue(queue);
  for (const plan of next.plans) for (const job of plan.jobs) {
    if (normalizePlan(plan.planFile) !== normalizePlan(candidate.planFile)) continue;
    if (job.outputDir === candidate.outputDir) {
      job.outputRetiredAt = retiredAt;
      job.artifacts = undefined;
      job.mirroredWorkerIds = undefined;
      job.fragmentWorkerIds = undefined;
    }
    for (const history of job.history || []) if (history.outputDir === candidate.outputDir) history.outputRetiredAt = retiredAt;
  }
  return next;
}

/** All-target preflight, two-stage UI approval, then a fresh proof before each exact delete. */
export async function retirePlanOutputs(candidates: OutputRetirementCandidate[], ports: {
  workerIds: string[];
  inspect: (candidate: OutputRetirementCandidate, workerId: string) => Promise<OutputInspection>;
  confirm: (records: ReviewedOutput[]) => Promise<boolean>;
  assertCurrent: () => Promise<void>;
  hold: (candidate: OutputRetirementCandidate) => Promise<void>;
  remove: (record: ReviewedOutput) => Promise<void>;
  retired: (candidate: OutputRetirementCandidate) => Promise<void>;
}): Promise<{ retired: number; copies: number; bytes: number; cancelled: boolean }> {
  const result = { retired: 0, copies: 0, bytes: 0, cancelled: false };
  const records: ReviewedOutput[] = [];
  await ports.assertCurrent();
  for (const candidate of candidates) {
    if (candidate.workerIds.some((id) => !ports.workerIds.includes(id))) throw new Error("旧 attempt 的 Worker 配置已移除；保留产物，无法安全替换。");
    for (const workerId of ports.workerIds) records.push({ ...candidate, workerId, inspection: await ports.inspect(candidate, workerId) });
  }
  const existing = records.filter((record) => record.inspection.exists);
  if (existing.length && !await ports.confirm(existing)) return { ...result, cancelled: true };
  await ports.assertCurrent();
  // Revalidate the entire batch before the first mutation: one changed target aborts all deletes.
  for (const record of records) {
    const current = await ports.inspect(record, record.workerId);
    if (current.fingerprint !== record.inspection.fingerprint || current.exists !== record.inspection.exists)
      throw new Error(`旧 attempt 在审核期间发生变化；未删除：${record.outputDir}`);
  }
  for (const candidate of candidates) {
    await ports.assertCurrent();
    await ports.hold(candidate);
    for (const record of records.filter((row) => row.outputDir === candidate.outputDir && row.inspection.exists)) {
      await ports.assertCurrent();
      const current = await ports.inspect(record, record.workerId);
      if (current.fingerprint !== record.inspection.fingerprint || !current.exists) throw new Error(`删除前旧 attempt 身份发生变化：${record.outputDir}`);
      await ports.remove(record);
      if ((await ports.inspect(record, record.workerId)).exists) throw new Error(`旧 attempt 删除未完成：${record.outputDir}`);
      result.copies++;
      result.bytes += record.inspection.bytes;
    }
    await ports.retired(candidate);
    result.retired++;
  }
  return result;
}
