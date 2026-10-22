import { observationTiming } from "./WorkerProgressEvidence";

/** Progress reads never send a cached observation or a launch payload back to the Worker. */
export function progressQuery(task: any) {
  return Object.fromEntries(["commandId", "projectId", "workerId", "outputDir", "collectionResultCsv",
    "experimentIndex", "case", "seed", "mode", "executionMode", "checkpointTestOnly", "runtimeLogAnalysisId"]
    .filter(key => task[key] !== undefined).map(key => [key, task[key]]));
}
type Receipt = (value: any, timing?: any, error?: unknown) => void;
type Job = { query: any; receipt: Receipt; offset?: number };
const queues = new WeakMap<object, Map<string, { jobs: Map<string, Job>; active: Map<string, Job>; running: boolean }>>();

/** One fair, bounded background queue per Worker/connection. Metadata deadlines
 * cannot cancel log progress. Only the latest subscriber for an exact run is kept. */
export function enqueueProgressDiagnostics(client: any, workerId: string, query: any, receipt: Receipt) {
  let scopes = queues.get(client);
  if (!scopes) { scopes = new Map(); queues.set(client, scopes); }
  const generation = client.clients?.get(workerId)?.progressGeneration ?? client.progressGeneration ?? 0;
  const scope = workerId + ":" + generation;
  for (const key of scopes.keys()) if (key.startsWith(workerId + ":") && key !== scope) scopes.delete(key);
  let queue = scopes.get(scope);
  if (!queue) { queue = { jobs: new Map(), active: new Map(), running: false }; scopes.set(scope, queue); }
  const q = progressQuery(query), key = JSON.stringify([q.projectId, q.commandId, q.outputDir, q.collectionResultCsv]);
  const existing = queue.jobs.get(key) || queue.active.get(key);
  if (existing) { existing.query = q; existing.receipt = receipt; return; }
  if (queue.jobs.size + queue.active.size >= 256) return;
  queue.jobs.set(key, { query: q, receipt });
  if (queue.running) return;
  queue.running = true;
  const current = () => scopes!.get(scope) === queue
    && (client.clients?.get(workerId)?.progressGeneration ?? client.progressGeneration ?? 0) === generation;
  void (async () => {
    try {
      while (current() && queue!.jobs.size) {
        const batch = [...queue!.jobs.entries()].slice(0, 4);
        for (const [id, job] of batch) { queue!.jobs.delete(id); queue!.active.set(id, job); }
        const startedAt = new Date().toISOString();
        try {
          const value: any = await client.getWorkerTasks(workerId, { selectedOnly: true, observationOnly: true,
            diagnosticsOnly: true, queries: batch.map(([, job]) => job.query) });
          if (!current()) return;
          if (value?.queryComplete !== true || value.error) throw Error(value?.error || "运行日志核实未完成");
          for (const [id, job] of batch) {
            job.receipt(value, observationTiming(value, startedAt));
            const task = value.tasks?.find((t: any) => t.projectId === job.query.projectId && t.commandId === job.query.commandId
              && t.workerId === workerId);
            const evidence = task?.observation?.runtimeDiagnostics;
            // Continue an incremental scan without waiting for another complete
            // metadata round. No-progress/unavailable reads wait for a new pull.
            if (!task?.observation?.queryError && !task?.observation?.runtimeQueryError && ["scanning", "anomalous"].includes(evidence?.state)
              && !evidence.scanComplete && evidence.commandId === job.query.commandId && evidence.runId === job.query.commandId
              && Number.isSafeInteger(evidence.bytesRead) && evidence.bytesRead > (job.offset ?? 0)) {
              job.offset = evidence.bytesRead;
              queue!.jobs.set(id, job);
            }
          }
        } catch (error) {
          if (current()) for (const [, job] of batch) job.receipt(undefined, undefined, error);
        } finally { for (const [id] of batch) queue!.active.delete(id); }
        // Bound synchronous mocks and give metadata/control admission a turn.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { queue!.running = false; }
  })();
}
