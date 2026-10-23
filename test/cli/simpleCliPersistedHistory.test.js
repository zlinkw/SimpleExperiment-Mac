const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("finished worker runs stay inspectable after runtime observation is gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-"));
  writeProject(dir, {
    "experiments/runs/run-1789994720003/artifact_manifest.json": JSON.stringify({ exitCode: 0, generatedAt: "2026-03-01T00:00:00Z" }),
    "experiments/runs/run-1789994720003/env_snapshot.json": JSON.stringify({ finishedAt: "2026-03-01T00:00:00Z" }),
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "wf-1", status: "success", updated: "2026-03-02T00:00:00Z" },
    ], null, 2),
  });
  const args = { cwd: dir };
  const list = JSON.parse((await runCli(["experiment", "list", "--json"], args)).stdout);
  const types = new Set(list.map((row) => row.type));
  assert.equal(types.has("workflow"), true);
  assert.equal(types.has("worker_run"), true);
  for (const row of list) {
    const inspected = await runCli(["experiment", "inspect", row.id, "--json"], args);
    assert.equal(inspected.code, 0, row.id);
    assert.equal(JSON.parse(inspected.stdout).summary.id, row.id);
  }
  const finished = JSON.parse((await runCli(["experiment", "inspect", "run-1789994720003", "--json"], args)).stdout);
  assert.equal(finished.summary.type, "worker_run");
  assert.equal(finished.summary.status, "success");
  assert.equal(finished.snapshot.runtime_source, "history");
  assert.equal(finished.snapshot.runtime_version, "2026-03-01T00:00:00.000Z");
  const workflow = JSON.parse((await runCli(["experiment", "inspect", "wf-1", "--json"], args)).stdout);
  assert.equal(workflow.snapshot.runtime_source, "experiment_index");
});

test("run history overrides the experiment index", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-priority-"));
  writeProject(dir, {
    "experiments/runs/run-1/artifact_manifest.json": JSON.stringify({ exitCode: 0, generatedAt: "2026-03-01T00:00:00Z" }),
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-1", status: "running", plan: "from-index.yaml", updated: new Date().toISOString(), progress: { epoch: 2, loss: 0.4 } },
    ], null, 2),
  });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-1", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.summary.status, "success");
  assert.equal(inspected.snapshot.runtime_source, "history");
  assert.equal(inspected.status.plan, "from-index.yaml");
  assert.equal(inspected.progress.epoch, 2);
});

test("runtime history keeps worker run fields without a live runtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-fields-"));
  writeProject(dir, {
    "experiments/runs/run-9/artifact_manifest.json": JSON.stringify({
      exitCode: 0,
      generatedAt: "2026-03-01T00:00:00Z",
      plan: "plan.yaml",
      worker_id: "worker-a",
      gpu: { id: "0" },
      stage: "run",
      experiment_case: "case-a",
      seed: "7",
      progress: { epoch: 3, loss: 0.2 },
    }),
    "experiments/runs/run-9/env_snapshot.json": "{}",
  });
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-9", "--json"], { cwd: dir })).stdout);
  assert.equal(inspected.summary.id, "run-9");
  assert.equal(inspected.summary.type, "worker_run");
  assert.equal(inspected.summary.status, "success");
  assert.equal(inspected.summary.experiment_case, "case-a");
  assert.equal(inspected.summary.seed, "7");
  assert.equal(inspected.status.plan, "plan.yaml");
  assert.equal(inspected.status.stage, "run");
  assert.deepEqual(inspected.status.worker, { id: "worker-a" });
  assert.deepEqual(inspected.status.gpu, { id: "0" });
  assert.equal(inspected.progress.epoch, 3);
  assert.equal(inspected.snapshot.runtime_source, "history");
  assert.equal(inspected.snapshot.runtime_version, "2026-03-01T00:00:00.000Z");
});

test("failed worker run history can be diagnosed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-history-failed-"));
  writeProject(dir, {
    "experiments/runs/run-9/artifact_manifest.json": JSON.stringify({ exitCode: 1, generatedAt: "2026-03-01T00:00:00Z" }),
    "experiments/runs/run-9/env_snapshot.json": "{}",
    "experiments/runs/run-9/stdout.log": "2026-03-01T00:00:00Z ERROR CUDA out of memory\n",
  });
  const args = { cwd: dir };
  const diagnosis = JSON.parse((await runCli(["experiment", "diagnose", "run-9", "--json"], args)).stdout);
  assert.equal(diagnosis.id, "run-9");
  assert.equal(diagnosis.status, "failed");
  assert.ok(diagnosis.reason.includes("cuda out of memory"));
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-9", "--json"], args)).stdout);
  assert.equal(inspected.schema_version, "1");
  assert.equal(inspected.summary.status, "failed");
});
