const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("partial runtime progress survives and stays shared", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-partial-progress-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "base_config: configs/base.yaml",
      "python -m train --config plan.yaml",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const monitor = JSON.parse((await runCli(["experiment", "monitor", id, "--json"], args)).stdout);
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", id, "--json"], args)).stdout);
  assert.notEqual(status.progress, null);
  assert.equal(status.progress.epoch, 4);
  assert.equal(status.progress.loss, null);
  assert.deepEqual(monitor.progress, status.progress);
  assert.deepEqual(diagnosis.progress, status.progress);
  assert.deepEqual(status.worker, monitor.worker);
  assert.deepEqual(status.gpu, diagnosis.gpu);
  assert.equal(status.stage, monitor.stage);
  assert.equal(status.health_status, diagnosis.health_status);
  assert.match(monitor.latest_message, /epoch 4\/10/);
  assert.doesNotMatch(monitor.latest_message, /yaml|config|python/i);
});

test("inspect is a self contained experiment view", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-view-"));
  const updated = "2026-03-01T00:00:00Z";
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "epoch 1/10 loss --",
      "epoch 2/10 loss null",
      "epoch 3/10 loss N/A",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        plan: "plan.yaml",
        worker_id: "worker-a",
        updated,
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const id = "run-1789994720003";
  const status = JSON.parse((await runCli(["experiment", "status", id, "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", id, "--json"], args)).stdout);
  for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) assert.equal(key in inspected.snapshot, true, key);
  assert.equal(inspected.snapshot.runtime_version, status.updated_at);
  assert.equal(inspected.snapshot.runtime_version, inspected.progress.updated_at);
  for (const key of ["worker", "gpu", "stage", "health_status"]) {
    assert.deepEqual(inspected.status[key], status[key], key);
  }
  assert.deepEqual(Object.keys(inspected.health).sort(), ["reason", "status"]);
  assert.equal(inspected.alerts.missing_progress, false);
  assert.equal(inspected.alerts.recent_failure, false);
  assert.equal(typeof inspected.alerts.stalled, "boolean");
  assert.match(inspected.diagnosis.latest_message, /loss 0\.31/);
  assert.doesNotMatch(inspected.diagnosis.latest_message, /loss --|loss null|N\/A/i);
  assert.equal(typeof inspected.diagnosis.stale_seconds, "number");
});

test("inspect schema keeps one responsibility per field", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-schema-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        worker_id: "worker-a",
        updated: new Date().toISOString(),
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
        gpu: { id: "0" },
      },
      { global_job_id: "run-old-fail", type: "run", status: "failed", updated: "2020-01-01T00:00:00Z" },
      { global_job_id: "run-new-fail", type: "run", status: "failed", updated: new Date().toISOString() },
    ], null, 2),
  });
  const args = { cwd: dir };
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  for (const key of ["snapshot", "summary", "status", "progress", "health", "diagnosis", "alerts"]) {
    assert.equal(key in inspected, true, key);
  }
  for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) {
    assert.equal(key in inspected.snapshot, true, key);
    assert.equal(key in inspected.status, false, key);
  }
  assert.equal("progress" in inspected.diagnosis, false);
  assert.equal("runtime" in inspected.diagnosis, false);
  assert.equal("health_status" in inspected.diagnosis, false);
  assert.equal("stalled" in inspected.diagnosis, false);
  assert.deepEqual(Object.keys(inspected.health).sort(), ["reason", "status"]);
  const text = JSON.stringify(inspected);
  assert.equal(text.split('{"progress":').length - 1 + text.split('"progress":').length - 1, 1);

  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  assert.equal(health.alerts.recent_failure, true);
  assert.equal("failed_recent" in health.alerts, false);
});

test("inspect schema version 1 is frozen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-inspect-frozen-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        case: "baseline",
        seed: "42",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
      },
    ], null, 2),
  });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.schema_version, "1");
  assert.deepEqual(Object.keys(inspected).sort(), ["alerts", "diagnosis", "health", "progress", "schema_version", "snapshot", "status", "summary"]);
  assert.equal(inspected.summary.experiment_case, "baseline");
  assert.equal(inspected.summary.seed, "42");
  assert.equal("runtime" in inspected.diagnosis, false);
  assert.equal(JSON.stringify(inspected).split('"stale_seconds"').length - 1, 1);
  assert.ok(Array.isArray(inspected.alerts.alert_details));
  const stalled = inspected.alerts.stalled
    ? [{ type: "stalled", message: "experiment has no progress update" }]
    : [];
  assert.deepEqual(inspected.alerts.alert_details, stalled);
});

test("health field is shared by health overview and inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-health-field-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        case: "baseline",
        seed: "7",
        worker_id: "worker-a",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
        gpu: { id: "0" },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal(inspected.schema_version, "1");
  for (const payload of [health, overview]) {
    assert.equal("health" in payload, true);
    assert.equal("overall" in payload, false);
    assert.deepEqual(Object.keys(payload.health).sort(), payload === health ? ["alert_level", "reason", "status"] : ["reason", "status"]);
  }
  assert.deepEqual(health.health, { ...overview.health, alert_level: "ok" });
  assert.deepEqual(health.health, { ...inspected.health, alert_level: "ok" });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const running = active.runs[0];
  for (const key of ["id", "experiment_case", "seed", "worker", "gpu", "stage", "progress"]) {
    assert.equal(key in running, true, key);
  }
  assert.equal(running.experiment_case, "baseline");
  assert.equal(running.seed, "7");
});

test("overview active health and inspect keep separate responsibilities", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-responsibilities-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        updated: new Date().toISOString(),
        progress: { epoch: 4, loss: 0.31 },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal("active_runs" in overview.summary, false);
  assert.equal("running" in health, false);
  assert.ok(Array.isArray(active.runs));
  assert.deepEqual(Object.keys(overview.active).sort(), ["active_count", "runs", "workflows"]);
  assert.deepEqual(overview.active, { active_count: active.active_count, workflows: active.workflows, runs: active.runs });
  for (const key of ["missing_progress", "stalled", "recent_failure", "alert_details"]) {
    assert.equal(key in health.alerts, true, key);
    assert.equal(key in inspected.alerts, true, key);
  }
  assert.equal("failed_recent" in health.alerts, false);
  assert.equal("failed_recent" in overview.alerts, true);
});
