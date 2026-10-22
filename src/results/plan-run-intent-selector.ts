// 重跑意图的 workflow 实例选择器：纯函数、零 vscode 依赖，供 legacy 提交意图分支与 vm 提取测试直接复用。
// - 重跑批次身份哈希盐与旧实现同输入同序列化 → ordinal 0 与历史 id 完全兼容，旧完成批次仍被识别为同范围族；
// - 同范围批次全部终结后不再永久挡块：新人类重跑点击推进 -r<N> 新意图实例，创建新批次卡（旧批次历史保留，不清空）；
// - 同范围存在未终结批次（queued/running/pending/unknown/缺状态）→ activeRunId 非空，调用方必须维持挡块：不建新批、不重复派发，不绕精确停止围栏；
// - 同一队列状态下重复解析结果恒等：同意图的网络重试/断线恢复稳定复用同一实例，不双派。
export interface RerunWorkflowInstanceDecision {
  workflowId: string;
  activeRunId: string;
  familyRunCount: number;
}

const TERMINAL_JOB_STATUSES = new Set(["cancelled", "canceled", "completed", "expired", "failed", "skipped", "success", "succeeded"]);

export function rerunWorkflowBaseId(scopeKey: string): string {
  return "distributed-plan-rerun-" + String(scopeKey || "").trim();
}

function jobIsTerminal(job: unknown): boolean {
  const status = String((job as Record<string, unknown>)?.status || "").trim().toLowerCase();
  return TERMINAL_JOB_STATUSES.has(status);
}

export function selectRerunWorkflowInstance(queue: unknown, scopeKey: string): RerunWorkflowInstanceDecision {
  const base = rerunWorkflowBaseId(scopeKey);
  const instancePattern = new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:-r(0|[1-9][0-9]*))?$");
  const plans = Array.isArray((queue as Record<string, any>)?.plans) ? ((queue as Record<string, any>).plans as Record<string, any>[]) : [];
  let maxOrdinal = -1;
  let activeOrdinal = -1;
  let activeRunId = "";
  let familyRunCount = 0;
  for (const plan of plans) {
    // 真实队列的 cleanup 是对象记录（清理主机），不存在 cleanup===true 形态；清理卡照常计入族，
    // 是否挡新批只取决于族内 job 终态（清理进行中不阻断已终结批次的再次重跑）。
    if (!plan) continue;
    const id = String(plan.id || "");
    const match = instancePattern.exec(id);
    if (!match) continue;
    const ordinal = Number(match[1] ?? 0);
    familyRunCount += 1;
    if (ordinal > maxOrdinal) maxOrdinal = ordinal;
    const jobs = Array.isArray(plan.jobs) ? plan.jobs : [];
    // 空 job 列表无法证明终结，与未知状态一样保守视为未终结。
    const active = jobs.length === 0 || jobs.some(job => !jobIsTerminal(job));
    if (active && ordinal > activeOrdinal) { activeOrdinal = ordinal; activeRunId = id; }
  }
  const nextOrdinal = maxOrdinal + 1;
  return { workflowId: base + (nextOrdinal > 0 ? "-r" + nextOrdinal : ""), activeRunId, familyRunCount };
}
