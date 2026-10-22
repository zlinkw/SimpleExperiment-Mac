import { quotaSettings } from "../features/GpuQuotaScheduling";

/** Current scheduling configuration only; never starts, recalls or recreates a job. */
export async function syncGpuQuotaPolicies(h: any, root: string) {
  const entries: Map<string, any> = h.gpuQuotaPolicyWrites ||= new Map();
  await Promise.all(h.workerActionTargets().map(async (worker: any) => {
    if (h.lastWorkerProbes?.[worker.id]?.capabilities?.endpoints?.gpuQuotaScheduling !== 1) return;
    const configured = h.enabledWorkerConfigs().find((row: any) => row.id === worker.id);
    const policy = quotaSettings(h.schedulerSettings(), configured, h.lastRealtimeState?.gpu?.[worker.id] || []);
    if (policy.gpuCardOverrides && h.lastWorkerProbes?.[worker.id]?.capabilities?.endpoints?.gpuCardQuotaScheduling !== 1) return;
    if (policy.gpuMaxConcurrentCards !== undefined && h.lastWorkerProbes?.[worker.id]?.capabilities?.endpoints?.gpuCardLimitScheduling !== 1) return;
    const key = JSON.stringify([root, worker.id, worker.project_dir]);
    const signature = JSON.stringify(policy);
    const prior = entries.get(key);
    if (prior?.client === h.client && prior.signature === signature && (prior.promise || Date.now() < prior.retryAt)) return;
    const entry: any = { client: h.client, signature, done: false, retryAt: Date.now() + 30000, promise: undefined };
    entries.set(key, entry);
    const context = h.captureProjectContext?.();
    entry.promise = Promise.resolve(prior?.promise).catch(() => {}).then(() => {
      if (entries.get(key) !== entry || h.client !== entry.client || context && !h.projectContextIsCurrent(context)) return;
      return entry.client.postWorkerAction(worker.id, "configure-gpu-quota", { workerId: worker.id, ...policy });
    })
      .then(() => { entry.done = true; }, (error: any) => { entry.error = String(error.message || error); })
      .finally(() => { entry.promise = undefined; });
    await entry.promise;
  }));
  while (entries.size > 128) entries.delete(entries.keys().next().value!);
}
