import { newestJobOutputs, jobArtifactScopes, latestJobSyncKey } from "../features/LatestJobArtifacts";
import { canonicalProjectId } from "../features/DistributedPlanQueue";
import { loadSyncHolds } from "../features/SyncResolution";
import { jobArtifactSyncDigest } from "../features/PlanArtifactSyncStatus";

/**
 * Per-job completion publication reuses the file tree's newest-version merge, never the whole PLAN gate.
 * Item 46 account split: this round's start permission checks only the local facts — exact queue
 * identity, the confirmed completed status already carried by the queue row, and the sync-holds write
 * safety — and never borrows a job-state query. Source freezing (the inventory manifest taken before
 * the copy) and the destination byte SHA256 comparison belong to the sync body itself; during the
 * copy only the local stop/identity/safety re-checks run.
 */
export class CompletedJobSyncHost {
  constructor(private readonly h: any, private readonly root: string, private readonly current: () => boolean) {}
  async run(selected: string[], options: { force?: boolean; verifyOnly?: boolean; jobs?: { planId: string; index: number; commandId: string }[] } = {}): Promise<{ synced: number; excluded: number; errors: string[] }> {
    const runs = this.h.completedJobSyncRuns ||= new Map();
    const key = JSON.stringify([selected, options.verifyOnly === true, options.jobs || null]);
    const active = runs.get(this.root);
    if (active) {
      if (active.key === key || !options.force) return active.promise;
      await active.promise;
      if (!this.current()) throw Error("项目或连接已变化，未继续产物操作。");
      return this.run(selected, options);
    }
    const entry = { key, promise: undefined as any };
    entry.promise = this.runCore(selected, options).finally(() => { if (runs.get(this.root) === entry) runs.delete(this.root); });
    runs.set(this.root, entry);
    return entry.promise;
  }
  private async runCore(selected: string[], options: { force?: boolean; verifyOnly?: boolean; jobs?: { planId: string; index: number; commandId: string }[] }) {
    const report = { synced: 0, excluded: 0, errors: [] as string[] };
    const h = this.h, targets = h.workerCodeSyncTargets();
    if (targets.length < 2) {
      if (options.force) throw Error("至少需要两台已启用 Worker 核对产物同步。");
      return report;
    }
    const queue = await h.loadDistributedQueue(this.root);
    let pending = newestJobOutputs(queue).filter(({ plan, job }) => plan.projectId === canonicalProjectId(this.root)
      && job.lifecycleProtocol === 2 && job.status === "completed" && !job.unavailable && !!job.workerId && !!job.commandId);
    if (options.jobs) {
      if (!options.jobs.length || options.jobs.some(selection => !pending.some(({ plan, job }) => plan.id === selection.planId
        && job.index === selection.index && job.commandId === selection.commandId))) throw Error("所选任务未完成或身份已变化，未同步其他任务。");
      pending = pending.filter(({ plan, job }) => options.jobs!.some(selection => plan.id === selection.planId
        && job.index === selection.index && job.commandId === selection.commandId));
    }
    for (const { plan, job } of pending) {
      if (!this.current()) throw Error("项目或连接已变化，产物操作已停止。");
      const scopes = jobArtifactScopes({ ...job, executionMode: plan.executionMode }, selected);
      const key = latestJobSyncKey(plan, job, scopes, targets), previous = job.latestArtifactSync;
      if (!options.force && previous?.key === key && (previous.state === "excluded" || previous.state === "synced"
        && (!previous.artifactDigest || previous.artifactDigest === jobArtifactSyncDigest(job)) || Date.parse(previous.retryAfter || "") > Date.now())) continue;
      const assertCurrent = async () => {
        if (!this.current()) throw Error("同步已停止：项目、连接或清理操作已变化。");
        const latest = newestJobOutputs(await h.loadDistributedQueue(this.root));
        if (!latest.some(row => row.plan.id === plan.id && row.job.index === job.index && row.job.commandId === job.commandId
          && !row.job.outputRetiredAt && !row.job.cleanup)) throw Error("这项产物已被新的运行或清理操作替代，未继续同步。");
        const holds = await loadSyncHolds(h.context.globalStorageUri.fsPath, this.root);
        const overlap = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        if (Object.entries(holds).some(([file, hold]) => hold.status !== "resolved"
          && Date.parse(hold.deletedAt || "") >= (Date.parse(plan.enqueuedAt) || 0) && scopes.some(scope => overlap(scope, file))))
          throw Error("这些文件在本次运行后被用户删除或暂停同步，未自动补回。");
      };
      const patch = (fields: any) => h.patchDistributedJob(this.root, plan.id, job.index, job.attempt,
        { expectedCommandId: job.commandId, ...fields });
      if (!scopes.length) { await patch({ latestArtifactSync: { key, state: "excluded", scopes, checkedAt: new Date().toISOString() }, artifactError: undefined, artifactRetryAfter: undefined }); report.excluded++; continue; }
      try {
        await assertCurrent();
        const result = await h.mergeLatestWorkerVersions(this.root, targets, scopes, ".", () => {}, {
          completedJob: { sourceId: job.workerId }, assertCurrent, verifyOnly: options.verifyOnly,
        });
        if (!result || result.errors.length) throw Error(result?.errors?.join("；") || "同步未完成");
        await assertCurrent();
        await patch({ latestArtifactSync: { key, state: "synced", scopes, workerIds: targets.map((row: any) => row.id), checkedAt: new Date().toISOString(),
          artifactDigest: jobArtifactSyncDigest({ artifacts: { ...job.artifacts, ...result.files } }) },
          artifactError: undefined, artifactRetryAfter: undefined, artifacts: { ...job.artifacts, ...result.files },
          ...(scopes.includes(job.outputDir) && (!job.collectionResultCsv || job.actualExecutionMode === "train" || scopes.includes(job.collectionResultCsv))
            ? { mirroredWorkerIds: targets.map((row: any) => row.id), replaceMirroredWorkerIds: true } : {}) });
        report.synced++;
      } catch (error: any) {
        if (!this.current()) throw error;
        const detail = String(error.message || error), retryAfter = new Date(Date.now() + 30000).toISOString();
        report.errors.push(plan.planFile + " job " + job.index + "：" + detail);
        await patch({ latestArtifactSync: { key, state: "partial", scopes, error: detail, retryAfter, checkedAt: new Date().toISOString() },
          artifactError: "最新产物同步未完成：" + detail, artifactRetryAfter: retryAfter });
        if (previous?.key !== key || previous.error !== detail)
          h.recordActionError({ command: "completedJobLatestSync", message: plan.planFile + " job " + job.index + "：" + detail });
      }
    }
    return report;
  }
}
