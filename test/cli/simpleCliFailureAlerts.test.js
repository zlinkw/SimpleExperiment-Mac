const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("resolved recent failures stay in summary history but leave overview alerts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-resolved-history-"));
  const stamp = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const failed = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "failed", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  const success = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "success", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify([
    failed("A-old", "A", 20), success("A-new", "A", 5),
    failed("B-old", "B", 30), success("B-new", "B", 6),
  ]) });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(overview.health, { status: "healthy", reason: "" });
  assert.deepEqual(overview.alerts.failed_recent, []);
  assert.deepEqual(overview.summary.recent_failures.map((row) => row.id), ["A-old", "B-old"]);
  const full = JSON.parse((await runCli(["experiment", "overview", "--json", "--full"], { cwd: dir })).stdout);
  assert.deepEqual(full.alerts.failed_recent, []);
  assert.deepEqual(full.summary.recent_failures.map((row) => row.id), ["A-old", "B-old"]);
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  assert.deepEqual(summary.recent_failures.map((row) => row.id), ["A-old", "B-old"]);
});

test("overview alerts prioritize unresolved failures before running retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-failure-priority-"));
  const stamp = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const failed = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "failed", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  const running = (id, experiment_case) => ({ global_job_id: id, type: "worker_run", status: "running", plan: "p.yaml", experiment_case, seed: "42", created: stamp(5), updated: stamp(1) });
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify([
    failed("A-old", "A", 15), failed("B-old", "B", 16),
    failed("X-old", "X", 60), failed("Y-old", "Y", 61),
    running("A-new", "A"), running("B-new", "B"),
  ]) });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  assert.equal(overview.health.status, "error");
  assert.deepEqual(overview.alerts.failed_recent.map((row) => row.id), ["X-old", "Y-old", "A-old"]);
  const full = JSON.parse((await runCli(["experiment", "overview", "--json", "--full"], { cwd: dir })).stdout);
  assert.deepEqual(full.alerts.failed_recent.map((row) => row.id), ["X-old", "Y-old", "A-old", "B-old"]);
});

test("health alert counts failure attempts by experiment identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-failure-count-"));
  const stamp = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const failed = (id, experiment_case, minutes) => ({ global_job_id: id, type: "worker_run", status: "failed", plan: "p.yaml", experiment_case, seed: "42", created: stamp(minutes + 1), updated: stamp(minutes) });
  const rows = [
    ...[70, 69, 68, 67].map((minutes, index) => failed(`X-${index}`, "X", minutes)),
    ...["A", "B", "controls"].flatMap((experiment_case) => [
      failed(`${experiment_case}-1`, experiment_case, 30),
      failed(`${experiment_case}-2`, experiment_case, 20),
      { global_job_id: `${experiment_case}-new`, type: "worker_run", status: "running", plan: "p.yaml", experiment_case, seed: "42", created: stamp(5), updated: stamp(1) },
    ]),
  ];
  writeProject(dir, { "simple_cluster/experiment_index.json": JSON.stringify(rows) });
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.equal(health.health.status, "error");
  const message = health.alerts.alert_details.find((item) => item.type === "recent_failure").message;
  assert.match(message, /1 unresolved experiment identity/);
  assert.match(message, /4 recent failed attempts/);
  assert.match(message, /3 experiment identities/);
  assert.match(message, /running retries/);
});

test("progress includes updated_at for active status and inspect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-progress-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      {
        global_job_id: "run-100",
        type: "run",
        status: "running",
        stage: "run",
        updated: "2026-03-01T00:00:00Z",
        progress: { epoch: 2, max_epoch: 10, percent: 20, loss: 0.4 },
      },
    ], null, 2),
  });
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  const status = JSON.parse((await runCli(["experiment", "status", "run-100", "--json"], { cwd: dir })).stdout);
  const inspected = JSON.parse((await runCli(["experiment", "inspect", "run-100", "--json"], { cwd: dir })).stdout);
  for (const progress of [active.runs[0].progress, status.progress, inspected.progress]) {
    assert.equal(progress.epoch, 2);
    assert.equal(progress.percent, 20);
    assert.equal(progress.updated_at, "2026-03-01T00:00:00.000Z");
  }
  assert.equal(typeof inspected.diagnosis.stale_seconds, "number");
  assert.ok(inspected.diagnosis.stale_seconds > 0);
  assert.equal(inspected.status.updated_at, "2026-03-01T00:00:00.000Z");
});

test("failure rows share one schema across overview health and summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-failure-schema-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-bad", type: "run", status: "failed", plan: "plan.yaml", worker_id: "worker-a", stage: "run", updated: new Date().toISOString() },
    ], null, 2),
  });
  const overview = JSON.parse((await runCli(["experiment", "overview", "--json"], { cwd: dir })).stdout);
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  const summary = JSON.parse((await runCli(["experiment", "summary", "--json"], { cwd: dir })).stdout);
  const rows = [overview.alerts.failed_recent[0], summary.recent_failures[0]];
  assert.deepEqual(rows[0], rows[1]);
  for (const key of FAILURE_KEYS) assert.equal(key in rows[0], true, key);
  assert.equal(health.health.status, "error");
});

test("old failures do not mark current health as error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-cli-old-failure-"));
  writeProject(dir, {
    "simple_cluster/experiment_index.json": JSON.stringify([
      { global_job_id: "run-old", type: "run", status: "failed", updated: "2020-01-01T00:00:00Z" },
      { global_job_id: "run-1789994720003", type: "run", status: "running", stage: "train", updated: new Date().toISOString() },
    ], null, 2),
  });
  const health = JSON.parse((await runCli(["experiment", "health", "--json"], { cwd: dir })).stdout);
  assert.equal(health.health.status, "healthy");
  assert.equal(health.alerts.recent_failure, false);
  const active = JSON.parse((await runCli(["experiment", "active", "--json"], { cwd: dir })).stdout);
  assert.equal(active.runs[0].id, "run-1789994720003");
  assert.equal(active.runs[0].stage, "train");
  assert.equal("progress" in active.runs[0], true);
});
