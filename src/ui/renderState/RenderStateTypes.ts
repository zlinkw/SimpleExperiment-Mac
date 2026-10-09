/**
 * RenderStateTypes - Webview 渲染状态类型与常量
 * 拆分自 WebviewRenderState.ts (328→模块化)
 * 职责：任务状态优先级、调度桶映射、桶列表常量
 */

export const TASK_STATUS_RANKS: Readonly<Record<string, number>> = Object.freeze({
  running: 0,
  testing: 1,
  queued: 2,
  pending: 2,
  failed: 3,
  completed: 4,
  done: 4,
  stopped: 5,
  unknown: 6,
});

export const SCHEDULER_BUCKET_STATUSES: Readonly<Record<string, string>> = Object.freeze({
  queued_experiments: "queued",
  pending_experiments: "queued",
  running_experiments: "running",
  testing_experiments: "testing",
  completed_experiments: "completed",
  failed_experiments: "failed",
  stopped_experiments: "stopped",
});

export const SCHEDULER_BUCKETS: readonly string[] = Object.freeze(
  Object.keys(SCHEDULER_BUCKET_STATUSES),
);

export type TaskStatus = keyof typeof TASK_STATUS_RANKS;
export type SchedulerBucket = keyof typeof SCHEDULER_BUCKET_STATUSES;
