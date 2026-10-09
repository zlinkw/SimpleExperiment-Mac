const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isLongRunningPlanOperation,
  reconcileRunOperation,
  runOperationMatchesTarget,
  restorePlanOperationsFromWorkerTasks,
  mergeReconciledRunOperation,
} = require("../../dist/features/RunOperations");

const running = {
  operationId: "run-plan-old",
  type: "run-plan",
  status: "running",
  planFile: "experiments/plans/demo.yaml",
  startedAt: "2026-01-01T00:00:00.000Z",
};

test("long-running plan operations include run and reproduce but exclude terminal records", () => {
  assert.equal(isLongRunningPlanOperation(running), true);
  assert.equal(isLongRunningPlanOperation({ ...running, type: "reproduce-plan" }), true);
  assert.equal(isLongRunningPlanOperation({ ...running, status: "completed" }), false);
});

test("orphan local runs stays running with manual hint after the bounded reconciliation grace", () => {
  const evidence = { pidAlive: false, tmuxSessionAlive: false, schedulerStatesCount: 0, experimentTracesCount: 0, liveLogCount: 0 };
  const fresh = reconcileRunOperation(running, evidence, "workflow.plan", Date.parse(running.startedAt) + 1000);
  assert.equal(fresh.terminal, false);
  assert.equal(fresh.patch.reconcileEvidenceActive, false);

  const stale = reconcileRunOperation(running, evidence, "activation", Date.parse(running.startedAt) + 91_000);
  // 定案：取消 stale 终态，保持 running 由用户手动处理
  assert.equal(stale.terminal, false);
  assert.equal(stale.patch.status, "running");
  assert.equal(stale.patch.finishedAt, undefined);
  assert.match(stale.patch.message, /未自动终结/);
  assert.match(stale.patch.reconcileReason, /no_remote_activity$/);
});

test("remote terminal or active evidence wins over the local pending record", () => {
  const terminal = reconcileRunOperation(running, {
    operation: { status: "failed", message: "remote stopped" },
    pidAlive: false,
  }, "activation", Date.now());
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.patch.status, "failed");

  const active = reconcileRunOperation(running, {
    operation: { status: "running" },
    tmuxSessionAlive: true,
    liveLogCount: 4,
    liveLogUpdatedAt: new Date().toISOString(),
  }, "activation", Date.now());
  assert.equal(active.terminal, false);
  assert.equal(active.patch.status, "running");
  assert.equal(active.patch.reconcileEvidenceActive, true);
});

test("historical scheduler snapshots do not make an exited process active", () => {
  const result = reconcileRunOperation(running, {
    pidAlive: true,
    tmuxPythonRunning: false,
    checkedTmuxSession: "zlk-sch-old",
    tmuxSessionAlive: false,
    schedulerStatesCount: 1,
    experimentTracesCount: 5,
  }, "activation", Date.parse(running.startedAt) + 120_000);
  assert.equal(result.patch.reconcileEvidenceActive, false);
});

test("stop targets match plan, operation, run key, pid, or tmux identity", () => {
  assert.equal(runOperationMatchesTarget(running, { planFile: "experiments\\plans\\demo.yaml" }), true);
  assert.equal(runOperationMatchesTarget(running, { operationId: "run-plan-old" }), true);
  assert.equal(runOperationMatchesTarget(running, { runKey: "run-plan-old" }), true);
  assert.equal(runOperationMatchesTarget({ ...running, pid: 123 }, { pid: "123" }), true);
  assert.equal(runOperationMatchesTarget({ ...running, tmuxSession: "simple-scheduler" }, { tmuxSession: "simple-scheduler" }), true);
  assert.equal(runOperationMatchesTarget(running, { planFile: "other.yaml" }), false);
});

test("stop targets still match reconciled stale submissions", () => {
  const stale = { ...running, status: "stale" };
  assert.equal(isLongRunningPlanOperation(stale), false);
  assert.equal(runOperationMatchesTarget(stale, { planFile: running.planFile }), true);
  assert.equal(runOperationMatchesTarget(stale, { operationId: running.operationId }), true);
});

test("tmux-alive with real activity stays running (no false stale)", () => {
  const active = reconcileRunOperation(running, {
    tmuxSessionAlive: true,
    pidAlive: false,
    schedulerStatesCount: 0,
    liveLogCount: 4,
    liveLogUpdatedAt: new Date().toISOString(),
  }, "activation", Date.now());
  assert.equal(active.terminal, false);
  assert.equal(active.patch.status, "running");
});

test("pid-alive with no activity stays running (real process trusted)", () => {
  const active = reconcileRunOperation(running, {
    pidAlive: true,
    tmuxSessionAlive: false,
    schedulerStatesCount: 0,
    liveLogCount: 0,
    liveLogUpdatedAt: new Date().toISOString(),
  }, "activation", Date.now());
  assert.equal(active.terminal, false);
  assert.equal(active.patch.status, "running");
});

test("tmux-alive but no activity stays running with manual hint after the grace window", () => {
  // First reconcile seeds reconcileNoActivitySince=now; simulate a later reconcile
  // where no activity has been observed for longer than the grace period.
  const seeded = reconcileRunOperation(running, {
    tmuxSessionAlive: true,
    pidAlive: false,
    schedulerStatesCount: 0,
    liveLogCount: 0,
  }, "activation", Date.now());
  assert.equal(seeded.terminal, false);
  const noActivitySince = seeded.patch.reconcileNoActivitySince;
  assert.ok(noActivitySince);
  const stale = reconcileRunOperation({ ...running, reconcileNoActivitySince: noActivitySince }, {
    tmuxSessionAlive: true,
    pidAlive: false,
    schedulerStatesCount: 0,
    liveLogCount: 0,
  }, "activation", noActivitySince + 91_000);
  // 定案：取消 stale 终态，保持 running 由用户手动处理
  assert.equal(stale.terminal, false);
  assert.equal(stale.patch.status, "running");
  assert.equal(stale.patch.finishedAt, undefined);
  assert.match(stale.patch.message, /未自动终结/);
  assert.match(stale.patch.reconcileReason, /tmux_alive_no_activity$/);
});

test("reconnect restores the live plan from the worker scheduler task without reviving old terminal history", () => {
  const tasks = { tasks: [
    { kind: "scheduler", action: "run-plan", operationId: "old", planFile: "experiments/plans/a.yaml", status: "running", startedAt: "2026-09-18T10:00:00Z" },
    { kind: "scheduler", action: "run-plan", operationId: "current", planFile: "experiments/plans/a.yaml", status: "running", pid: 42, tmuxSession: "scheduler-a", startedAt: "2026-09-19T10:00:00Z" },
    { kind: "worker-task", action: "run-plan", operationId: "child", planFile: "experiments/plans/a.yaml", status: "running" },
  ] };
  const restored = restorePlanOperationsFromWorkerTasks({ old: { status: "failed", type: "run-plan" } }, tasks, "nwpu3");
  assert.equal(restored.old.status, "failed");
  assert.equal(restored.current.status, "running");
  assert.equal(restored.current.pid, 42);
  assert.equal(restored.current.tmuxSession, "scheduler-a");
  assert.equal(restored.current.schedulerOwnerWorkerId, "nwpu3");
  assert.equal(restored.child, undefined);
  assert.equal(restorePlanOperationsFromWorkerTasks({ current: { status: "interrupted" } }, tasks, "nwpu3").current.status, "interrupted");
});

test("a missing known scheduler is shown as interrupted and can recover when it reappears", () => {
  const startedAt = "2026-09-19T10:00:00Z";
  const missing = reconcileRunOperation({ ...running, startedAt, pid: 42 }, {
    checkedPid: 42, pidAlive: false, tmuxSessionAlive: false,
    workerTasksCount: 5, logTail: "wait pending=26 running=3",
  }, "activation", Date.parse(startedAt) + 120_000);
  assert.equal(missing.terminal, false);
  assert.equal(missing.patch.status, "interrupted");
  const recovered = reconcileRunOperation(missing.patch, {
    checkedPid: 42, pidAlive: true, tmuxSessionAlive: true,
    operation: { status: "running" },
  }, "tunnel_reconnected", Date.parse(startedAt) + 130_000);
  assert.equal(recovered.patch.status, "running");
});

test("restarting does not make the same historical interruption look new", () => {
  const startedAt = "2026-09-19T10:00:00Z";
  const missingEvidence = { checkedPid: 42, pidAlive: false, tmuxSessionAlive: false };
  const first = reconcileRunOperation({ ...running, startedAt, pid: 42 }, missingEvidence,
    "activation", Date.parse(startedAt) + 120_000).patch;
  const again = reconcileRunOperation(first, missingEvidence,
    "tunnel_reconnected", Date.parse(startedAt) + 360_000).patch;
  assert.equal(again.status, "interrupted");
  assert.equal(again.updatedAt, first.updatedAt);
  assert.equal(again.interruptedAt, first.interruptedAt);
  assert.notEqual(again.reconcileCheckedAt, first.reconcileCheckedAt);
});

test("a live tmux shell without scheduler Python is interrupted after grace", () => {
  const startedAt = "2026-09-19T10:00:00Z";
  const result = reconcileRunOperation({ ...running, startedAt, pid: 42, tmuxSession: "scheduler-a" }, {
    checkedPid: 42, checkedTmuxSession: "scheduler-a", pidAlive: true,
    tmuxSessionAlive: false, tmuxPythonRunning: false,
    logTail: "wait pending=26 running=3",
  }, "activation", Date.parse(startedAt) + 120_000);
  assert.equal(result.patch.status, "interrupted");
});

test("old running events cannot hide a newer interrupted scheduler check", () => {
  const checked = { status: "interrupted", message: "调度中断", updatedAt: "2026-09-19T12:00:00Z", evidence: { pidAlive: false } };
  const merged = mergeReconciledRunOperation(checked, { status: "running", message: "started", updatedAt: "2026-09-19T10:00:00Z" });
  assert.equal(merged.status, "interrupted");
  assert.equal(merged.message, "调度中断");
  assert.equal(merged.updatedAt, checked.updatedAt);
  assert.deepEqual(merged.evidence, checked.evidence);
  assert.equal(mergeReconciledRunOperation(checked, { status: "failed" }).status, "failed");
});
