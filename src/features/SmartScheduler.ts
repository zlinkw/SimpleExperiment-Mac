export interface ResourcePolicy {
  serverId: string;
  enabled: boolean;
  maxConcurrentJobs: number;
  reservedGpuIds?: string[];
  blockedGpuIds?: string[];
  minFreeMemoryMb: number;
  maxUtilizationPercent: number;
  priorityWeight?: number;
}

export interface SchedulingDecision {
  experimentKey: string;
  serverId: string;
  gpuIds: string[];
  reason: string;
  score: number;
  warnings: string[];
}

export interface GpuCandidate {
  serverId: string;
  gpuId: string;
  freeMemoryMb: number;
  utilizationPercent: number;
  runningJobs?: number;
  healthScore?: number;
}

export function dryRunScheduling(experimentKey: string, gpus: GpuCandidate[], policies: ResourcePolicy[], requiredMemoryMb = 0): SchedulingDecision {
  const warnings: string[] = [];
  const scored = gpus.flatMap((gpu) => {
    const policy = policies.find((item) => item.serverId === gpu.serverId);
    if (!policy?.enabled) return [];
    if ((gpu.runningJobs || 0) >= policy.maxConcurrentJobs) return [];
    if (policy.blockedGpuIds?.includes(gpu.gpuId)) return [];
    if (policy.reservedGpuIds?.length && !policy.reservedGpuIds.includes(gpu.gpuId)) warnings.push(`${gpu.serverId}:${gpu.gpuId} not reserved for this policy`);
    if (gpu.freeMemoryMb < Math.max(policy.minFreeMemoryMb, requiredMemoryMb)) return [];
    if (gpu.utilizationPercent > policy.maxUtilizationPercent) return [];
    const score = gpu.freeMemoryMb / 1024 + (gpu.healthScore || 50) / 10 + (policy.priorityWeight || 1) * 10 - gpu.utilizationPercent / 10;
    return [{ gpu, score, policy }];
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { experimentKey, serverId: "", gpuIds: [], reason: "no eligible GPU after policy filtering", score: 0, warnings };
  return {
    experimentKey,
    serverId: best.gpu.serverId,
    gpuIds: [best.gpu.gpuId],
    reason: `selected ${best.gpu.serverId}:${best.gpu.gpuId}; free=${best.gpu.freeMemoryMb}MB util=${best.gpu.utilizationPercent}% health=${best.gpu.healthScore ?? "unknown"}`,
    score: Number(best.score.toFixed(3)),
    warnings,
  };
}

