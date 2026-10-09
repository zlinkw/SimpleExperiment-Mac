const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const queue = require("../../dist/features/DistributedPlanQueue.js");
const source = fs.readFileSync(require.resolve("../../src/extension/legacy.ts"), "utf8");
const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
function method(name) {
  let found;
  function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === name) found = node.getText(ast); else ts.forEachChild(node, visit); }
  visit(ast);
  assert.ok(found, name);
  return ts.transpileModule(`this.methods = { ${found} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function fixture() {
  const root = "C:/research/project";
  const workers = ["worker-old", "worker-free"].map(id => ({ id, role: "worker", label: id }));
  const snapshots = Object.fromEntries(workers.map(row => [row.id, {
    workerId: row.id, generatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
    capabilities: { durablePlanQueue: true, schemaVersion: 1 }, tasks: [],
  }]));
  const sandbox = { DistributedPlanQueue: queue, workspaceRoot: () => root, UiCommandCancelled: class extends Error {},
    mapLimited: async (rows, limit, run) => Promise.all(rows.map(run)) };
  vm.createContext(sandbox);
  vm.runInContext(method("safeWorkerCodeSyncTargets"), sandbox);
  const old = queue.enqueuePlan(queue.emptyDistributedQueue(), {
    codeFingerprint: "old-code", revision: "r", planFile: "plans/old.yaml",
    jobs: [{ index: 0, case: "case", seed: 42, outputDir: "work_dirs/old/attempts/run-old" }],
  }, "run-old");
  Object.assign(old.plans[0].jobs[0], { status: "running", workerId: "worker-old", gpuId: "0", commandId: "old-command" });
  const reads = [];
  const host = { ...sandbox.methods, client: {}, projectTopologyAssessment: () => ({ mode: "worker_pool" }),
    loadDistributedQueue: async () => old,
    readWorkerTaskSnapshot: async (id, options) => { reads.push({ id, options }); return snapshots[id]; },
  };
  return { root, workers, snapshots, host, reads, old };
}

test("new code skips the old task's whole Worker root but uses another Worker without stopping the task", async () => {
  const f = fixture(), before = JSON.stringify(f.old);
  const selected = await f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "new-code", "run");
  assert.deepEqual(Array.from(selected, row => row.id), ["worker-free"]);
  assert.equal(JSON.stringify(f.old), before);
  assert.ok(f.reads.every(row => row.options.fresh === true));
  assert.equal((await f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "old-code", "run")).length, 2);
});

test("live remote task absent from the local queue still protects its Worker root", async () => {
  const f = fixture();
  f.host.loadDistributedQueue = async () => queue.emptyDistributedQueue();
  f.snapshots["worker-old"].tasks = [{ status: "running", codeFingerprint: "old-code" }];
  assert.deepEqual(Array.from(await f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "new-code", "run"), row => row.id), ["worker-free"]);
});

test("missing/stale snapshots and uncertain remote tasks never authorize overwrite", async () => {
  for (const change of [{ error: "offline" }, { workerId: "another-worker" }, { generatedAt: "2000-01-01T00:00:00Z" }, { tasks: [{ status: "unknown" }] }]) {
    const f = fixture();
    Object.assign(f.snapshots["worker-free"], change);
    await assert.rejects(f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "new-code", "run"), /未覆盖运行中代码/);
  }
});

test("one failed Worker probe does not discard another Worker's safe write target", async () => {
  const f = fixture();
  f.host.readWorkerTaskSnapshot = async id => { if (id === "worker-old") throw new Error("disconnected"); return f.snapshots[id]; };
  assert.deepEqual(Array.from(await f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "new-code", "run"), row => row.id), ["worker-free"]);
});

test("manual full code sync rejects partial writes; plan-check chooses one safe scheduler", async () => {
  const f = fixture();
  await assert.rejects(f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "new-code", "workers"), /旧代码版本/);
  assert.deepEqual(Array.from(await f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "new-code", "plan-check"), row => row.id), ["worker-free"]);
});

test("connection changes abandon the code write preview", async () => {
  const f = fixture();
  f.host.readWorkerTaskSnapshot = async id => { f.host.client = {}; return f.snapshots[id]; };
  await assert.rejects(f.host.safeWorkerCodeSyncTargets(f.workers, f.root, "new-code", "run"), /连接已切换/);
});

test("a live old Plan cannot block submission on an independent Worker", async () => {
  const f = fixture(), sandbox = { DistributedPlanQueue: queue, workspaceRoot: () => f.root };
  vm.createContext(sandbox);
  vm.runInContext(method("distributedCodeVersionHold"), sandbox);
  Object.assign(f.host, sandbox.methods, { enabledWorkerConfigs: () => f.workers,
    localDistributedCodeFingerprint: async () => "new-code", lastCodeSyncState: { workerVersions: { "worker-old": { fingerprint: "old-code" } } } });
  assert.equal(await f.host.distributedCodeVersionHold({}), undefined);
  f.host.enabledWorkerConfigs = () => [f.workers[0]];
  assert.equal((await f.host.distributedCodeVersionHold({})).blocker.id, "run-old");
});

test("old pending job uses the original Worker's durable proof after the local code changes", async () => {
  const f = fixture(), sent = [], oldFingerprint = "a".repeat(64), proofId = "b".repeat(64);
  const proofFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "durableCodeProofRequestFields").getText(ast);
  const sandbox = { DistributedPlanQueue: queue, DistributedSchedulingPolicy: require("../../dist/features/DistributedSchedulingPolicy.js"), workspaceRoot: () => f.root };
  vm.createContext(sandbox);
  vm.runInContext(proofFunction + "\n" + method("sendDistributedJob"), sandbox);
  Object.assign(f.host, sandbox.methods, { distributedQueueGeneration: 1, workerActionTargets: () => f.workers, enabledWorkerConfigs: () => f.workers,
    schedulerSettings: () => ({}), withRemoteActionResource: async (_worker, _action, _request, run) => run(),
    lastWorkerProbes: { "worker-old": { capabilities: { actionEndpoints: { "register-code-sync-proof": true } } } },
    lastCodeSyncState: { fingerprint: "new-local-code", workerVersions: { "worker-old": { fingerprint: oldFingerprint, manifestDigest: oldFingerprint, codeSyncProofId: proofId } } },
    buildDistributedJobCodeManifest: async () => { throw new Error("must not substitute current local code for original proof"); },
    client: { postWorkerAction: async (_worker, _action, request) => { sent.push(request); return { status: "queued" }; } },
  });
  const plan = { ...f.old.plans[0], codeFingerprint: oldFingerprint };
  await f.host.sendDistributedJob(plan, plan.jobs[0], "worker-old", "1", "pending-command");
  assert.equal(sent[0].codeSyncProofId, proofId);
  assert.equal(sent[0].manifestDigest, oldFingerprint);
  assert.equal(sent[0].codeManifest, undefined);
  f.host.lastCodeSyncState.workerVersions["worker-old"].manifestDigest = "c".repeat(64);
  await assert.rejects(f.host.sendDistributedJob(plan, plan.jobs[0], "worker-old", "1", "pending-command"), /缺少当前代码指纹的持久 proof/);
  assert.equal(sent.length, 1);
});

test("a pre-migration cache without a proof uses a verified matching manifest and preserves the pending command", async () => {
  const f = fixture(), sent = [], manifest = { "models/train.py": "a".repeat(64) };
  const fingerprintFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "fingerprintFromManifest").getText(ast);
  const proofFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "durableCodeProofRequestFields").getText(ast);
  const sandbox = { crypto: require("node:crypto"), DistributedPlanQueue: queue, DistributedSchedulingPolicy: require("../../dist/features/DistributedSchedulingPolicy.js"), workspaceRoot: () => f.root };
  vm.createContext(sandbox);
  vm.runInContext(fingerprintFunction + "\n" + proofFunction + "\n" + method("sendDistributedJob"), sandbox);
  const fingerprint = sandbox.fingerprintFromManifest(manifest);
  Object.assign(f.host, sandbox.methods, { distributedQueueGeneration: 1, workerActionTargets: () => f.workers, enabledWorkerConfigs: () => f.workers,
    schedulerSettings: () => ({}), withRemoteActionResource: async (_worker, _action, _request, run) => run(),
    lastWorkerProbes: { "worker-free": { capabilities: { actionEndpoints: { "register-code-sync-proof": true } } } },
    lastCodeSyncState: { fingerprint, workerVersions: { "worker-free": { fingerprint } } },
    buildDistributedJobCodeManifest: async () => manifest,
    client: { postWorkerAction: async (_worker, _action, request) => { sent.push(request); return { status: "queued" }; } },
  });
  const plan = { ...f.old.plans[0], codeFingerprint: fingerprint };
  await f.host.sendDistributedJob(plan, plan.jobs[0], "worker-free", "1", "already-persisted-command");
  assert.equal(sent[0].opId, "already-persisted-command");
  assert.equal(sent[0].codeManifest, manifest);
  assert.equal(sent[0].codeSyncProofId, undefined);
  f.host.buildDistributedJobCodeManifest = async () => ({ "models/train.py": "c".repeat(64) });
  await assert.rejects(f.host.sendDistributedJob(plan, plan.jobs[0], "worker-free", "1", "already-persisted-command"), /本机代码已偏离/);
  assert.equal(sent.length, 1);
});

test("allocation is held only during a code write; running reconciliation continues and manifest identity stays mandatory", () => {
  const tick = source.slice(source.indexOf("async tickDistributedQueueCore("), source.indexOf("async patchDistributedJobArtifactState("));
  assert.ok(tick.indexOf("mergeDurableWorkerSnapshots") < tick.indexOf("if (this.codeSyncInFlight)"));
  assert.ok(tick.indexOf("if (this.codeSyncInFlight)") < tick.indexOf("allocateServerPrequeue"));
  assert.doesNotMatch(tick, /dispatchFingerprint/);
  const sync = source.slice(source.indexOf("async syncCodeTargets("), source.indexOf("codeSyncWarmProofKey(" , source.indexOf("async safeWorkerCodeSyncTargets(")));
  assert.match(sync, /dispatchInFlight[\s\S]*boundedPromise/);
  assert.match(sync, /safeWorkerCodeSyncTargets/);
  assert.match(sync, /finally \{ this\.codeSyncInFlight--/);
  const send = source.slice(source.indexOf("async sendDistributedJob("), source.indexOf("async tickDistributedQueueCore("));
  assert.match(send, /fingerprintFromManifest\(codeManifest\) !== plan\.codeFingerprint/);
});
