const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const queue = readSource("src/features/DistributedPlanQueue.ts");

test("fresh durable snapshots reconstruct a cold empty local queue across configured Workers", () => {
  const resumeStart = extension.indexOf("async resumePersistedDistributedQueue() {");
  const resumeEnd = extension.indexOf("async deferDistributedPlan(", resumeStart);
  const resume = extension.slice(resumeStart, resumeEnd);
  assert.match(resume, /if \(!queue\.plans\.length && !hasLegacyDeferred && this\.workerActionTargets\(\)\.length\)/);
  assert.match(resume, /distributed queue cold recovery/);
  const tickStart = extension.indexOf("async tickDistributedQueueCore(");
  const tickEnd = extension.indexOf("async syncDistributedJobArtifacts(", tickStart);
  const tick = extension.slice(tickStart, tickEnd);
  assert.match(tick, /const candidateWorkerIds = this\.workerActionTargets\(\)\.map/);
  assert.match(tick, /mergeDurableWorkerSnapshots\(queue, taskSnapshots/);
  assert.doesNotMatch(tick, /lastRealtimeState\?\.workerTasks\?\[workerId\]/);
});

test("new admission carries project identity and expected count, and requires a durable receipt", () => {
  assert.match(extension, /durablePlanQueue: true, schedulingMode: DistributedSchedulingPolicy\.schedulingMode\(\s*job\.manualDispatch\?\.origin === "server_queue" \? "server_prequeue" : job\.localQueueOnly === true \|\| plan\.localDispatchOverride === true \? "local_idle" : plan\.schedulingMode\)/);
  assert.match(extension, /durablePlanQueue: true, requireIdleGpu: !job\.manualDispatch && gpuId !== undefined/);
  assert.match(extension, /requireIdleGpu: !job\.manualDispatch && gpuId !== undefined, dispatchPolicy: job\.manualDispatch \? "manual" : "automatic", projectId: plan\.projectId/);
  assert.match(extension, /if \(job\.lifecycleProtocol === 2\)[\s\S]*?status: "unknown", commandId, message: "请求已发送；由主动查询核实远端任务"/);
  assert.match(extension, /register-code-sync-proof/);
  assert.match(extension, /planJobCount: Number\(plan\.planJobCount/);
  assert.match(extension, /receipt\?\.durableAccepted !== true/);
  assert.match(extension, /receipt\.commandId \|\| ""\) !== job\.commandId/);
  assert.match(extension, /Worker 未返回 durableAccepted 及匹配完整身份的状态回执/);
  assert.match(queue, /export function durableCommandId/);
  assert.match(queue, /export function mergeDurableWorkerSnapshots/);
});

test("proof-capable Worker receives compact dispatch identity; legacy Agent keeps manifest fallback", () => {
  const helper = extension.match(/^function durableCodeProofRequestFields\([\s\S]*?^\}/m);
  assert.ok(helper, "missing durable proof request payload helper");
  const buildFields = new Function(`${helper[0]}\nreturn durableCodeProofRequestFields;`)();
  const manifest = { "src/train.py": { size: 400000, sha256: "a".repeat(64) } };
  const compact = buildFields(true, { codeSyncProofId: "b".repeat(64), manifestDigest: "c".repeat(64), fingerprint: "c".repeat(64) }, "c".repeat(64), manifest, "worker-fixture");
  assert.deepEqual(compact, { codeSyncProofId: "b".repeat(64), manifestDigest: "c".repeat(64) });
  assert.equal(JSON.stringify(compact).includes(JSON.stringify(manifest)), false);
  const legacy = buildFields(false, {}, "c".repeat(64), manifest, "worker-fixture");
  assert.deepEqual(legacy, { codeManifest: manifest });
});

test("cold recovery cannot infer a complete Plan from the returned task subset", () => {
  assert.match(queue, /planJobCount\?: number/);
  assert.match(queue, /remoteAcceptedJobCount = remoteAcceptedIndices\.size/,'remote acceptance count excludes local-only rows');
  assert.match(queue, /recoveryMissingCount = distributedPlanRecoveryMissingCount\(plan, currentAcceptedIndices\)/);
  const api=require('../../dist/features/DistributedPlanQueue.js');
  assert.equal(api.distributedPlanRecoveryMissingCount({planJobCount:2,jobs:[{index:0,attempt:0,status:'pending'}]}),1);
  assert.equal(api.hasUnresolvedPlanRecovery({planJobCount:2,recoveryMissingCount:1,jobs:[{index:0,attempt:0,status:'pending'}]}),true);
  const apiMerge = require('../../dist/features/DistributedPlanQueue.js'), nowM = Date.now(), stampM = new Date(nowM).toISOString();
  const projectId = apiMerge.canonicalProjectId('/private/fixture');
  const taskM = {projectId,workflowId:'partial',planFile:'plans/p.yaml',planRevision:'r',codeFingerprint:'code',planJobCount:6,
    experimentIndex:0,case:'a',seed:1,attempt:1,outputDir:'runs/a',workerId:'w',commandId:'original',runKey:'original',enqueuedAt:stampM,status:'queued'};
  const mergedResult = apiMerge.mergeDurableWorkerSnapshots(apiMerge.emptyDistributedQueue(),[{workerId:'w',generatedAt:stampM,fetchedAt:stampM,
    capabilities:{durablePlanQueue:true,schemaVersion:1},tasks:[taskM]}],projectId,nowM);
  assert.equal(mergedResult.plans[0].remoteAcceptedJobCount,1);
  assert.equal(mergedResult.plans[0].planJobCount,6); assert.equal(mergedResult.plans[0].recoveryMissingCount,5);
});
