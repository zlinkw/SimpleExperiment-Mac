import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectFreshResults, freshResultTables, resultDigest, resultPath, type ResultPlan, type ResultSource } from "../results/FreshResults";
import { publishLatestResult } from "../results/LatestResultExport";
import { newestJobOutputs } from "../features/LatestJobArtifacts";

const hosts = new WeakMap<object, ResultCollectionHost>();
export function resultCollectionHost(host: any): ResultCollectionHost {
  let service = hosts.get(host);
  if (!service) { service = new ResultCollectionHost(host); hosts.set(host, service); }
  return service;
}
export class ResultCollectionHost {
  private request?: Promise<any>;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private seen = new Set<string>();
  private scope = "";
  private visibleScope = "";
  constructor(private readonly h: any) {}
  refreshOnVisible() {
    const context = this.h.captureProjectContext();
    const key = context.root + ":" + context.generation;
    if (this.visibleScope === key) return;
    this.visibleScope = key;
    void this.update().catch((error: any) => this.h.recordActionError?.({ command: "updateResultSummary", message: String(error.message || error) }));
  }
  observe(snapshot: any) {
    if (snapshot.queryComplete !== true || snapshot.capabilities?.resultCollection !== 1 || this.h.panelDisposed) return;
    const scope = this.h.captureProjectContext().root || "";
    if (scope !== this.scope) { this.scope = scope; this.seen.clear(); }
    const completed = (snapshot.tasks || []).filter((task: any) => task.observation?.result?.verified === true
      && task.observation.result.runId === task.commandId && task.observation.result.status === "completed"
      && (!task.observation.tmux || task.observation.tmux.dead === true));
    const keys = completed.map((task: any) => scope + "\0" + snapshot.workerId + "\0" + task.commandId + ":" + task.runtimeDiagnostics?.state + ":" + task.runtimeDiagnostics?.scanComplete + ":" + task.runtimeDiagnostics?.count);
    const fresh = keys.filter((key: string) => !this.seen.has(key));
    if (!fresh.length) return;
    fresh.forEach((key: string) => this.seen.add(key));
    this.again = true;
    if (this.timer || this.request) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.h.panelDisposed || this.h.captureProjectContext().root !== scope) return;
      void this.update().then((report: any) => { if (!report.current) fresh.forEach((key: string) => this.seen.delete(key)); }).catch((error: any) => {
        fresh.forEach((key: string) => this.seen.delete(key));
        this.h.recordActionError?.({ command: "updateResultSummary", message: String(error.message || error) });
      });
    }, 250);
    this.timer.unref?.();
  }
  async update(signal?: AbortSignal): Promise<any> {
    if (this.request) return this.request;
    this.again = false;
    const run = this.collect(signal);
    this.request = run;
    try { return await run; } finally {
      if (this.request === run) this.request = undefined;
      // New completions request a separate refresh; they cannot keep the current
      // user's request open through an unbounded sequence of full collections.
      if (this.again && !this.timer && !signal?.aborted && !this.h.panelDisposed) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (this.h.panelDisposed) return;
          void this.update().catch((error: any) => {
            this.seen.clear();
            this.h.recordActionError?.({ command: "updateResultSummary", message: String(error.message || error) });
          });
        }, 250);
        this.timer.unref?.();
      }
    }
  }
  private async collect(signal?: AbortSignal) {
    const h = this.h, context = h.captureProjectContext(), root = context.root;
    if (!root) throw Error("请先打开当前实验项目。");
    const targets = h.workerCodeSyncTargets();
    const projectKey = (value: string) => {
      const normalized = String(value || "").replaceAll("\\", "/");
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    const queuedPlans = () => (h.distributedQueueCache?.plans || []).filter((plan: any) => projectKey(plan.projectId) === projectKey(root));
    const runBindings = () => newestJobOutputs({ plans: queuedPlans() }).map(({ plan, job }) => ({
      planFile: plan.planFile, workflowId: plan.id, revision: plan.revision, codeFingerprint: plan.codeFingerprint,
      index: job.index, case: job.case, seed: job.seed, outputDir: job.outputDir, collectionResultCsv: job.collectionResultCsv,
      commandId: job.commandId, workerId: job.workerId }));
    let owners: string | undefined;
    const key = () => JSON.stringify(h.workerCodeSyncTargets().map((row: any) => [row.id, row.host, row.user, row.port, row.remotePath, row.condaEnv]));
    const binding = key();
    const current = () => !signal?.aborted && h.projectContextIsCurrent(context) && key() === binding
      && (owners === undefined || owners === JSON.stringify(runBindings()));
    const check = () => { if (!current()) throw Error("结果查询已取消或项目/服务器配置已变化。"); };
    const started = Date.now(), timing: Record<string, number> = {};
    const inputs = await h.currentResultPlanInputs(); check();
    timing.localPlansMs = Date.now() - started;
    const discoveryStarted = Date.now();
    const plans: ResultPlan[] = [], declarationErrors: string[] = [];
    // A transport failure belongs to this refresh, not to each of its PLANs.
    // Do not quarantine declaration mismatches: another PLAN on this Worker may be valid.
    const unavailable = new Map<string, string>();
    const discover = async (plan: any): Promise<ResultPlan | undefined> => {
      let jobs: any[] | undefined;
      for (const worker of targets) {
        if (unavailable.has(worker.id)) continue;
        try {
          let response: any;
          try { response = await h.client.getWorkerTasks(worker.id, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
            discovery: { planFile: plan.planFile, condaEnv: worker.condaEnv || "", collect: true } }); }
          catch (error: any) {
            const message = String(error.message || error);
            if (error.name === "TimeoutError" || /fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|socket hang up|network error/i.test(message))
              unavailable.set(worker.id, message);
            throw error;
          }
          check();
          if (response.queryComplete !== true || response.capabilities?.resultCollection !== 1) throw Error("请更新此 Worker 的 Agent/Scheduler，以支持直接结果读取");
          if (!Array.isArray(response.declaredJobs) || !response.declaredJobs.length || response.declaredJobs.some((job: any) => job.planHash !== plan.revision))
            throw Error("服务器 PLAN 与当前本机声明不一致，未使用旧路径");
          jobs = response.declaredJobs; break;
        } catch (error: any) { declarationErrors.push(plan.planFile + " · " + worker.id + "：" + String(error.message || error)); }
      }
      if (!jobs) return undefined;
      const declared = jobs.map((job: any) => ({ planFile: resultPath(plan.planFile), index: Number(job.index), case: String(job.case), seed: Number(job.seed),
        output_dir: resultPath(job.output_dir), result_csv: job.result_csv ? resultPath(job.result_csv) : "", mode: plan.mode }));
      if (declared.some((job: any) => !Number.isInteger(job.index) || !Number.isInteger(job.seed) || !job.case || !["train", "test", "train_test"].includes(job.mode))) throw Error("PLAN_JOB_DECLARATION_INVALID");
      return { ...plan, jobs: declared };
    };
    // Bound pressure on slow tunnels and preserve PLAN order. All enabled Workers
    // still receive the complete declarations/file verification below.
    for (let offset = 0; offset < inputs.length; offset += 4) {
      const settled = await Promise.allSettled(inputs.slice(offset, offset + 4).map(discover));
      const failed = settled.find(row => row.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      for (const row of settled) if (row.status === "fulfilled" && row.value) plans.push(row.value);
      check();
    }
    timing.declarationsMs = Date.now() - discoveryStarted;
    const observationStarted = Date.now();
    const declarations = plans.flatMap(plan => plan.jobs.map(job => ({ ...job, collect: true })));
    const snapshots = await Promise.all(targets.map(async (worker: any) => {
      const values = [];
      try {
        for (let offset = 0; offset < Math.max(1, declarations.length); offset += 500) {
          const value = await h.client.getWorkerTasks(worker.id, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
            queries: [], declarations: declarations.slice(offset, offset + 500) }); check();
          if (value.queryComplete !== true || value.capabilities?.resultCollection !== 1) throw Error(value.error || "请更新 Agent/Scheduler：直接结果查询不可用");
          values.push(value);
        }
        return { workerId: worker.id, queryComplete: true, tasks: values.flatMap(value => value.tasks || []), declaredResults: values.flatMap(value => value.declaredResults || []) };
      } catch (error: any) { return { workerId: worker.id, queryComplete: false, error: String(error.message || error) }; }
    })); check();
    timing.observationsMs = Date.now() - observationStarted;
    const receiveStarted = Date.now(); let memoryRequests = 0, memoryFiles = 0;
    const receive = async (workerId: string, files: ResultSource[]) => {
      const capability = await h.simpleSftpCapability("sync.downloadMappedPaths"); check();
      if (capability.methodOptions?.["sync.downloadMappedPaths"]?.memoryOnly !== true
        || capability.methodOptions?.["sync.downloadMappedPaths"]?.memoryWrapperResults !== true) throw Error("请更新 SimpleSFTP：需要内存指标读取能力");
      const server = h.sftpServerOptions(targets.find((row: any) => row.id === workerId));
      const output = [];
      const batches: ResultSource[][] = [];
      for (const file of files) {
        const batch = batches[batches.length - 1];
        if (batch && batch.reduce((sum, row) => sum + row.bytes, 0) + file.bytes <= 4 * 1024 * 1024) batch.push(file);
        else batches.push([file]);
      }
      for (const batch of batches) {
        memoryRequests++; memoryFiles += batch.length;
        const response = await h.simpleSftpApiCall("sync.downloadMappedPaths", { server, localPath: root,
          entries: batch.map(file => ({ ...file, localRelativePath: file.remotePath })), memoryOnly: true, metricsOnly: true, wrapperResults: true,
          maxFileBytes: 4 * 1024 * 1024, maxBatchBytes: 4 * 1024 * 1024, confirm: true, pathConfirmed: true, signal }); check();
        if (!response?.memoryOnly || response.ok === false || response.entries?.length !== batch.length) throw Error("RESULT_MEMORY_READ_INCOMPLETE");
        for (const entry of response.entries) {
          const file = batch.find(row => row.remotePath === entry.remotePath);
          if (!file || typeof entry.dataBase64 !== "string" || entry.dataBase64.length > 4 * Math.ceil(file.bytes / 3)) throw Error("RESULT_MEMORY_READ_UNDECLARED");
          const bytes = Buffer.from(entry.dataBase64, "base64");
          if (bytes.toString("base64") !== entry.dataBase64 || bytes.length !== file.bytes || entry.sha256 !== file.sha256 || entry.bytes !== file.bytes)
            throw Error("RESULT_CONTENT_CHANGED: " + file.remotePath);
          output.push({ remotePath: file.remotePath, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) });
        }
      }
      return output;
    };
    // Queue metadata supplies provenance/ownership only, never result bytes or proof.
    const queued = queuedPlans(), bindings = runBindings(); owners = JSON.stringify(bindings);
    const result = await collectFreshResults(plans, snapshots, receive, (text, job) => h.parseFreshResultMetric(text, job), h.resultAdapterRules().planDatasetMapping || {}, current, bindings); check();
    timing.metricsMs = Date.now() - receiveStarted;
    // A failed declaration cannot make an entire PLAN silently disappear from a new export.
    result.errors.push(...declarationErrors);
    for (const plan of inputs.filter((row: any) => !plans.some(item => item.planFile === row.planFile))) {
      result.jobs.push({ planFile: plan.planFile, index: -1, case: "", seed: 0, outputDir: "", state: "unknown", error: "无法核实当前 PLAN 声明" });
    }
    if (inputs.length && !plans.length) result.querySucceeded = false;
    for (const plan of inputs) {
      if (resultDigest(await fs.readFile(path.join(root, resultPath(plan.planFile)), "utf8")) !== plan.revision) throw Error("PLAN 已变化，未发布过期结果。");
    }
    check();
    const publicationStarted = Date.now();
    const tables = { ...freshResultTables(result, plans, h.resultAdapterRules().derivedMetric),
      ...Object.fromEntries(Object.entries(freshResultTables(result, plans, h.resultAdapterRules().derivedMetric, true)).map(([key, value]) => ["review/" + key, value])) };
    const directory = h.resultCsvDirectory || "experiments/results";
    const published = await publishLatestResult(root, directory, result, tables, current); check();
    timing.publicationMs = Date.now() - publicationStarted;
    const participating = new Set<string>([...queued.map((plan: any) => plan.planFile),
      ...result.jobs.filter(job => job.state !== "missing" && (job.commandId || job.error || job.state === "conflict" || job.executionState === "running")).map(job => job.planFile)]);
    const coverage = Object.fromEntries(inputs.map((plan: any) => [plan.planFile, {
      included: participating.has(plan.planFile),
      expected: plans.find(row => row.planFile === plan.planFile)?.jobs.length || plan.jobCount || 0,
      completed: result.jobs.filter(job => job.planFile === plan.planFile && job.state === "complete" && job.aggregationState === "eligible").length,
      artifactsComplete: result.jobs.filter(job => job.planFile === plan.planFile && job.state === "complete").length,
      reviewRequired: result.jobs.filter(job => job.planFile === plan.planFile && job.state === "complete" && job.aggregationState === "review_required").length }]));
    const report = { source: "active_query", observedAt: result.observedAt, current: published, merged: published, downloaded: result.records.length > 0, planCoverage: coverage,
      queryTiming: timing, memoryRequests, memoryFiles,
      plans: plans.map(plan => plan.planFile), discovered: inputs.length, included: [...new Set(result.records.map(row => row.planFile))],
      missing: result.jobs.filter(job => participating.has(job.planFile) && job.state !== "complete").map(job => job.planFile + " · " + job.case + "/" + job.seed + "：" + (job.error || job.state)),
      skipped: result.errors, jobs: result.jobs, completed: result.jobs.filter(job => job.state === "complete" && job.aggregationState === "eligible").length,
      reviewRequired: result.jobs.filter(job => job.state === "complete" && job.aggregationState === "review_required").length,
      artifactsComplete: result.jobs.filter(job => job.state === "complete").length, expected: Object.values(coverage).filter(row => row.included).reduce((sum, row) => sum + row.expected, 0),
      catalogExpected: Object.values(coverage).reduce((sum, row) => sum + row.expected, 0),
      unobservedDeclarations: Object.values(coverage).filter(row => !row.included).reduce((sum, row) => sum + row.expected, 0),
      tables: Object.values(tables).map(table => ({ tableKey: table.tableKey, dataset: table.dataset, relativePath: table.relativePath, markdownPath: table.markdownPath })),
      results: result.records.map(row => ({ planFile: row.planFile, workerId: row.workerId, runId: row.runId, dimensions: { case: row.case, seed: row.seed, method: row.method,
        dataset: row.dataset, rate_percent: row.rate, eval_protocol: row.endpoint }, metrics: row.metrics, sourceFiles: [{ path: row.jobDir }],
        aggregationState: result.jobs.find(job => job.commandId === row.runId)?.aggregationState,
        workflowId: row.workflowId, revision: row.revision, codeFingerprint: row.codeFingerprint, executionWorkerId: row.executionWorkerId,
        completionState: result.jobs.find(job => job.commandId === row.runId)?.completionState,
        runtimeDiagnostics: result.jobs.find(job => job.commandId === row.runId)?.runtimeDiagnostics })) };
    h.resultsSummary = report;
    const { results: _records, tables: _tables, jobs: _jobs, ...brief } = report;
    h.resultSyncReport = brief;
    if (published) await h.refreshLocalResultCatalogForProject(context);
    timing.totalMs = Date.now() - started;
    h.postState?.(); return report;
  }
}
