import { transferPreparedArtifacts, type PreparedArtifactCopy } from "../features/ArtifactBatchTransfer";
import { newestJobOutputs, jobArtifactScopes, latestJobSyncKey } from "../features/LatestJobArtifacts";
import { canonicalProjectId } from "../features/DistributedPlanQueue";
import { loadSyncHolds } from "../features/SyncResolution";
import { jobArtifactSyncDigest } from "../features/PlanArtifactSyncStatus";
import { artifactStageBlockFromError, jobArtifactRetentionKey } from "../features/JobArtifactSyncIdentity";
import { UiCommandCancelled } from "../core/UiCommandCancelled";

type JobSelection = { planId: string; index: number; commandId: string };

/**
 * r46 A: one local eligibility check for the SELECTED jobs, shared by the pre-queue validation and the
 * runCore re-validation. Identical conditions to the historical runCore filter — projectId, protocol-2
 * completed status, worker/command identity, and the newest-output/cleanup/retired exclusions of
 * newestJobOutputs. It never widens to other jobs and never queries Worker job state.
 */
function selectedJobsEligible(queue: any, root: string, jobs: JobSelection[]): boolean {
  const pending = newestJobOutputs(queue).filter(({ plan, job }: any) => plan.projectId === canonicalProjectId(root)
    && job.lifecycleProtocol === 2 && job.status === "completed" && !job.unavailable && !!job.workerId && !!job.commandId);
  return jobs.every(selection => pending.some(({ plan, job }: any) => plan.id === selection.planId
    && job.index === selection.index && job.commandId === selection.commandId));
}

/** A cleared/replaced selection is a cancellation, not a sync failure: it ends only this waiter. */
function clearedSelectionCancellation(): UiCommandCancelled {
  return new UiCommandCancelled("所选任务已被本地清退或被新的运行替代，本次等待已结束，未开始新的传输；已有产物保持不变。", "SELECTED_JOB_CLEARED");
}

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
  async run(selected: string[], options: { force?: boolean; verifyOnly?: boolean; jobs?: JobSelection[] } = {}): Promise<{ synced: number; excluded: number; errors: string[] }> {
    const h = this.h;
    if (h.workerCodeSyncTargets().length < 2) return { synced: 0, excluded: 0, errors: [] };
    const runs = h.completedJobSyncRuns ||= new Map();
    const key = JSON.stringify([selected, options.verifyOnly === true, options.jobs || null]);
    const active = runs.get(this.root);
    if (active) {
      if (active.key === key || !options.force) return active.promise;
      // r46 A: validate the selected jobs once BEFORE queueing (same local check as runCore's re-validation;
      // a stale or empty selection at request time keeps the historical failure wording — an empty
      // selection must never fall back to an unbounded wait behind the active round).
      if (options.jobs && (!options.jobs.length
        || !selectedJobsEligible(await h.loadDistributedQueue(this.root), this.root, options.jobs)))
        throw Error("所选任务未完成或身份已变化，未同步其他任务。");
      // The wait must end when this request's OWN selection is cleared/replaced by a committed queue
      // write, or when the surrounding project context is gone. It never cancels, resolves or removes
      // another owner's active run, never resets the single-flight map and never cancels SFTP work.
      const observers: Set<(root: string) => void> = h.distributedQueueCommitObservers ||= new Set();
      const controller = new AbortController();
      // Real context-cancellation reasons are preserved verbatim (a workspace switch is reported as
      // such; only a proven selection clear/replacement carries SELECTED_JOB_CLEARED).
      const contextSignal: AbortSignal | undefined = h.projectContextAbortController?.signal;
      const abortForContext = () => {
        if (controller.signal.aborted) return;
        const reason = contextSignal?.reason instanceof UiCommandCancelled ? contextSignal.reason
          : new UiCommandCancelled("项目或连接已变化，未继续产物操作。");
        controller.abort(reason);
      };
      const wake = (changedRoot: string) => {
        if (changedRoot !== this.root || controller.signal.aborted) return;
        if (!this.current()) abortForContext();
        else if (options.jobs?.length && h.distributedQueueCache
          && !selectedJobsEligible(h.distributedQueueCache, this.root, options.jobs))
          controller.abort(clearedSelectionCancellation());
      };
      // Wire the rejectable abort path FIRST, then every subscription, then re-check the already
      // committed snapshot — a clear/abort that happened before registration can never be lost.
      const cancelled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      observers.add(wake);
      let detachContext: (() => void) | undefined;
      if (contextSignal) {
        if (contextSignal.aborted) abortForContext();
        else {
          const onContextAbort = () => abortForContext();
          contextSignal.addEventListener("abort", onContextAbort, { once: true });
          detachContext = () => contextSignal.removeEventListener("abort", onContextAbort);
        }
      }
      try {
        wake(this.root); // immediate re-check against the CURRENT committed snapshot and context
        await Promise.race([active.promise, cancelled]);
      } finally {
        observers.delete(wake);
        detachContext?.(); // release on completion, rejection AND cancellation
      }
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
      // r46 A: start-time re-validation through the same shared local check as the pre-queue validation.
      if (!options.jobs.length || !selectedJobsEligible(queue, this.root, options.jobs)) throw Error("所选任务未完成或身份已变化，未同步其他任务。");
      pending = pending.filter(({ plan, job }) => options.jobs!.some(selection => plan.id === selection.planId
        && job.index === selection.index && job.commandId === selection.commandId));
    }
    const copies: Array<{ copy: PreparedArtifactCopy; finish: (result: any) => Promise<void>; fail: (error: any) => Promise<void> }> = [];
    try {
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
      if (!scopes.length) { await patch({ latestArtifactSync: { key, state: "excluded", scopes, checkedAt: new Date().toISOString() }, artifactError: undefined, artifactRetryAfter: undefined, artifactStageBlock: undefined }); report.excluded++; continue; }
      const finish = async (result: any) => {
        if (!result || result.errors.length) throw Error(result?.errors?.join("；") || "同步未完成");
        await assertCurrent();
        await patch({ latestArtifactSync: { key, state: "synced", scopes, workerIds: targets.map((row: any) => row.id), checkedAt: new Date().toISOString(),
          // r10：仅当本次确实分类出他端历史保留副本时写入最小可选字段（完整日志已含路径与原因）；
          // 成功含义只限本次当前 job 已验证来源域，不声称其它 Worker 历史副本已合并或清除。
          artifactDigest: jobArtifactSyncDigest({ artifacts: { ...job.artifacts, ...result.files } }),
          ...(result.foreignOnly?.length ? { skipped: result.foreignOnly } : {}) },
          artifactError: undefined, artifactRetryAfter: undefined, artifactStageBlock: undefined, artifacts: { ...job.artifacts, ...result.files },
          ...(scopes.includes(job.outputDir) && (!job.collectionResultCsv || job.actualExecutionMode === "train" || scopes.includes(job.collectionResultCsv))
            ? { mirroredWorkerIds: targets.map((row: any) => row.id), replaceMirroredWorkerIds: true } : {}) });
        report.synced++;
      };
      const fail = async (error: any) => {
        if (!this.current()) throw error;
        const detail = String(error.message || error), retryAfter = new Date(Date.now() + 30000).toISOString();
        report.errors.push(plan.planFile + " job " + job.index + "：" + detail);
        // 0.2.113 配套：错误原文逐字保留在 detail/artifactError；结构化卡点仅当错误携带
        // schemaVersion-1 stageBlock 时白名单净化后随同一 patch 持久化（无结构化字段=只有文本，
        // 不猜路径）。同一次写也把上轮的旧卡点冲掉，失败原因变化后不留过期释放入口。
        await patch({ latestArtifactSync: { key, state: "partial", scopes, error: detail, retryAfter, checkedAt: new Date().toISOString() },
          artifactError: "最新产物同步未完成：" + detail, artifactRetryAfter: retryAfter,
          artifactStageBlock: artifactStageBlockFromError(error) });
        if (artifactStageBlockFromError(error)) h.ensureStagedSlotReleaseCapabilities?.();
        const isNewFailureSignature = previous?.key !== key || previous.error !== detail;
        if (isNewFailureSignature)
          h.recordActionError({ command: "completedJobLatestSync", message: plan.planFile + " job " + job.index + "：" + detail });
        // r47 B: an automatic round's REAL sync failure is surfaced once through the existing native
        // notice (5s/32-key dedupe inside it) within the same-signature dedupe. Cancellations (typed,
        // never message-string guesses) are not failures; manual force runs keep the single
        // withUiCommandStatus notice funnel and get no second popup here. The 30s auto-retry and
        // same-generation reconcile remain: this asks the user to act only after those kept working.
        const isCancellation = error instanceof UiCommandCancelled || error?.code === "SELECTED_JOB_CLEARED" || error?.code === "REQUEST_REPLACED";
        if (!options.force && isNewFailureSignature && !isCancellation) {
          // A PROVEN local clear/replacement silences this notice; a re-check that cannot read the
          // queue is an unknown, never a proven retirement — the real failure still gets surfaced,
          // with the re-check error attached so the user sees why identity could not be confirmed.
          let stillThisRun = true, recheckFailure: string | undefined;
          try { stillThisRun = newestJobOutputs(await h.loadDistributedQueue(this.root)).some(row => row.plan.id === plan.id
            && row.job.index === job.index && row.job.commandId === job.commandId); }
          catch (recheckError: any) { stillThisRun = true; recheckFailure = String(recheckError?.message || recheckError); }
          if (stillThisRun && this.current())
            h.showNativePanelMessage?.({ tone: "error", message: `产物同步 ${plan.planFile} job ${job.index} 未完成：${detail}。运行完成状态不变，可在该 Job 行重新同步。`
              + (recheckFailure ? `（队列复核暂不可用：${recheckFailure}）` : "") });
        }
      };
      try {
        await assertCurrent();
        // r10：本次已记录且落在选定 scope 内的 job.artifacts 必要项进入强校验（其它 scope 条目不强加）；
        // 旧记录在此核"必要路径存在"：merge 侧要求当前来源有已校验版本，foreign-only/缺失仍 partial；
        // 来源以本次明确的当前最新版为准（主控 r11 复审确认既有契约）——冻结后来源漂移照常开新代重传，
        // 复制落地 SHA 与本次冻结清单不符仍逐文件阻断；专用链正式镜像冲突的原规则不受影响。
        const samePath = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        const requiredArtifacts = Object.fromEntries(Object.entries<string>(job.artifacts || {}).filter(([file]) => scopes.some(scope => samePath(file, scope))));
        // r10：merge 的阶段与 foreign-only 分类完整路径/原因进入既有操作日志通道（缺通道不影响操作）。
        const result = await h.mergeLatestWorkerVersions(this.root, targets, scopes, ".",
          (stage: string) => h.logOperationFact?.(`产物同步 ${plan.planFile} job ${job.index}：${stage}`), {
          // r5 P2 身份块：从真实队列行透传五元组身份（与专用链逐字同构）与 plan.id/commandId；
          // 队列行缺失身份时根本进不了 pending（L40 过滤），此处不臆造。
          completedJob: {
            sourceId: job.workerId, planId: plan.id, commandId: job.commandId,
            retentionKey: jobArtifactRetentionKey(plan.planFile, job.index, job.case, job.seed),
            requiredArtifacts,
          }, assertCurrent, verifyOnly: options.verifyOnly, prepareOnly: pending.length > 1,
        });
        if (result?.preparedArtifactCopy) { copies.push({ copy: result.preparedArtifactCopy, finish, fail }); continue; }
        await finish(result);
      } catch (error: any) { await fail(error); }
    }
    const outcomes = await transferPreparedArtifacts(copies.map(row => row.copy));
    for (const [index, row] of copies.entries()) {
      const result = outcomes[index];
      if (result.errors.length) await row.fail(result.failure || Error(result.errors.join("；")));
      else { try { await row.finish(result); } catch (error) { await row.fail(error); } }
    }
    } finally { for (const row of copies) row.copy.release(); }
    return report;
  }
}
