const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("agent commands expose status, tree, logs, control, results, and json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-agent-"));
  const log = [
    "2026-01-02T00:00:00Z INFO training started",
    ...Array.from({ length: 60 }, (_value, index) => `2026-01-02T00:${String(index).padStart(2, "0")}:00Z INFO step ${index}`),
    "2026-01-02T01:00:00Z ERROR CUDA out of memory",
  ].join("\n");
  writeProject(dir, {
    "experiments/plans/bus_p100.yaml": "suite: bus\nseeds: [42, 43]\nbase_config: configs/base.yaml\ndataset: data/train\nmodel: resnet\noptimizer: adam\nbatch_size: 8\nepochs: 20\ncases:\n  - case: baseline\n",
    "configs/base.yaml": "model: resnet\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-plan-1", type: "run-plan", case: "workflow", status: "failed", plan: "experiments/plans/bus_p100.yaml", seed: 42, started_at: "2026-01-02T00:00:00Z", finished_at: "2026-01-02T01:00:00Z", stdout: "experiments/runs/run-plan-1/stdout.log" },
      { global_job_id: "run-100", type: "run", case: "worker", status: "failed", plan: "experiments/plans/bus_p100.yaml", seed: 43, parent_id: "run-plan-1", started_at: "2026-01-02T00:10:00Z", finished_at: "2026-01-02T00:40:00Z" },
    ], null, 2),
    "experiments/runs/run-plan-1/stdout.log": `${log}\n`,
    "experiments/runs/run-plan-1/artifact_manifest.json": JSON.stringify({ files: [{ path: "metrics.csv", size: 12 }] }, null, 2),
    "experiments/runs/run-plan-1/metrics.csv": "metric,value\nauc,0.8\n",
    "simple_cluster/results/result_registry.json": JSON.stringify({ records: [
      { schemaVersion: 1, resultId: "res-a", experimentId: "run-plan-1", runKey: "run-plan-1", suite: "bus", experimentName: "a", status: "parsed", sourceFiles: [], metrics: { auc: { value: 0.80 }, loss: { value: 0.40 } }, dimensions: { seed: 42 }, primaryMetric: "auc", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T01:00:00Z", provenance: {} },
      { schemaVersion: 1, resultId: "res-b", experimentId: "run-100", runKey: "run-100", suite: "bus", experimentName: "b", status: "parsed", sourceFiles: [], metrics: { auc: { value: 0.90 }, loss: { value: 0.20 }, f1: { value: 0.70 } }, dimensions: { seed: 43 }, primaryMetric: "auc", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T01:00:00Z", provenance: {} },
    ] }, null, 2),
  });

  const listed = JSON.parse((await runCli(["experiment", "list", "--json", "--full"], { cwd: dir })).stdout);
  assert.equal(listed[0].status, "failed");
  for (const key of ["id", "type", "parent_id", "created_at", "started_at", "finished_at", "duration", "status", "health_status", "health_reason"]) {
    assert.ok(key in listed[0], key);
  }

  const tree = JSON.parse((await runCli(["experiment", "tree", "--json"], { cwd: dir })).stdout);
  assert.equal(tree[0].type, "workflow");
  assert.equal(tree[0].children[0].type, "worker_run");
  assert.ok(["id", "type", "stage", "status"].every((key) => key in tree[0].children[0]));

  const status = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(status.children.length >= 1);

  const monitor = await runCli(["experiment", "monitor", "run-100", "--json", "--full"], { cwd: dir });
  assert.equal(monitor.code, 0);
  const monitorPayload = JSON.parse(monitor.stdout);
  assert.equal(monitorPayload.status, "failed");
  assert.ok("epoch" in monitorPayload && "batch" in monitorPayload && "loss" in monitorPayload && "gpu" in monitorPayload);
  const monitorDefault = JSON.parse((await runCli(["experiment", "monitor", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in monitorDefault, false);
  assert.equal("health_status" in monitorDefault, true);
  assert.equal("updated_at" in monitorDefault, true);
  assert.ok(monitorDefault.latest_message.length <= 300);
  const monitorFull = JSON.parse((await runCli(["experiment", "monitor", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(monitorFull.recentLogs.length <= 20);
  assert.ok(monitorFull.recentLogs.every((line) => line.length <= 200));

  const shown = JSON.parse((await runCli(["log", "show", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.ok(shown.some((row) => row.level === "INFO"));
  assert.ok(shown.some((row) => row.level === "ERROR"));
  assert.ok(shown.every((row) => "timestamp" in row && "level" in row && "message" in row));
  const tail = JSON.parse((await runCli(["log", "tail", "run-plan-1", "--lines", "100", "--json"], { cwd: dir })).stdout);
  assert.ok(tail.length <= 100);

  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(diagnosis.status, "failed");
  assert.deepEqual(diagnosis.reason, ["cuda out of memory"]);
  assert.equal("evidence" in diagnosis, false);
  const diagnosisFull = JSON.parse((await runCli(["experiment", "diagnose", "run-plan-1", "--json", "--full"], { cwd: dir })).stdout);
  assert.ok(diagnosisFull.evidence.length <= 20);
  assert.ok(diagnosisFull.evidence.every((line) => line.length <= 200));
  assert.ok(diagnosisFull.evidence.some((line) => /out of memory/i.test(line)));
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.equal("active_runs" in summary, false);
  assert.ok(Array.isArray(summary.recent_failures));
  assert.ok(summary.recent_failures.length <= 5);

  const stopped = await runCli(["experiment", "stop", "run-plan-1", "--json"], { cwd: dir });
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.stdout, /stopExperiment|Local API/);
  const paused = await runCli(["experiment", "pause", "run-plan-1", "--json"], { cwd: dir });
  assert.equal(paused.code, 3);
  assert.match(JSON.parse(paused.stdout).error.message, /EXPERIMENT_PAUSE_UNSUPPORTED/);
  const resumed = JSON.parse((await runCli(["experiment", "resume", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(resumed.submitPath, "features/Lifecycle.retryExperiment");
  const retried = JSON.parse((await runCli(["experiment", "retry", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(retried.submitted, false);

  const config = JSON.parse((await runCli(["experiment", "config", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.match(config.config_path, /bus_p100\.yaml/);
  assert.match(config.yaml, /resnet/);
  assert.equal(String(config.seed), "42");
  assert.equal(config.dataset, "data/train");
  assert.equal(config.model, "resnet");
  assert.equal(config.optimizer, "adam");
  assert.equal(config.batch_size, "8");
  assert.equal(config.epoch, "20");

  const results = JSON.parse((await runCli(["experiment", "results", "run-plan-1", "--json"], { cwd: dir })).stdout);
  assert.equal(results.experiment_id, "run-plan-1");
  assert.ok(results.result_ids.includes("res-a"));
  assert.equal(results.metrics["res-a"].auc, 0.8);
  assert.equal(results.metrics["res-b"], undefined);
  const metric = JSON.parse((await runCli(["metric", "show", "run-100", "--json"], { cwd: dir })).stdout);
  assert.equal(metric.auc, 0.9);
  assert.equal(metric.f1, 0.7);
  assert.equal("accuracy" in metric, false);

  const compared = JSON.parse((await runCli(["compare", "run-plan-1", "run-100", "--json"], { cwd: dir })).stdout);
  assert.equal(compared.metric_difference.auc.delta, 0.1);
  assert.ok(compared.improvement.includes("auc"));
  assert.ok(compared.improvement.includes("loss"));
  assert.equal(compared.metric_difference.f1, undefined);

  const batch = JSON.parse((await runCli(["experiment", "batch", "bus_p100.yaml", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(Object.keys(batch.seeds).sort(), ["42", "43"]);
  assert.ok(batch.status.failed.length >= 2);

  const dry = JSON.parse((await runCli(["experiment", "run", "experiments/plans/bus_p100.yaml", "--dry-run", "--json"], { cwd: dir })).stdout);
  assert.equal(dry.submitted, false);
  assert.match(dry.wouldExecute, /workflow\.run/);
  const checked = JSON.parse((await runCli(["experiment", "run", "experiments/plans/bus_p100.yaml", "--check", "--json"], { cwd: dir })).stdout);
  assert.equal(checked.submitted, false);
  assert.equal(checked.checks.config.status, "true");
  assert.equal(checked.checks.data.status, "unknown");
  assert.equal(checked.checks.gpu.status, "unknown");

  const resource = JSON.parse((await runCli(["resource", "available", "--json"], { cwd: dir })).stdout);
  assert.ok(Array.isArray(resource));
  const gpu = JSON.parse((await runCli(["gpu", "status", "--json"], { cwd: dir })).stdout);
  assert.ok(Array.isArray(gpu));

  const artifacts = JSON.parse((await runCli(["artifact", "list", "run-plan-1", "--json"], { cwd: dir })).stdout);
  const inspected = JSON.parse((await runCli(["artifact", "inspect", artifacts[0].id, "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.size, fs.statSync(path.join(dir, "experiments", "runs", "run-plan-1", "metrics.csv")).size);
  assert.ok(inspected.mtime);
  assert.equal(inspected.hash.length, 64);
  const copy = path.join(dir, "copy.csv");
  const downloaded = await runCli(["artifact", "download", artifacts[0].id, "--out", copy, "--json"], { cwd: dir });
  assert.equal(downloaded.code, 0);
  assert.equal(fs.existsSync(copy), true);

  const compact = JSON.parse((await runCli(["experiment", "status", "run-plan-1", "--compact-json"], { cwd: dir })).stdout);
  assert.equal("recentLogs" in compact, false);
  const failure = await runCli(["experiment", "status", "--compact-json"], { cwd: dir });
  assert.notEqual(failure.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(failure.stdout).error).sort(), ["code", "detail", "message"]);

  const help = await runCli(["--help"]);
  for (const text of ["tree", "overview", "health", "monitor", "diagnose", "stop", "pause", "resume", "config", "results", "batch", "log", "metric", "compare", "resource available", "artifact inspect", "experiment diagnose", "experiment stop"]) {
    assert.match(help.stdout, new RegExp(text.replace(/[.]/g, "\\.")));
  }
});
