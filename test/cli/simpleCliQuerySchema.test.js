const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("runtime progress and training messages stay consistent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-runtime-consistency-"));
  writeProject(dir, {
    "experiments/runs/run-1789994720003/stdout.log": [
      "base_config: configs/base.yaml",
      "python -m train --config plan.yaml",
      "cut_lr: 0.1",
      "gate_l2: 0.01",
      "2026-03-01T00:00:00Z INFO epoch 4/10 batch 12 loss 0.31",
    ].join("\n"),
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-1789994720003",
        type: "run",
        status: "running",
        stage: "run",
        updated: new Date().toISOString(),
        stdout: "experiments/runs/run-1789994720003/stdout.log",
        progress: { epoch: 4, max_epoch: 10, percent: 40, loss: 0.31 },
      },
    ], null, 2),
  });
  const args = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  const monitor = JSON.parse((await runCli(["experiment", "monitor", "run-1789994720003", "--json"], args)).stdout);
  assert.notEqual(active.runs[0].progress, null);
  assert.deepEqual(Object.keys(active.runs[0].progress).sort(), ["epoch", "loss", "max_epoch", "percent", "updated_at"]);
  assert.deepEqual(inspected.progress, active.runs[0].progress);
  assert.equal(inspected.diagnosis.latest_message, monitor.latest_message);
  assert.match(inspected.diagnosis.latest_message, /loss 0\.31/);
  assert.doesNotMatch(inspected.diagnosis.latest_message, /yaml|config|python\s+-m|gate_l2/i);
});

test("agent json apis share schema version 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-agent-schema-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "run", updated, progress: { epoch: 4, loss: 0.31 } },
    ], null, 2),
  });
  const args = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], args)).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], args)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  for (const payload of [active, health, overview, inspected]) assert.equal(payload.schema_version, "1");
  assert.match(active.runs[0].updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(health.snapshot).sort(), ["runtime_source", "runtime_version", "snapshot_id", "snapshot_time"]);
  assert.match(String(health.snapshot.snapshot_id), /^\d+$/);
  assert.match(overview.snapshot.snapshot_time, /^\d{4}-\d{2}-\d{2}T/);
  for (const payload of [active, health, overview, inspected]) {
    for (const key of ["snapshot_id", "snapshot_time", "runtime_version"]) assert.equal(key in payload.snapshot, true, key);
  }
  assert.deepEqual(Object.keys(inspected).sort(), ["alerts", "diagnosis", "health", "progress", "schema_version", "snapshot", "status", "summary"]);
  assert.equal("failure_context" in inspected.diagnosis, false);
});

test("agent json schema version 1 stays frozen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-schema-frozen-"));
  const failedDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-schema-failed-"));
  const updated = new Date().toISOString();
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "run", case: "case-a", seed: "7", updated, progress: { epoch: 4, loss: 0.31 } },
    ], null, 2),
  });
  writeProject(failedDir, {
    "experiments/runs/run-bad/stdout.log": "2026-03-01T00:00:00Z ERROR CUDA out of memory\n",
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-bad", type: "run", status: "failed", stage: "run", worker_id: "worker-a", updated, stdout: "experiments/runs/run-bad/stdout.log" },
    ], null, 2),
  });
  const running = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], running)).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], running)).stdout);
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], running)).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], running)).stdout);
  for (const payload of [active, health, overview, inspected]) assert.equal(payload.schema_version, "1");
  assert.deepEqual(Object.keys(active).sort(), ["active_count", "runs", "schema_version", "snapshot", "workflows"]);
  assert.deepEqual(Object.keys(health).sort(), ["alerts", "health", "schema_version", "snapshot"]);
  assert.deepEqual(Object.keys(overview).sort(), ["active", "alerts", "health", "schema_version", "snapshot", "summary"]);
  assert.deepEqual(Object.keys(inspected).sort(), ["alerts", "diagnosis", "health", "progress", "schema_version", "snapshot", "status", "summary"]);
  for (const payload of [active, health, overview, inspected]) {
    assert.deepEqual(Object.keys(payload.snapshot).sort(), ["runtime_source", "runtime_version", "snapshot_id", "snapshot_time"]);
  }
  assert.deepEqual(Object.keys(health.health).sort(), ["alert_level", "reason", "status"]);
  assert.equal(health.health.alert_level, "ok");
  assert.deepEqual(Object.keys(overview.health).sort(), ["reason", "status"]);
  assert.equal("alert_level" in inspected.health, false);
  assert.equal("failure_context" in inspected.diagnosis, false);
  assert.deepEqual(Object.keys(active.runs[0]).sort(), ["experiment_case", "gpu", "id", "progress", "seed", "stage", "updated_at", "worker"]);
  const failed = JSON.parse((await runCli(["experiment", "inspect", "run-bad", "--json"], { cwd: failedDir })).stdout);
  assert.equal(failed.schema_version, "1");
  assert.deepEqual(Object.keys(failed.diagnosis.failure_context).sort(), ["last_error", "stage", "worker"]);
  assert.match(failed.diagnosis.failure_context.last_error, /out of memory/i);
  assert.ok(failed.diagnosis.failure_context.last_error.length <= 300);
  assert.equal(failed.diagnosis.failure_context.stage, "run");
  assert.deepEqual(failed.diagnosis.failure_context.worker, { id: "worker-a" });
});

test("experiment references resolve the same way for every query", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-reference-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "exp-1", run_id: "run-9001", runtimeRunId: "run-stale-alias", id: "raw-1", case: "case-a", tmux: "simple:run-9001", type: "run", status: "running", stage: "run", updated: new Date().toISOString() },
      { global_job_id: "exp-2", type: "run", status: "success", stage: "run", updated: "2026-01-01T00:00:00Z" },
    ], null, 2),
  });
  const args = { cwd: dir };
  for (const ref of ["exp-1", "run-9001", "run-stale-alias", "case-a", "raw-1", "simple:run-9001"]) {
    const result = await runCli(["experiment", "inspect", ref, "--json"], args);
    assert.equal(result.code, 0, ref);
    assert.equal(JSON.parse(result.stdout).summary.id, "exp-1", ref);
  }
  for (const command of ["status", "monitor", "diagnose"]) {
    const result = await runCli(["experiment", command, "run-9001", "--json"], args);
    assert.equal(result.code, 0, command);
    assert.equal(JSON.parse(result.stdout).id, "exp-1", command);
  }
  const missing = await runCli(["experiment", "inspect", "does-not-exist", "--json"], args);
  assert.equal(missing.code, 3);
  const body = JSON.parse(missing.stdout);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "BUSINESS");
  assert.equal(body.error.detail.requested, "does-not-exist");
  assert.deepEqual(body.error.detail.candidates, ["exp-1", "exp-2"]);
  assert.ok(body.error.detail.candidates.length <= 5);
});

test("active run ids resolve through inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-active-inspect-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "run", updated: new Date().toISOString(), progress: { epoch: 4, loss: 0.31 } },
    ], null, 2),
  });
  const args = { cwd: dir };
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], args)).stdout);
  assert.ok(active.runs.length > 0);
  for (const run of active.runs) {
    const inspected = await runCli(["experiment", "inspect", run.id, "--json"], args);
    assert.equal(inspected.code, 0, run.id);
    assert.equal(JSON.parse(inspected.stdout).summary.id, run.id);
  }
  const missing = await runCli(["experiment", "inspect", "run-000", "--json"], args);
  assert.equal(missing.code, 3);
  const detail = JSON.parse(missing.stdout).error.detail;
  assert.equal(detail.requested, "run-000");
  assert.deepEqual(detail.searched_sources, ["current_rows", "runtime_history", "experiment_index", "runtime_observation"]);
  assert.ok(detail.candidates.length <= 5);
});
