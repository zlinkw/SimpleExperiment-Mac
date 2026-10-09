const test = require("node:test");
const assert = require("node:assert/strict");

const sync = require("../dist/syncState.js");

test("deletion ledger records merge without dropping local records", () => {
  // 提交二去重收敛：syncState.dedupeJsonRecords 已删（他处全删），此处以内联 Map 去重保留语义规格；
  // 服务器去重唯一入口见 tunnel/XshellTunnelSetup.dedupeWorkerTunnels，GPU/诊断各自保留。
  const dedupeInline = (records) => {
    const out = new Map();
    for (const record of records) {
      if (!record || !Object.keys(record).length) continue;
      out.set(JSON.stringify(record), record);
    }
    return Array.from(out.values());
  };
  const local = [{ hub_job_dir: "work_dirs/a", deleted_at: "local" }];
  const remote = [{ hub_job_dir: "work_dirs/b", deleted_at: "remote" }];
  assert.deepEqual(dedupeInline([...local, ...remote]), [...local, ...remote]);
});

test("retired blacklist filter preserves experiment index records", () => {
  const entries = [
    { run_id: "1_case", global_job_id: "", hub_job_dir: "work_dirs/1_case", worker_job_dir: "/srv/project/work_dirs/1_case", native_job_dir: "", hub_console_log: "", results_csv: "", checkpoint_path: "", suite: "", case: "", seed: "", worker_id: "", worker_host: "", synced_at: "" },
    { run_id: "2_case", global_job_id: "", hub_job_dir: "work_dirs/2_case", worker_job_dir: "/srv/project/work_dirs/2_case", native_job_dir: "", hub_console_log: "", results_csv: "", checkpoint_path: "", suite: "", case: "", seed: "", worker_id: "", worker_host: "", synced_at: "" },
  ];
  const filtered = sync.filterExperimentIndex(entries, [{ hub_job_dir: "/hub/project/work_dirs/1_case" }]);
  assert.deepEqual(filtered, entries);
});

test("retired scheduler blacklist leaves persisted state untouched", () => {
  const state = {
    plan: "experiments/plans/demo.yaml",
    scheduler_session: "sched-1",
    pending_experiments: [1, 2],
    running_experiments: [{ experiment_index: 1, worker_id: "w1", session: "s1" }],
    testing_experiments: [{ experiment_index: 1, worker_id: "w1", session: "s1" }],
    completed_experiments: [{ experiment_index: 1, worker_id: "w1", session: "s1" }],
    failed_experiments: [{ experiment_index: 1, worker_id: "w1", session: "s1" }],
    stopped_experiments: [{ experiment_index: 1, worker_id: "w1", session: "s1" }],
  };
  const { state: next, changed } = sync.filterSchedulerState(state, [{ suite: "demo", experimentIndex: "1", workerId: "w1", schedulerSession: "sched-1", session: "s1", deleteMode: "row" }]);
  assert.equal(changed, false);
  assert.deepEqual(next.pending_experiments, [1, 2]);
  for (const key of ["running_experiments", "testing_experiments", "completed_experiments", "failed_experiments", "stopped_experiments"]) {
    assert.deepEqual(next[key], state[key]);
  }
});

test("legacy scheduler tombstone does not match newer run rows", () => {
  const state = {
    plan: "experiments/plans/demo.yaml",
    running_experiments: [{ experiment_index: 1, worker_id: "w1", started_at: "2026-06-30T01:00:00Z" }],
  };
  const { state: next, changed } = sync.filterSchedulerState(state, [{ suite: "demo", experimentIndex: "1", workerId: "w1", deleteMode: "row", deletedAt: "2026-06-29T01:00:00Z" }]);
  assert.equal(changed, false);
  assert.equal(next.running_experiments.length, 1);
});

test("retired tombstone does not delete scheduler runs", () => {
  const state = {
    plan: "experiments/plans/demo.yaml",
    scheduler_session: "sched-new",
    running_experiments: [
      { experiment_index: 1, worker_id: "w1", session: "old", log_path: "simple_cluster/tmp/cluster_scheduler/logs/old.log" },
      { experiment_index: 1, worker_id: "w1", session: "new", log_path: "simple_cluster/tmp/cluster_scheduler/logs/new.log" },
    ],
  };
  const { state: next } = sync.filterSchedulerState(state, [{ experimentIndex: "1", workerId: "w1", schedulerSession: "sched-new", session: "new", logPath: "simple_cluster/tmp/cluster_scheduler/logs/new.log", deleteMode: "row" }]);
  assert.deepEqual(next.running_experiments.map((row) => row.session), ["old", "new"]);
});

test("legacy scheduler tombstone does not clear pending from new scheduler session", () => {
  const state = {
    plan: "experiments/plans/demo.yaml",
    scheduler_session: "sched-new",
    pending_experiments: [1, 2],
  };
  const { state: next, changed } = sync.filterSchedulerState(state, [{ suite: "demo", experimentIndex: "1", workerId: "w1", deleteMode: "row", deletedAt: "2026-06-29T01:00:00Z" }]);
  assert.equal(changed, false);
  assert.deepEqual(next.pending_experiments, [1, 2]);
});

test("cleanup pending tombstone only affects the matching scheduler session", () => {
  const state = {
    plan: "experiments/plans/demo.yaml",
    scheduler_session: "sched-new",
    pending_experiments: [1, 2],
  };
  const { state: next, changed } = sync.filterSchedulerState(state, [{
    suite: "demo",
    experimentIndex: "1",
    schedulerSession: "sched-old",
    affectsPending: true,
    deleteMode: "row",
    deletedAt: "2026-06-30T01:00:00Z",
  }]);
  assert.equal(changed, false);
  assert.deepEqual(next.pending_experiments, [1, 2]);
});

test("retired log blacklist preserves scheduler evidence", () => {
  const state = {
    plan: "demo",
    completed_experiments: [{ experiment_index: 3, worker_id: "w1", hub_console_log: "simple_cluster/console_logs/a.log", console_tail: "tail", sync_error: "x" }],
  };
  const { state: next } = sync.filterSchedulerState(state, [{ experimentIndex: "3", workerId: "w1", deleteMode: "log_fields" }]);
  assert.equal(next.completed_experiments.length, 1);
  assert.equal(next.completed_experiments[0].hub_console_log, "simple_cluster/console_logs/a.log");
  assert.equal(next.completed_experiments[0].console_tail, "tail");
  assert.equal(next.completed_experiments[0].sync_error, "x");
});

test("path matching covers relative, hub absolute, worker absolute, and legacy archive paths", () => {
  const candidates = sync.normalizedPathSet(["/hub/MiniMultiModal/work_dirs/4_case"]);
  assert.equal(sync.pathMatchesAny("work_dirs/4_case", candidates), true);
  assert.equal(sync.pathMatchesAny("/worker/MiniMultiModal/work_dirs/4_case/checkpoint.pth", candidates), true);
  assert.equal(sync.pathMatchesAny("simple_cluster/archive/work_dirs/4_case", candidates), false);
  assert.equal(sync.pathMatchesAny("experiments/results/demo.csv", sync.normalizedPathSet(["/hub/MiniMultiModal/experiments/results/demo.csv"])), true);
});

test("managed artifact path cleanup filters polluted stdout lines", () => {
  assert.deepEqual(sync.cleanManagedArtifactPaths([
    "[simple] worker_conda_env=simple python=/env/bin/python",
    "work_dirs/multirun/demo/1_case",
    "/srv/project/work_dirs/multirun/demo/2_case",
  ]), [
    "work_dirs/multirun/demo/1_case",
    "/srv/project/work_dirs/multirun/demo/2_case",
  ]);
});

test("scheduler entry matcher derives experiment index from deleted artifact entry", () => {
  const matcher = sync.schedulerEntryDeleteMatcher({ run_id: "", global_job_id: "", hub_job_dir: "work_dirs/7_case_seed1", worker_job_dir: "", native_job_dir: "", suite: "demo", case: "", seed: "", worker_id: "w1", worker_host: "host", synced_at: "" });
  assert.equal(matcher.experimentIndex, "7");
  assert.equal(matcher.deleteMode, "row");
});
