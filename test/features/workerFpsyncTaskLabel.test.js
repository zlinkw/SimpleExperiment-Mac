const legacyMethod = require('../_helpers/legacyMethod');
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const transfer = require("../../dist/features/PlanArtifactTransfer.js");
const retention = require("../../dist/features/PlanOutputRetention.js");
const freshness = require("../../dist/results/PlanRunFreshness.js");

function compiledLegacy() {
  return fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
}

function loadMethod(startMarker, endMarker, signature, renamed) {
  const compiled = compiledLegacy();
  const first = compiled.indexOf(startMarker);
  const last = compiled.indexOf(endMarker, first);
  assert.ok(first >= 0, startMarker);
  const context = {
    workspaceRoot: () => "C:/project",
    Date, Set, Map, Object, Math, JSON, String,
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
    samePlanSelection: (left, right) => String(left || "").replace(/\\/g, "/").toLowerCase() === String(right || "").replace(/\\/g, "/").toLowerCase(),
    errorMessage: (error) => String(error && error.message || error),
    PlanArtifactTransfer_1: transfer,
    NativeResultManifest_1: require("../../dist/results/NativeResultManifest"),
    PlanOutputRetention: retention,
    PlanRunFreshness: freshness,
    // r6：专用链 generation 改用共享纯函数后，dist 抽取方法按命名空间引用它。
    JobArtifactSyncIdentity_1: require("../../dist/features/JobArtifactSyncIdentity.js"),
  };
  vm.createContext(context);
  vm.runInContext(`this.call = ({${legacyMethod(compiled, startMarker)}}).${startMarker.match(/(?:async\s+)?(\w+)\(/)[1]};`, context);
  return context;
}

test("job artifact copies name the plan, job, workers, artifact kind, and batch", async () => {
  const context = loadMethod(
    "async syncDistributedJobArtifacts(",
    "async distributedOutputHashes(",
    "async syncDistributedJobArtifacts(root, queue, phase, verifyAll = false, report)",
    "async function syncJobArtifacts(root, queue, phase, verifyAll = false, report)",
  );
  const files = Array.from({ length: 5001 }, (_, index) => `runs/a/weights/part-${String(index).padStart(4, "0")}.bin`);
  files[files.length - 1] = "runs/a/artifact_manifest.json";
  const job = {
    lifecycleProtocol: 2, actualExecutionMode: "train", index: 3, seed: 7, attempt: 1, status: "completed", workerId: "nwpu2", outputDir: "runs/a",
    artifacts: Object.fromEntries(files.map((file) => [file, "a".repeat(64)])),
    fragmentWorkerIds: ["nwpu2"], mirroredWorkerIds: ["nwpu2"],
  };
  const labels = [];
  const provider = {
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [] }),
    workerCodeSyncTargets: () => [{ id: "nwpu2" }, { id: "nwpu3" }],
    planOutputRetentionMode: () => "keep-history",
    lastWorkerProbes: { nwpu2: { status: "ok" }, nwpu3: { status: "ok" } },
    sftpServerOptions: (target) => ({ id: target.id }),
    distributedOutputHashes: async () => Object.fromEntries(files.map((file) => [file, "a".repeat(64)])),
    verifiedSftpProjectInventory: async () => ({ files: Object.fromEntries(files.map((file) => [file, { sha256: "a".repeat(64) }])) }),
    assertSshTransportIdentities: async () => undefined,
    simpleSftpApiCall: async (method, params) => {
      assert.equal(method, "sync.serverToServerFpsync");
      assert.equal(params.confirm, true);
      assert.equal(params.pathConfirmed, true);
      assert.ok(params.relativePaths.length >= 1 && params.relativePaths.length <= 5000);
      labels.push(params.taskLabel);
      return { ok: true };
    },
    patchDistributedJob: async () => undefined,
    recordActionError: (error) => { throw new Error(error.message); },
  };
  await context.call.call(provider, "C:/project", { plans: [{ id: "p", resultPathPolicy: "declared", planFile: "plans/corim.yaml", jobs: [job] }] }, "bulk");
  assert.equal(labels.length, 2);
  for (const label of labels) {
    assert.match(label, /压缩同步最新版 Plan 产物/);
    assert.match(label, /1 个 Plan \/ 1 个 job/);
    assert.match(label, /检查点、日志与结果/);
    assert.match(label, /nwpu2 → nwpu3/);
  }
  assert.match(labels[0], /批次 1\/2/);
  assert.match(labels[1], /批次 2\/2/);
});

test("retired remote result publication performs no transfer or mutation", async () => {
  const context = loadMethod("async rebuildDistributedResults(", "planOutputRetentionMode(", "", "async function rebuildDistributedResults()");
  const queue = { plans: [{ id:'p', resultPathPolicy:'declared', planFile:'plans/corim.yaml', jobs:[{index:0,status:'completed',outputDir:'runs/a'}]}], previewPaths:['results/table.csv'] };
  const before = structuredClone(queue);
  const forbid = () => assert.fail('local memory-only aggregation cannot publish remote results');
  await context.call.call({simpleSftpApiCall:forbid,patchDistributedPublication:forbid},'C:/project',queue,true,false);
  assert.deepEqual(queue,before);
});

test("every Worker fpsync call in the orchestrator passes a concrete task label", () => {
  const compiled = compiledLegacy();
  const ts = require('typescript');
  const ast = ts.createSourceFile('legacy.js',compiled,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const calls=[];
  const visit=node=>{
    if(ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text==='sync.serverToServerFpsync')calls.push(node);
    ts.forEachChild(node,visit);
  };
  visit(ast);assert.equal(calls.length,6,'inspect actual RPC calls; string membership checks are not transfers');
  for(const call of calls) {
    const request=call.arguments[1];assert.ok(ts.isObjectLiteralExpression(request));
    const label=request.properties.find(p=>p.name?.getText(ast)==='taskLabel');
    assert.ok(label, 'real fpsync RPC missing a concrete task label at '+ast.getLineAndCharacterOfPosition(call.pos).line);
    assert.match(label.getText(ast),/workerFpsyncTaskLabel/);
  }
});
