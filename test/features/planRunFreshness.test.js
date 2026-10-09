const test = require("node:test");
const assert = require("node:assert/strict");
const freshness = require("../../dist/results/PlanRunFreshness.js");

function run(id, enqueuedAt, revision = "same", status = "completed") {
  const jobs = [42, 43, 44].map((seed, index) => ({
    index, case: "ebmc", seed, attempt: 1, status, workerId: "worker-" + (index % 2 + 1),
    outputDir: `simple_cluster/runs/ebmc/attempts/${id}/job-${seed}`,
    commandId: `${id}-command-${seed}`,
    artifacts: { [`job-${seed}.csv`]: (String(index + 1)).repeat(64) },
  }));
  return { id, planFile: "experiments/plans/comparison/ebmc.yaml", revision, enqueuedAt, planJobCount: 3, jobs };
}

test("latest complete same-revision run wins and carries job provenance", () => {
  const a = run("run-a", "2026-09-01T00:00:00.000Z");
  const b = run("run-b", "2026-09-02T00:00:00.000Z");
  const selected = freshness.selectLatestCompletePlanRun({ plans: [a, b] }, a.planFile, "same");
  assert.equal(selected.runId, "run-b");
  assert.equal(selected.expectedJobCount, 3);
  assert.equal(selected.jobs[1].outputDir, b.jobs[1].outputDir);
  assert.equal(selected.jobs[1].commandId, b.jobs[1].commandId);
  assert.equal(selected.jobs[1].artifactHashes["job-43.csv"], "2".repeat(64));
});

test("incomplete or mismatched-revision runs cannot replace the newest complete run", () => {
  const a = run("run-a", "2026-09-01T00:00:00.000Z");
  const b = run("run-b", "2026-09-02T00:00:00.000Z", "same", "running");
  const newerRevision = run("run-c", "2026-09-03T00:00:00.000Z", "next");
  assert.equal(freshness.selectLatestCompletePlanRun({ plans: [a, b] }, a.planFile, "same").runId, "run-a");
  assert.equal(freshness.selectLatestCompletePlanRun({ plans: [a, newerRevision] }, a.planFile, "same").runId, "run-a");
  assert.equal(freshness.selectLatestCompletePlanRun({ plans: [a, newerRevision] }, a.planFile, "missing"), undefined);
});

test("completed rows without command and artifact identity are not authoritative runs", () => {
  const plan = run("run-unverified", "2026-09-02T00:00:00.000Z");
  delete plan.jobs[0].commandId;
  delete plan.jobs[1].artifacts;
  assert.equal(freshness.selectLatestCompletePlanRun({ plans: [plan] }, plan.planFile, "same"), undefined);
});

test("completion identity selects a same-revision rerun before its artifact hashes are discovered", () => {
  const a = run("run-a", "2026-09-01T00:00:00.000Z");
  const b = run("run-b", "2026-09-02T00:00:00.000Z");
  b.jobs.forEach((job, index) => { if (index % 2) delete job.artifacts; else job.artifacts = {}; });
  const queue = { plans: [a, b] };
  const selected = freshness.selectLatestCompletePlanRunIdentity(queue, a.planFile, "same");
  assert.equal(selected.runId, "run-b");
  assert.equal(selected.expectedJobCount, 3);
  assert.deepEqual(selected.jobs.map(job => job.artifactHashes), [{}, {}, {}]);
  assert.deepEqual(selected.jobs.map(job => [job.commandId, job.outputDir]), b.jobs.map(job => [job.commandId, job.outputDir]));
  assert.equal(freshness.selectLatestCompletePlanRun(queue, a.planFile, "same").runId, "run-a", "retention keeps its artifact proof gate");
});

test("completion identity still requires all current-revision job identities and terminal receipts", () => {
  const mutations = [
    plan => { delete plan.jobs[0].commandId; },
    plan => { delete plan.jobs[0].workerId; },
    plan => { plan.jobs[0].attempt = 0; },
    plan => { plan.jobs[0].case = ""; },
    plan => { plan.jobs[0].seed = "unknown"; },
    plan => { plan.jobs[0].outputDir = "../other-run"; },
    plan => { plan.jobs[0].status = "running"; },
    plan => { plan.jobs[0].status = "unknown"; },
    plan => { plan.jobs[0].trustedTerminalStatus = "failed"; },
    plan => { plan.jobs.pop(); },
    plan => { plan.revision = "next"; },
  ];
  for (const mutate of mutations) {
    const a = run("run-a", "2026-09-01T00:00:00.000Z");
    const b = run("run-b", "2026-09-02T00:00:00.000Z");
    b.jobs.forEach(job => { delete job.artifacts; });
    mutate(b);
    assert.equal(freshness.selectLatestCompletePlanRunIdentity({ plans: [b] }, b.planFile, "same"), undefined);
    assert.equal(freshness.selectLatestCompletePlanRunIdentity({ plans: [a, b] }, a.planFile, "same").runId, "run-a");
  }
});

test("completion identity rejects recovery conflicts and duplicate job or command identities", () => {
  const mutations = [
    plan => { plan.recoveryConflict = "contradictory receipts"; },
    plan => { plan.recoveryMissingCount = 1; },
    plan => { plan.jobs[0].recoveryConflict = true; },
    plan => { plan.jobs[1].index = plan.jobs[0].index; },
    plan => { plan.jobs[1].case = plan.jobs[0].case; plan.jobs[1].seed = plan.jobs[0].seed; },
    plan => { plan.jobs[1].workerId = plan.jobs[0].workerId; plan.jobs[1].commandId = plan.jobs[0].commandId; },
    plan => { plan.jobs[2].index = 3; },
    plan => { plan.jobs[0].outputRetiredAt = "2026-09-03T00:00:00.000Z"; },
  ];
  for (const mutate of mutations) {
    const plan = run("run-b", "2026-09-02T00:00:00.000Z");
    plan.jobs.forEach(job => { delete job.artifacts; });
    mutate(plan);
    assert.equal(freshness.selectLatestCompletePlanRunIdentity({ plans: [plan] }, plan.planFile, "same"), undefined);
  }
});

test("summary freshness requires an explicit, non-conflicting run identity", () => {
  const plan = run("run-b", "2026-09-02T00:00:00.000Z");
  const selected = freshness.selectLatestCompletePlanRun({ plans: [plan] }, plan.planFile, "same");
  assert.equal(freshness.summaryProvesRun({ planRevision: "same", completedRunId: "run-b" }, selected), true);
  assert.equal(freshness.summaryProvesRun({ planRevision: "same", completedRunId: null }, selected), false);
  assert.equal(freshness.summaryProvesRun({ planRevision: "same", completedRunId: "run-a" }, selected), false);
  assert.equal(freshness.summaryProvesRun({ planRevision: "same", completedRunId: "run-b", results: [{ run_id: "run-a" }] }, selected), false);
});

test("recovery projection strips shared summary paths before applying the authoritative run", () => {
  const plan = run("run-b", "2026-09-02T00:00:00.000Z");
  const selected = freshness.selectLatestCompletePlanRun({ plans: [plan] }, plan.planFile, "same");
  const summary = freshness.summaryForRunRecovery({
    planFile: plan.planFile, planRevision: "same", projectFinalCsvPath: "experiments/results/formal/ebmc.csv",
    results: [{ run_id: "run-a" }], workerResultTables: [{ rawResultCsvPath: "experiments/results/formal/ebmc.csv" }],
  }, plan.planFile, selected);
  assert.equal(summary.completedRunId, "run-b");
  assert.deepEqual(summary.results, []);
  assert.deepEqual(summary.workerResultTables, []);
  assert.equal(summary.projectFinalCsvPath, undefined);
});

test("metric recovery recognizes exclusive queued retry namespaces without requiring the directory to equal runId", () => {
  for (const token of ['distributed-attempt-1791468346173-xuw2sy', 'auto-retry-1791468346173-xuw2sy']) {
    const plan=run('run-current', '2026-10-09T00:00:00Z');
    Object.assign(plan.jobs[2], { attempt:43, artifacts:{}, outputDir:'custom_results/method/seed44/attempts/' + token });
    const queue={plans:[plan]}, selected=freshness.selectLatestCompletePlanRunIdentity(queue,plan.planFile,'same');
    assert.equal(freshness.hasExclusiveAttemptOutput(queue,selected,selected.jobs[2]),true);
    assert.equal(freshness.hasExclusiveAttemptOutput(queue,selected,selected.jobs[0]),true,'normal run namespaces remain supported');
    assert.equal(freshness.hasExclusiveAttemptOutput({plans:[]},selected,selected.jobs[2]),false);
    assert.equal(freshness.hasExclusiveAttemptOutput(queue,selected,{...selected.jobs[2],commandId:'other'}),false);
    plan.jobs[2].status='unknown';
    assert.equal(freshness.hasExclusiveAttemptOutput(queue,selected,selected.jobs[2]),false);
  }
});

test("unhashed discovery rejects legacy output reuse, collisions and historical attempts", () => {
  for (const mutate of [
    (queue,plan)=>{ plan.jobs[2].outputDir='custom_results/legacy'; },
    (queue,plan)=>{ plan.jobs[2].outputDir='custom_results/attempts/shared'; },
    (queue,plan)=>{ plan.jobs[2].attempt=1; },
    (queue,plan)=>{ plan.jobs[1].outputDir=plan.jobs[2].outputDir; },
    (queue,plan)=>{ queue.plans.push({...plan,id:'other-run'}); },
    (queue,plan)=>{ plan.jobs[2].history=[{...plan.jobs[2],attempt:42,commandId:'previous'}]; },
    (queue,plan)=>{ plan.jobs[2].recoveryConflict=true; },
  ]) {
    const plan=run('run-current', '2026-10-09T00:00:00Z');
    Object.assign(plan.jobs[2],{attempt:43,artifacts:{},outputDir:'custom_results/seed44/attempts/auto-retry-1791468346173-xuw2sy'});
    const queue={plans:[plan]}, selected=freshness.selectLatestCompletePlanRunIdentity(queue,plan.planFile,'same');
    mutate(queue,plan);
    const current=freshness.selectLatestCompletePlanRunIdentity(queue,plan.planFile,'same') || selected;
    assert.equal(freshness.hasExclusiveAttemptOutput(queue,current,current.jobs[2]),false);
  }
});
