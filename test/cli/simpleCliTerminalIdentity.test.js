const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("terminal worker history suppresses stale runtime observation", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.status = "success";
  history.finished_at = "2026-09-24T05:39:11Z";
  history.updated = history.finished_at;
  history.progress = { epoch: 102, percent: 33.8 };
  const priorProgress = history.progress;
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.has(observation.run_id), false);
  assert.equal(history.id, "run0-326826-291");
  assert.equal(history.status, "success");
  assert.equal(history.source, "history");
  assert.equal(history.run_id, history.id);
  assert.equal(history.progress, priorProgress);
  assert.equal(history.updated, history.finished_at);
  assert.equal(history.raw.runtimeRunId, observation.run_id);
  assert.equal(history.raw.workerTaskId, history.id);
});

test("terminal history outranks direct running task id", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.status = "success";
  history.finished_at = "2026-09-24T05:39:11Z";
  observation.worker_task = { id: history.id, status: "running", plan: history.plan, gpu_id: "0", experiment_case: "A", seed: "42", started_at: history.created, finished_at: "" };
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.deepEqual([...byId.keys()], [history.id]);
  assert.equal(history.status, "success");
  assert.equal(history.source, "history");
  assert.equal(history.raw.runtimeRunId, observation.run_id);
});

test("exact runtime alias cannot revive terminal worker history", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.status = "success";
  history.run_id = observation.run_id;
  history.finished_at = "2026-09-24T05:39:11Z";
  history.updated = history.finished_at;
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.has(observation.run_id), false);
  assert.equal(history.status, "success");
  assert.equal(history.source, "history");
  assert.equal(history.run_id, observation.run_id);
  assert.equal(history.updated, history.finished_at);
});

test("ambiguous terminal and running history leave runtime observation separate", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const terminal = { ...history, id: "run0-terminal", run_id: "run0-terminal", status: "success", raw: {} };
  const byId = new Map([[terminal.id, terminal], [history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(terminal.source, "history");
  assert.equal(history.source, "history");
  assert.equal(byId.has(observation.run_id), true);
});

test("runtime observations attach only to nonterminal workflows", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { observation } = physicalWorkerFixture();
  const completed = { id: "wf-completed", type: "workflow", status: "success", plan: observation.plan };
  const running = { id: "wf-running", type: "workflow", status: "running", plan: observation.plan };
  const withRunning = new Map([[completed.id, completed], [running.id, running]]);
  await applyRuntimeObservations(withRunning, [observation]);
  assert.equal(withRunning.get(observation.run_id).parent_id, running.id);
  const terminalOnly = new Map([[completed.id, completed]]);
  await applyRuntimeObservations(terminalOnly, [observation]);
  assert.equal(terminalOnly.get(observation.run_id).parent_id, "");
});

test("retries on one GPU keep older worker history separate", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const older = { ...history, id: "run0-older", run_id: "run0-older", created: "2026-09-23T09:50:00Z", raw: {} };
  const byId = new Map([[older.id, older], [history.id, history]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.size, 2);
  assert.equal(older.source, "history");
  assert.equal(older.run_id, older.id);
  assert.equal(history.source, "runtime_observation");
  assert.equal(history.run_id, observation.run_id);
});

test("ambiguous physical matches do not consume an observation", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const second = { ...history, id: "run0-second", run_id: "run0-second", created: "2026-09-23T09:55:45Z", raw: {} };
  const byId = new Map([[history.id, history], [second.id, second]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(history.source, "history");
  assert.equal(second.source, "history");
  assert.equal(byId.has(observation.run_id), true);
});

test("one history row does not choose the first of multiple runtime candidates", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  const second = { ...observation, run_id: "run-1790157345723" };
  const byId = new Map([[history.id, history]]);
  await applyRuntimeObservations(byId, [observation, second]);
  assert.equal(history.source, "history");
  assert.equal(byId.has(observation.run_id), true);
  assert.equal(byId.has(second.run_id), true);
});

test("exact run ID matching takes priority and preserves an existing workflow parent", async () => {
  const { applyRuntimeObservations } = require("../../dist/cli/commands/experiment.js");
  const { history, observation } = physicalWorkerFixture();
  history.run_id = observation.run_id;
  history.parent_id = "wf-existing";
  const byId = new Map([[history.id, history], ["wf-existing", { id: "wf-existing", type: "workflow", status: "running", plan: history.plan }]]);
  await applyRuntimeObservations(byId, [observation]);
  assert.equal(byId.size, 2);
  assert.equal(history.id, "run0-326826-291");
  assert.equal(history.run_id, observation.run_id);
  assert.equal(history.parent_id, "wf-existing");
});

test("historical workflow parents are inferred only from a unique exact time window", () => {
  const { backfillWorkflowParents } = require("../../dist/cli/commands/experiment.js");
  const plan = "experiments/plans/demo.yaml";
  const workflow = (id, start, end, overrides = {}) => ({ id, type: "workflow", status: "failed", plan, worker_id: "worker-a", created: start, finished_at: end, ...overrides });
  const run = (id, start, overrides = {}) => ({ id, type: "worker_run", plan, worker_id: "worker-a", started_at: start, parent_id: "", ...overrides });
  const first = workflow("workflow-a", "2026-09-23T00:00:00Z", "2026-09-23T00:10:00Z");
  const later = workflow("workflow-b", "2026-09-23T00:20:00Z", "2026-09-23T00:30:00Z");
  const matched = run("run-1", "2026-09-23T00:05:00Z", { plan: ".\\experiments\\plans\\demo.yaml" });
  backfillWorkflowParents([first, later, matched]);
  assert.equal(matched.parent_id, first.id);

  const overlap = workflow("workflow-overlap", "2026-09-23T00:04:00Z", "2026-09-23T00:08:00Z");
  const ambiguous = run("run-2", "2026-09-23T00:05:00Z");
  backfillWorkflowParents([first, overlap, ambiguous]);
  assert.equal(ambiguous.parent_id, "");

  const explicit = run("run-3", "2026-09-23T00:05:00Z", { parent_id: "explicit-parent" });
  backfillWorkflowParents([first, explicit]);
  assert.equal(explicit.parent_id, "explicit-parent");

  const otherPlan = run("run-4", "2026-09-23T00:05:00Z", { plan: "other/demo.yaml" });
  const otherWorker = run("run-5", "2026-09-23T00:05:00Z", { worker_id: "worker-b" });
  const missingStart = run("run-6", "");
  const unknownOpen = workflow("workflow-unknown", "2026-09-23T00:00:00Z", "", { status: "unknown" });
  const unknownRun = run("run-7", "2026-09-23T00:05:00Z");
  backfillWorkflowParents([first, otherPlan, otherWorker, missingStart]);
  backfillWorkflowParents([unknownOpen, unknownRun]);
  assert.equal(otherPlan.parent_id, "");
  assert.equal(otherWorker.parent_id, "");
  assert.equal(missingStart.parent_id, "");
  assert.equal(unknownRun.parent_id, "");
});
