const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");
const sourcePath = path.join(__dirname, "../../src/features/DistributedPlanQueue.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const queue = loaded.exports;

function durablePlan(id = "workflow") {
  return { id, planFile: `experiments/plans/${id}.yaml`, revision: "rev-1", codeFingerprint: "code-a",
    projectId: queue.canonicalProjectId("C:/research/project"), planJobCount: 2, enqueuedAt: "2026-09-29T00:00:00.000Z",
    jobs: [0, 1].map((index) => ({ index, case: "bus", seed: 40 + index,
      outputDir: `work_dirs/${id}/bus/attempts/run-${index}` })) };
}

test('migration destination persists across reload and never falls back to the old Worker when unavailable', () => {
  const input=queue.enqueuePlan(queue.emptyDistributedQueue(),durablePlan(),'workflow');
  Object.assign(input.plans[0].jobs[0],{status:'completed',workerId:'old'});
  input.plans[0].jobs[1].reassignmentWorkerId='destination';
  const reloaded=JSON.parse(JSON.stringify(input));
  const workers=[{workerId:'old',online:true,idleGpuAdmission:true,idleGpuIds:['0','1'],codeFingerprint:'code-a'},
    {workerId:'destination',online:false,idleGpuAdmission:true,idleGpuIds:['0'],codeFingerprint:'code-a'}];
  const held=queue.allocateAvailable(reloaded,workers,{requireIdleGpuAdmission:true});
  assert.equal(held.dispatches.length,0);assert.equal(held.queue.plans[0].jobs[1].reassignmentWorkerId,'destination');
  workers[1].online=true;workers[1].codeFingerprint='other-code';
  assert.equal(queue.allocateAvailable(held.queue,workers,{requireIdleGpuAdmission:true}).dispatches.length,0);
  workers[1].codeFingerprint='code-a';
  const moved=queue.allocateAvailable(held.queue,workers,{requireIdleGpuAdmission:true});
  assert.equal(moved.dispatches[0].workerId,'destination');
  assert.equal(moved.queue.plans[0].jobs[1].reassignmentWorkerId,undefined);
});

test('reconciliation cooldown survives reload and expires for both pinned and server-hosted commands', () => {
  const now=Date.now(), input=queue.enqueuePlan(queue.emptyDistributedQueue(),durablePlan(),'workflow');
  const job=input.plans[0].jobs[0];Object.assign(job,{status:'unknown',workerId:'old',gpuId:'0',commandId:'original-command',
    lastDispatchAttemptAt:new Date(now).toISOString()});
  const snapshot={workerId:'old',capabilities:{durablePlanQueue:true,idleGpuAdmission:true,schemaVersion:1},
    generatedAt:new Date(now).toISOString(),fetchedAt:new Date(now).toISOString(),tasks:[]};
  const reloaded=JSON.parse(JSON.stringify(input));
  assert.equal(queue.retryPinnedDispatch(reloaded,'workflow',0,snapshot,['0'],now+9999),undefined);
  assert.equal(queue.retryPinnedDispatch(reloaded,'workflow',0,snapshot,['0'],now+10000).commandId,'original-command');
  reloaded.plans[0].schedulingMode='server_prequeue';
  assert.equal(queue.hostedRetryCandidates(reloaded.plans[0],now+9999).length,0);
  assert.equal(queue.hostedRetryCandidates(reloaded.plans[0],now+10000).length,1);
});

test("durable admission leaves jobs unassigned until a fresh idle GPU and capable Worker exist", () => {
  const input = queue.enqueuePlan(queue.emptyDistributedQueue(), durablePlan(), "workflow");
  const noIdle = queue.allocateAvailable(input, [
    { workerId: "nwpu5", idleGpuIds: [], online: true, codeFingerprint: "code-a", idleGpuAdmission: true },
    { workerId: "nwpu3", idleGpuIds: ["0"], online: false, codeFingerprint: "code-a", idleGpuAdmission: true },
  ], { requireIdleGpuAdmission: true });
  assert.equal(noIdle.dispatches.length, 0);
  for (const job of noIdle.queue.plans[0].jobs) {
    assert.equal(job.status, "pending");
    assert.equal(job.workerId, undefined);
    assert.equal(job.gpuId, undefined);
    assert.equal(job.commandId, undefined);
  }
  const capable = queue.allocateAvailable(input, [
    { workerId: "nwpu5", idleGpuIds: [], online: true, codeFingerprint: "code-a", idleGpuAdmission: true },
    { workerId: "nwpu3", idleGpuIds: ["0", "2"], online: true, capacity: 1, codeFingerprint: "code-a", idleGpuAdmission: true },
  ], { requireIdleGpuAdmission: true });
  assert.equal(capable.dispatches.length, 1);
  assert.equal(capable.dispatches[0].workerId, "nwpu3");
  assert.equal(capable.dispatches[0].gpuId, "0");
  assert.equal(capable.queue.plans[0].jobs[1].workerId, undefined);
});

test("a Worker without idle GPU admission capability is never selected for durable dispatch", () => {
  const input = queue.enqueuePlan(queue.emptyDistributedQueue(), durablePlan(), "workflow");
  const result = queue.allocateAvailable(input, [
    { workerId: "legacy", idleGpuIds: ["0"], online: true, codeFingerprint: "code-a", idleGpuAdmission: false },
  ], { requireIdleGpuAdmission: true });
  assert.equal(result.dispatches.length, 0);
  assert.equal(result.queue.plans[0].jobs[0].status, "pending");
  assert.equal(result.queue.plans[0].jobs[0].workerId, undefined);
});

test("one incomplete server is excluded while another fresh eligible server can accept an unsent job", () => {
  const input = queue.enqueuePlan(queue.emptyDistributedQueue(), durablePlan(), "workflow");
  const now = Date.now();
  const healthySnapshot = { workerId: "nwpu3", capabilities: { durablePlanQueue: true, idleGpuAdmission: true, schemaVersion: 1 },
    generatedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(), tasks: [] };
  assert.equal(queue.hasFreshDurableSnapshot(healthySnapshot, now), true);
  assert.equal(queue.hasFreshDurableSnapshot({ ...healthySnapshot, workerId: "nwpu5", error: "offline" }, now), false);
  const healthyGpu = queue.freshIdleGpuEvidence({ nwpu3: [{ index: "0", utilizationPercent: 1, memoryUsedMb: 50, processCount: 0 }] },
    ["nwpu3"], 5, 200);
  const failedGpu = queue.freshIdleGpuEvidence({}, ["nwpu5"], 5, 200);
  assert.equal(healthyGpu.complete, true);
  assert.equal(failedGpu.complete, false);
  const result = queue.allocateAvailable(input, [{ workerId: "nwpu3", idleGpuIds: healthyGpu.idleGpuIdsByWorker.get("nwpu3"),
    online: true, codeFingerprint: "code-a", idleGpuAdmission: true }], { requireIdleGpuAdmission: true });
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.queue.plans[0].jobs[1].workerId, undefined);
});

test("locally saved pending jobs are accepted for scheduling without claiming remote durable acceptance", () => {
  const input = queue.enqueuePlan(queue.emptyDistributedQueue(), durablePlan(), "workflow");
  const disposition = queue.distributedSubmissionResult(input.plans[0]);
  assert.equal(disposition.localQueued, true);
  assert.equal(disposition.durableAccepted, false);
  assert.equal(disposition.pendingCount, 2);
  assert.equal(disposition.dispatchError, "");
  const callerOutcome = queue.distributedSubmissionProgress({ enqueued: true, ...disposition });
  assert.equal(callerOutcome.status, "succeeded");
  assert.equal(callerOutcome.waiting, true);
  assert.match(callerOutcome.message, /未绑定/);
  const dispatched = queue.allocateAvailable(input, [
    { workerId: "nwpu3", idleGpuIds: ["0"], online: true, codeFingerprint: "code-a", idleGpuAdmission: true },
  ], { requireIdleGpuAdmission: true });
  const partial = queue.distributedSubmissionResult(dispatched.queue.plans[0]);
  assert.equal(partial.localQueued, true);
  assert.equal(partial.durableAccepted, false);
  assert.equal(partial.pendingCount, 1);
});
