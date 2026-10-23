const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const path = require("node:path");
const crypto = require("node:crypto");
const fsNode = require("node:fs");
const queueApi = require("../../dist/features/DistributedPlanQueue.js");
const schedulingPolicy = require("../../dist/features/DistributedSchedulingPolicy.js");
const source = require("node:fs").readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing compiled method: ${startMarker}`);
  return source.slice(start, end);
}

// 跨平台等价夹具：原子写入器对路径做 path.resolve 规范化（Windows 上 join/resolve 同形，
// POSIX 下 resolve 会前缀 cwd），故内存键统一按 resolve 规范化——同一物理路径=同一键。
// 断言与覆盖范围保持原强度，仅消除 Windows 专属的键形态巧合。
const memoryFilesMap = new Map();
const memKey = (file) => path.resolve(String(file)).toLowerCase();
const memoryFiles = {
  clear: () => memoryFilesMap.clear(),
  delete: (file) => { memoryFilesMap.delete(memKey(file)); },
  get: (file) => memoryFilesMap.get(memKey(file)),
  has: (file) => memoryFilesMap.has(memKey(file)),
  set: (file, value) => { memoryFilesMap.set(memKey(file), value); },
  get size() { return memoryFilesMap.size; },
};
const retryDelays = [];
let renameCount = 0;
const memoryStat = () => ({ dev: 1, ino: 1, nlink: 1, isFile: () => true, isSymbolicLink: () => false });
const memoryFs = {
  async readFile(file) {
    if (!memoryFiles.has(file)) {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
    return memoryFiles.get(file);
  },
  async mkdir() {},
  async writeFile(file, value) { memoryFiles.set(file, String(value)); },
  async lstat(file) {
    if (!memoryFiles.has(file)) {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
    return memoryStat();
  },
  async open(file, flag) {
    // 跨平台等价夹具：写入器以数字 flags（含 O_CREAT）打开暂存文件；POSIX 目录 fsync 分支
    // 以字符串 "r" 打开父目录，内存夹具不得为此虚构文件条目（Windows 路径本就不执行该分支）。
    const creates = typeof flag === "number" ? true : /[wa]/.test(String(flag ?? "w"));
    if (!memoryFiles.has(file)) {
      if (!creates) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      memoryFiles.set(file, "");
    }
    return {
      async stat() { return memoryStat(); },
      async truncate() { memoryFiles.set(file, ""); },
      async write(bytes, offset, length) {
        memoryFiles.set(file, (memoryFiles.get(file) || "") + bytes.subarray(offset, offset + length).toString("utf8"));
        return { bytesWritten: length };
      },
      async writeFile(value) { memoryFiles.set(file, String(value)); },
      async sync() {},
      async close() {},
    };
  },
  async rename(from, to) {
    renameCount += 1;
    if (!memoryFiles.has(from)) throw new Error("temporary file missing");
    memoryFiles.set(to, memoryFiles.get(from));
    memoryFiles.delete(from);
  },
};

// Execute the real common atomic writer against the same virtual filesystem as the Host.
const stateModule = { exports: {} };
vm.runInNewContext(fsNode.readFileSync(require.resolve("../../dist/state/StateStore.js"), "utf8"), {
  module: stateModule, exports: stateModule.exports, Buffer, process,
  setTimeout: (fn, delay) => { retryDelays.push(delay); queueMicrotask(fn); },
  require: (name) => name === "fs/promises" ? memoryFs : require(name),
});

const queueMethods = sourceBlock("async loadDistributedQueue(root) {", "scheduleDistributedPostprocess(root")
  .replace(/}\s+async /g, "}, async ").replace(/,\s*$/, "").trim();
const progressMethod = sourceBlock("serverPlanProgress() {", "async refreshServerPlanProgress(")
  .replace(/}\s+async /g, "}, async ").replace(/,\s*$/, "").trim();
const methodSource = `${queueMethods},\n${progressMethod}`;
const sandbox = {
  DistributedPlanQueue: queueApi,
  DistributedSchedulingPolicy: schedulingPolicy,
  DistributedPlanQueue_1: queueApi,
  DistributedSchedulingPolicy_1: schedulingPolicy,
  fs: memoryFs,
  fsNode,
  path,
  process,
  crypto,
  workspaceRoot: () => "C:/project",
  errorMessage: (error) => String(error?.message || error),
  compactSensitiveText: (value) => String(value || "").slice(0, 240),
  workerTaskSnapshotPayload: (snapshot) => snapshot,
  UiCommandRemotePending: class extends Error {},
  StateStore_1: stateModule.exports,
};
vm.createContext(sandbox);
vm.runInContext(`this.methods = { ${methodSource} };`, sandbox);

const root = "C:/project";
const file = queueApi.distributedQueuePath("C:/storage", root);
const projectId = queueApi.canonicalProjectId(root);

function makeQueue(count, job = {}) {
  return { schemaVersion: 1, plans: Array.from({ length: count }, (_, index) => ({
    id: `plan-${index}`, projectId, planFile: `experiments/plans/plan-${index}.yaml`, revision: "r1",
    codeFingerprint: "fp", enqueuedAt: new Date(1_700_000_000_000 + index).toISOString(), jobs: [{
      index: 0, case: "case", seed: 1, attempt: 1, status: "completed", workerId: "worker-0",
      commandId: `command-${index}`, outputDir: `experiments/runs/plan-${index}/attempts/one`,
      finishedAt: new Date(1_700_000_000_000).toISOString(), ...job,
    }],
  })), deferred: [] };
}

function makeHost() {
  return {
    ...sandbox.methods,
    context: { globalStorageUri: { fsPath: "C:/storage" } },
    distributedQueueWritePromise: Promise.resolve(),
    distributedQueueRoot: "",
    distributedQueueCache: undefined,
    distributedQueueDiskSignature: "",
    distributedQueueStorageDiagnostics: { status: "ready" },
    distributedQueueGeneration: 0,
    postStateCount: 0,
    postState() { this.postStateCount += 1; },
    detachStaleDistributedTick() {},
    workerActionTargets: () => [],
    cachedWorkerTaskSnapshot: () => undefined,
  };
}

test('parallel stop deltas share one live batch fence and merge every fresh disk update without advancing each other away',async()=>{
  memoryFiles.clear();memoryFiles.set(file,JSON.stringify(makeQueue(8)));
  const host=makeHost(),lease={};host.distributedPlanStopEpoch=7;host.planStopClearBatchLease=lease;host.distributedQueueGeneration=4;
  await Promise.all(Array.from({length:8},(_,index)=>host.saveDistributedQueue(root,undefined,{controlMutation:true,
    stopBatchEpoch:7,stopBatchLease:lease,stopBatchCurrent:()=>true,
    mutateLatest:latest=>({...latest,plans:latest.plans.filter(plan=>plan.id!=='plan-'+index)})})));
  assert.equal(JSON.parse(memoryFiles.get(file)).plans.length,0);assert.equal(host.distributedQueueGeneration,4);
  assert.equal(host.distributedPlanStopEpoch,7);
});

test('revoking the stop batch during an atomic rename retry prevents its pending publication',async()=>{
  memoryFiles.clear();const original=JSON.stringify(makeQueue(2));memoryFiles.set(file,original);
  const host=makeHost(),lease={},rename=memoryFs.rename;host.distributedPlanStopEpoch=7;host.planStopClearBatchLease=lease;
  memoryFs.rename=async()=>{host.planStopClearBatchLease=undefined;throw Object.assign(new Error('sharing violation'),{code:'EPERM'});};
  try {await assert.rejects(host.saveDistributedQueue(root,undefined,{controlMutation:true,stopBatchEpoch:7,stopBatchLease:lease,
    stopBatchCurrent:()=>true,mutateLatest:latest=>({...latest,plans:[]})}),/批次已变化/);assert.equal(memoryFiles.get(file),original);}
  finally {memoryFs.rename=rename;}
});

test('missing-only append preserves five original native jobs and admits only the absent sixth job of the same PLAN',async()=>{
  memoryFiles.clear();
  const declarations=Array.from({length:6},(_,index)=>({index,case:index<3?'bus':'pad',seed:42+index%3,
    outputDir:'work/qa/'+index,collectionResultCsv:'work/qa/'+index+'/metrics.csv'}));
  const spec={projectId,planFile:'plans/qa_moe.yaml',revision:'r',codeFingerprint:'code',executionMode:'train_test'};
  const initial=queueApi.enqueuePlan(queueApi.emptyDistributedQueue(),{...spec,planJobCount:6,jobs:declarations.slice(0,5)},'original');
  initial.plans[0].jobs.forEach((job,index)=>Object.assign(job,{status:'completed',workerId:'w',commandId:'completed-'+index}));
  memoryFiles.set(file,queueApi.serializeDistributedQueue(initial));
  const host=makeHost(),current=await host.loadDistributedQueue(root);
  assert.ok(current.plans[0].jobs.every(job=>job.status==='unknown'),'disk terminal labels are not current server truth');
  const missing=queueApi.enqueuePlan(current,{...spec,planJobCount:1,fullPlanJobCount:6,jobs:[declarations[5]]},'missing');
  await host.saveDistributedQueue(root,missing,{appendPlanId:'missing'});
  const disk=JSON.parse(memoryFiles.get(file));
  assert.deepEqual(disk.plans[0].jobs.map(job=>job.commandId),initial.plans[0].jobs.map(job=>job.commandId));
  assert.deepEqual(disk.plans.find(p=>p.id==='missing').jobs.map(job=>job.index),[5]);
  const allocated=queueApi.allocateAvailable(queueApi.restoreFormalJobQueue(disk),[{workerId:'w',online:true,
    codeFingerprint:'code',declaredJobPaths:true,idleGpuAdmission:true,idleGpuIds:['0']}],{requireIdleGpuAdmission:true,localIdleOnly:true});
  assert.equal(allocated.dispatches.length,1);assert.equal(allocated.dispatches[0].planId,'missing');assert.equal(allocated.dispatches[0].jobIndex,5);
});

test('same-PLAN append still rejects overlapping output, metric and ancestor paths even at a different job index',async()=>{
  for(const paths of [{outputDir:'work/shared',collectionResultCsv:'tmp/new.csv'},
    {outputDir:'work/other',collectionResultCsv:'tmp/shared.csv'},
    {outputDir:'work/shared/child',collectionResultCsv:'tmp/new.csv'}]){
    memoryFiles.clear();
    const spec={projectId,planFile:'plans/qa_moe.yaml',revision:'r',codeFingerprint:'code',executionMode:'train_test'};
    const old=queueApi.enqueuePlan(queueApi.emptyDistributedQueue(),{...spec,jobs:[{index:0,case:'bus',seed:42,
      outputDir:'work/shared',collectionResultCsv:'tmp/shared.csv'}]},'original');
    Object.assign(old.plans[0].jobs[0],{workerId:'w',commandId:'old',status:'running'});
    const before=queueApi.serializeDistributedQueue(old);memoryFiles.set(file,before);
    const duplicate=queueApi.enqueuePlan(queueApi.emptyDistributedQueue(),{...spec,jobs:[{index:5,case:'pad',seed:44,...paths}]},'duplicate');
    await assert.rejects(makeHost().saveDistributedQueue(root,duplicate,{appendPlanId:'duplicate'}),/阻止重复提交/);
    assert.equal(memoryFiles.get(file),before);
  }
});

test("confirmed clear markers survive the production atomic writer, a new Host and repeated recovery", async () => {
  memoryFiles.clear();
  const initial = makeQueue(2);
  initial.plans[0].planJobCount = 1;
  initial.plans[0].jobs[0].runKey = initial.plans[0].jobs[0].commandId;
  memoryFiles.set(file, JSON.stringify(initial));
  let host = makeHost();
  const current = await host.loadDistributedQueue(root);
  await host.saveDistributedQueue(root, queueApi.removeConfirmedDistributedPlan(current, current.plans[0].planFile, {
    jobKeys: new Set([`plan-0\0${0}\0${1}`]), deferredIds: new Set(), projectId,
  }), { queueGeneration: 0 });
  const plan = initial.plans[0], job = plan.jobs[0];
  for (let index = 0; index < 3; index++) {
    host = makeHost();
    const persisted = await host.loadDistributedQueue(root);
    assert.equal(persisted.clearedJobs.length, 1);
    const now = Date.now();
    const recovered = queueApi.mergeDurableWorkerSnapshots(persisted, [{ workerId: job.workerId,
      capabilities: { durablePlanQueue: true, schemaVersion: 1 },
      generatedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(),
      tasks: [{ ...job, projectId, workflowId: plan.id, planFile: plan.planFile, planRevision: plan.revision,
        codeFingerprint: plan.codeFingerprint, experimentIndex: job.index, planJobCount: 1, enqueuedAt: plan.enqueuedAt }],
    }], projectId, now);
    await host.saveDistributedQueue(root, recovered, { queueGeneration: 0 });
    assert.deepEqual(JSON.parse(memoryFiles.get(file)).plans.map(row => row.id), ["plan-1"]);
  }
});

test("unchanged artifact and publication confirmations do not rewrite the queue and still observe fresh disk", async () => {
  memoryFiles.clear();
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  await host.patchDistributedJob(root, "plan-0", 0, 1, { artifacts: { "a.csv": "digest" }, mirroredWorkerIds: ["worker-1"] });
  await host.patchDistributedPublication(root, { publishedSignature: "current" });
  const before = renameCount;
  const signature = host.distributedQueueDiskSignature;
  for (let index = 0; index < 20; index++) {
    await host.patchDistributedJob(root, "plan-0", 0, 1, { artifacts: { "a.csv": "digest" }, mirroredWorkerIds: ["worker-1"] });
    await host.patchDistributedPublication(root, { publishedSignature: "current" });
  }
  assert.equal(renameCount, before, "repeated hash confirmations must not create atomic staging writes");
  assert.equal(host.distributedQueueDiskSignature, signature);
  const external = JSON.parse(memoryFiles.get(file));
  external.plans[1].jobs[0].status = "failed";
  memoryFiles.set(file, JSON.stringify(external));
  await host.patchDistributedJob(root, "plan-0", 0, 1, { mirroredWorkerIds: ["worker-1"] });
  assert.equal(renameCount, before);
  assert.equal(host.distributedQueueCache.plans[1].jobs[0].status, "failed");
  assert.equal(host.serverPlanProgress().length, 28);
});

test("20 tick-equivalent writes keep all 28 historical Plans visible and isolate the display snapshot", async () => {
  memoryFiles.clear();
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  let firstWorking;
  let initialDisplay;
  for (let index = 0; index < 20; index++) {
    const working = await host.loadDistributedQueue(root);
    if (index === 0) {
      firstWorking = working;
      initialDisplay = JSON.stringify(host.distributedQueueCache);
      const base = queueApi.distributedQueueBaseSignature(working);
      working.plans[0].jobs[0].finishedAt = "mutated-only-in-working-copy";
      assert.equal(JSON.stringify(host.distributedQueueCache), initialDisplay);
      assert.equal(queueApi.distributedQueueBaseSignature(working), base);
    }
    working.plans[0].jobs[0].error = `tick-${index}`;
    await host.saveDistributedQueue(root, working);
    const state = { distributedPlans: host.serverPlanProgress() };
    assert.equal(state.distributedPlans.length, 28);
    assert.equal(host.distributedQueueStorageDiagnostics.status, "ready");
  }
  assert.equal(host.distributedQueueCache.plans.length, 28);
  assert.notEqual(firstWorking, host.distributedQueueCache);
});

test("concurrent artifact and publication patches read their base inside the serialized write", async () => {
  memoryFiles.clear();
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  await host.loadDistributedQueue(root);
  await Promise.all([
    host.patchDistributedJob(root, "plan-0", 0, 1, { fragmentWorkerIds: ["worker-1"] }),
    host.patchDistributedJob(root, "plan-1", 0, 1, { mirroredWorkerIds: ["worker-2"] }),
    host.patchDistributedPublication(root, { publishedSignature: "latest" }),
  ]);
  const queue = JSON.parse(memoryFiles.get(file));
  assert.deepEqual(queue.plans[0].jobs[0].fragmentWorkerIds, ["worker-1"]);
  assert.deepEqual(queue.plans[1].jobs[0].mirroredWorkerIds, ["worker-2"]);
  assert.equal(queue.publishedSignature, "latest");
  assert.equal(host.serverPlanProgress().length, 28);
});

test("a tick preserves intervening same-Host metadata writes without false external conflicts", async () => {
  memoryFiles.clear();
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  for (let index = 0; index < 20; index++) {
    const working = await host.loadDistributedQueue(root);
    working.plans[0].jobs[0].error = `tick-${index}`;
    await host.patchDistributedJob(root, "plan-1", 0, 1, { fragmentWorkerIds: [`worker-${index}`] });
    await host.saveDistributedQueue(root, working, { queueGeneration: 0 });
    const queue = JSON.parse(memoryFiles.get(file));
    assert.ok(queue.plans[1].jobs[0].fragmentWorkerIds.includes(`worker-${index}`));
    assert.equal(queue.plans[0].jobs[0].error, `tick-${index}`);
    assert.equal(host.serverPlanProgress().length, 28);
    assert.equal(host.distributedQueueStorageDiagnostics.status, "ready");
  }
});

test("an intervening business-state write cannot be rebased as artifact metadata", async () => {
  memoryFiles.clear();
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  const stale = await host.loadDistributedQueue(root);
  const fresh = await host.loadDistributedQueue(root);
  fresh.plans[1].jobs[0].status = "failed";
  await host.saveDistributedQueue(root, fresh);
  await assert.rejects(host.saveDistributedQueue(root, stale), /另一窗口已更新/);
  assert.equal(JSON.parse(memoryFiles.get(file)).plans[1].jobs[0].status, "failed");
});

test('a committed control delta fences an older tick and preserves unrelated latest queue changes',async()=>{
  memoryFiles.clear();memoryFiles.set(file,JSON.stringify(makeQueue(2)));
  const host=makeHost(),other=makeHost(),stale=await host.loadDistributedQueue(root);
  const changed=await other.loadDistributedQueue(root);changed.plans[1].jobs[0].status='failed';
  await other.saveDistributedQueue(root,changed);
  let aborted=0,detached=0;
  host.distributedTickAbort={abort(){aborted++;}};
  host.distributedQueueTickPromise=Promise.resolve();
  host.detachStaleDistributedTick=task=>{assert.equal(task,host.distributedQueueTickPromise);detached++;host.distributedQueueTickPromise=undefined;};
  await host.saveDistributedQueue(root,undefined,{controlMutation:true,mutateLatest:latest=>({...latest,plans:latest.plans.map((p,index)=>index?p:
    {...p,jobs:p.jobs.map(j=>({...j,status:'pending',commandId:undefined,workerId:undefined,nextCommandId:'explicit-new'}))})})});
  assert.equal(host.distributedQueueGeneration,1);assert.equal(aborted,1);assert.equal(detached,1);
  assert.equal(JSON.parse(memoryFiles.get(file)).plans[1].jobs[0].status,'failed');
  await assert.rejects(host.saveDistributedQueue(root,stale,{queueGeneration:0}),/过期调度轮次/);
  assert.equal(JSON.parse(memoryFiles.get(file)).plans[0].jobs[0].nextCommandId,'explicit-new');
});

test("terminal task logs remain bound to their attempt over ten repeated Worker snapshots", async () => {
  memoryFiles.clear();
  const initial = makeQueue(1, { logPath: "tmp/tmux_logs/gpu-0.log" });
  memoryFiles.set(file, JSON.stringify(initial));
  const host = makeHost();
  for (let index = 0; index < 10; index++) {
    const working = await host.loadDistributedQueue(root);
    const plan = working.plans[0];
    const job = plan.jobs[0];
    const binding = queueApi.workerTaskLogBinding(plan, job, "tmp/tmux_logs/gpu-0.log");
    assert.ok(binding);
    Object.assign(job, binding);
    await host.saveDistributedQueue(root, working);
    const stored = host.distributedQueueCache.plans[0].jobs[0];
    assert.equal(stored.logPath, `${stored.outputDir}/stdout.log`);
    assert.equal(JSON.stringify(stored.historyLogIdentity), JSON.stringify({
      commandId: "command-0", outputDir: stored.outputDir, runId: "plan-0",
    }));
    assert.equal(host.distributedQueueStorageDiagnostics.status, "ready");
  }
});

test("real disk edits conflict without overwriting the disk or emptying the last-known-good display", async () => {
  memoryFiles.clear();
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  const staleWork = await host.loadDistributedQueue(root);
  staleWork.plans[0].jobs[0].error = "stale write";
  const externalSource = JSON.stringify(makeQueue(29));
  memoryFiles.set(file, externalSource);

  await assert.rejects(host.saveDistributedQueue(root, staleWork), /另一窗口已更新/);
  assert.equal(memoryFiles.get(file), externalSource);
  assert.equal(host.distributedQueueCache.plans.length, 29);
  assert.equal(host.serverPlanProgress().length, 29);
  assert.equal(host.distributedQueueStorageDiagnostics.status, "conflict");
  assert.equal(host.postStateCount, 1);
});

test("a disk read failure retains the last-known-good display queue and marks it stale", async () => {
  memoryFiles.clear();
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  await host.loadDistributedQueue(root);
  const readFile = memoryFs.readFile;
  memoryFs.readFile = async () => { throw new Error("disk unavailable"); };
  try {
    const loaded = await host.loadDistributedQueue(root);
    assert.equal(loaded.plans.length, 28);
    assert.equal(host.distributedQueueCache.plans.length, 28);
    assert.equal(host.serverPlanProgress().length, 28);
    assert.equal(host.distributedQueueStorageDiagnostics.status, "stale");
  } finally {
    memoryFs.readFile = readFile;
  }
});

test("transient Windows EPERM on queue publication retries without emptying display or losing metadata", async () => {
  memoryFiles.clear(); retryDelays.length = 0;
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  await host.loadDistributedQueue(root);
  const rename = memoryFs.rename;
  let attempts = 0;
  memoryFs.rename = async (...args) => {
    assert.equal(host.serverPlanProgress().length, 28);
    if (++attempts <= 2) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
    return rename(...args);
  };
  try {
    await host.patchDistributedJob(root, "plan-0", 0, 1, { mirroredWorkerIds: ["worker-2"] });
    assert.equal(attempts, 3);
    assert.deepEqual(retryDelays, [20, 40]);
    assert.deepEqual(JSON.parse(memoryFiles.get(file)).plans[0].jobs[0].mirroredWorkerIds, ["worker-2"]);
    assert.equal(host.distributedQueueStorageDiagnostics.status, "ready");
    assert.equal(memoryFiles.has(file + ".writing"), false);
  } finally { memoryFs.rename = rename; }
});

test("external queue update during rename retry is never overwritten", async () => {
  memoryFiles.clear(); retryDelays.length = 0;
  memoryFiles.set(file, JSON.stringify(makeQueue(28)));
  const host = makeHost();
  const working = await host.loadDistributedQueue(root);
  working.plans[0].jobs[0].error = "stale";
  const external = JSON.stringify(makeQueue(29));
  const rename = memoryFs.rename;
  let attempts = 0;
  memoryFs.rename = async () => {
    attempts++;
    memoryFiles.set(file, external);
    throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
  };
  try {
    await assert.rejects(host.saveDistributedQueue(root, working), /另一窗口已更新/);
    assert.equal(attempts, 1);
    assert.equal(memoryFiles.get(file), external);
    assert.equal(host.serverPlanProgress().length, 29);
    assert.equal(host.distributedQueueStorageDiagnostics.status, "conflict");
  } finally { memoryFs.rename = rename; }
});

test("persistent EPERM has bounded retries, keeps one staging slot, and allows a later successful retry", async () => {
  memoryFiles.clear(); retryDelays.length = 0;
  const initial = JSON.stringify(makeQueue(28));
  memoryFiles.set(file, initial);
  const host = makeHost();
  await host.loadDistributedQueue(root);
  const originalSignature = host.distributedQueueDiskSignature;
  host.distributedQueueStorageDiagnostics = { status: "conflict", reason: "older-conflict" };
  const rename = memoryFs.rename;
  let attempts = 0;
  memoryFs.rename = async () => { attempts++; throw Object.assign(new Error("sharing violation"), { code: "EPERM" }); };
  try {
    await assert.rejects(host.patchDistributedJob(root, "plan-0", 0, 1, { fragmentWorkerIds: ["worker-2"] }), /sharing violation/);
    assert.equal(attempts, 6);
    assert.equal(retryDelays.reduce((a, b) => a + b, 0), 550);
    assert.equal(memoryFiles.get(file), initial);
    assert.equal(host.distributedQueueDiskSignature, originalSignature);
    assert.equal(host.serverPlanProgress().length, 28);
    assert.equal(host.distributedQueueStorageDiagnostics.reason, "queue-commit-failed");
    assert.equal(memoryFiles.size, 2);
  } finally { memoryFs.rename = rename; }
  await host.patchDistributedJob(root, "plan-0", 0, 1, { fragmentWorkerIds: ["worker-2"] });
  assert.equal(memoryFiles.size, 1);
  assert.equal(host.distributedQueueStorageDiagnostics.status, "ready");
});

test("generation cancellation during rename retry prevents publication", async () => {
  memoryFiles.clear(); retryDelays.length = 0;
  const initial = JSON.stringify(makeQueue(28));
  memoryFiles.set(file, initial);
  const host = makeHost();
  const working = await host.loadDistributedQueue(root);
  const rename = memoryFs.rename;
  let attempts = 0;
  memoryFs.rename = async () => {
    attempts++;
    host.distributedQueueGeneration++;
    throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
  };
  try {
    await assert.rejects(host.saveDistributedQueue(root, working, { queueGeneration: 0 }), /过期调度轮次/);
    assert.equal(attempts, 1);
    assert.equal(memoryFiles.get(file), initial);
    assert.equal(host.serverPlanProgress().length, 28);
  } finally { memoryFs.rename = rename; }
});
