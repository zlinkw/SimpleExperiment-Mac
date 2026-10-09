export interface Anomaly {
  id: string;
  severity: "info" | "warning" | "critical";
  experimentId?: string;
  serverId?: string;
  type: string;
  message: string;
  evidence: unknown;
  suggestion: string;
  detectedAt: string;
  resolvedAt?: string;
}

export interface AnomalyInput {
  experiments: Array<{ experimentId: string; status: string; serverId?: string; gpuMemoryMb?: number; gpuUtilization?: number; lastLogAt?: string; lastCheckpointAt?: string; logText?: string }>;
  disks?: Array<{ serverId: string; freePercent: number; path: string }>;
  now?: number;
}

export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const now = input.now || Date.now();
  const anomalies: Anomaly[] = [];
  for (const exp of input.experiments) {
    if (["running", "testing"].includes(exp.status)) {
      if ((exp.gpuMemoryMb || 0) === 0) anomalies.push(make("warning", "gpu_zero_memory", exp.experimentId, exp.serverId, "任务运行但 GPU 显存为 0", exp, "检查进程是否启动或配置是否使用 CPU。"));
      if ((exp.gpuUtilization || 0) < 5) anomalies.push(make("info", "gpu_low_util", exp.experimentId, exp.serverId, "GPU 利用率长期偏低", exp, "检查 dataloader、IO 或 batch size。"));
      if (exp.lastLogAt && now - Date.parse(exp.lastLogAt) > 15 * 60_000) anomalies.push(make("warning", "stalled_log", exp.experimentId, exp.serverId, "日志长时间无更新", exp, "查看 live output 或重试该实验。"));
      if (exp.logText && /\bNaN\b|loss[:=]\s*nan/i.test(exp.logText)) anomalies.push(make("critical", "nan_loss", exp.experimentId, exp.serverId, "检测到 NaN loss", { log: exp.logText.slice(-500) }, "降低学习率或检查数据归一化。"));
    }
  }
  for (const disk of input.disks || []) {
    if (disk.freePercent < 5) anomalies.push(make("critical", "disk_low", undefined, disk.serverId, "磁盘空间不足", disk, "清理旧日志或迁移归档。"));
  }
  return dedupeAnomalies(anomalies);
}

export function dedupeAnomalies(items: Anomaly[]): Anomaly[] {
  return Array.from(new Map(items.map((item) => [`${item.type}:${item.experimentId || ""}:${item.serverId || ""}`, item])).values());
}

function make(severity: Anomaly["severity"], type: string, experimentId: string | undefined, serverId: string | undefined, message: string, evidence: unknown, suggestion: string): Anomaly {
  return { id: `${type}:${experimentId || ""}:${serverId || ""}`, severity, experimentId, serverId, type, message, evidence, suggestion, detectedAt: new Date().toISOString() };
}

