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
  assert.ok(first >= 0 && last > first, startMarker);
  const context = {
    workspaceRoot: () => "C:/project",
    Date, Set, Map, Object, Math, JSON, String,
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
    samePlanSelection: (left, right) => String(left || "").replace(/\\/g, "/").toLowerCase() === String(right || "").replace(/\\/g, "/").toLowerCase(),
    errorMessage: (error) => String(error && error.message || error),
    PlanArtifactTransfer_1: transfer,
    PlanOutputRetention: retention,
    PlanRunFreshness: freshness,
  };
  vm.createContext(context);
  vm.runInContext(`${compiled.slice(first, last).replace(signature, renamed)}\nthis.call = ${renamed.match(/function (\w+)/)[1]};`, context);
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
  const job = {
    index: 3, seed: 7, attempt: 1, status: "completed", workerId: "nwpu2", outputDir: "runs/a",
    artifacts: Object.fromEntries(files.map((file) => [file, "abc"])),
    fragmentWorkerIds: ["nwpu2"], mirroredWorkerIds: ["nwpu2"],
  };
  const labels = [];
  const provider = {
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [] }),
    workerCodeSyncTargets: () => [{ id: "nwpu2" }, { id: "nwpu3" }],
    planOutputRetentionMode: () => "keep-history",
    lastWorkerProbes: { nwpu2: { status: "ok" }, nwpu3: { status: "ok" } },
    sftpServerOptions: (target) => ({ id: target.id }),
    distributedOutputHashes: async () => Object.fromEntries(files.map((file) => [file, "abc"])),
    verifiedSftpProjectInventory: async () => ({ files: Object.fromEntries(files.map((file) => [file, { sha256: "abc" }])) }),
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
  await context.call.call(provider, "C:/project", { plans: [{ id: "p", planFile: "plans/corim.yaml", jobs: [job] }] }, "bulk");
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

test("shared result publication names the stage, plan, workers, and batch", async () => {
  const context = loadMethod(
    "async rebuildDistributedResults(",
    "    planOutputRetentionMode(root) {",
    "async rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)",
    "async function rebuildDistributedResults(root, queue, previewOnly, verifyAll = false)",
  );
  const files = Array.from({ length: 5001 }, (_, index) => `simple_cluster/results/row-${String(index).padStart(4, "0")}.json`);
  const queue = {
    plans: [{ planFile: "plans/corim.yaml", revision: "r", jobs: [{
      case: "a", seed: 1, attempt: 1, status: "completed", workerId: "nwpu2", outputDir: "runs/a",
      artifacts: {}, fragmentWorkerIds: ["nwpu2"], mirroredWorkerIds: ["nwpu2"],
    }] }],
    previewSignature: "signature", previewWorkerId: "nwpu2", previewWorkerIds: ["nwpu2"], previewPaths: files,
  };
  const labels = [];
  const copied = [];
  const provider = {
    distributedProjectContract: () => ({ fragmentPaths: [], requiredPaths: [], configPath: "cfg", checkpointPath: "chk", resultRowsPath: "rows", fourStatePath: "four" }),
    workerCodeSyncTargets: () => [{ id: "nwpu2" }, { id: "nwpu3" }],
    lastWorkerProbes: { nwpu2: { status: "ok" }, nwpu3: { status: "ok" } },
    sftpServerOptions: (row) => ({ id: row.id }),
    distributedOutputHashes: async () => Object.fromEntries(files.map((file) => [file, "good"])),
    planOutputRetentionMode: () => "keep-history",
    patchDistributedPublication: async () => undefined,
    assertSshTransportIdentities: async () => undefined,
    simpleSftpApiCall: async (_method, params) => {
      labels.push(params.taskLabel);
      copied.push(...params.relativePaths);
      return { ok: true };
    },
    recordActionError: (error) => { throw new Error(error.message); },
  };
  context.crypto = { createHash: () => ({ update: () => ({ digest: () => "signature" }) }) };
  await context.call.call(provider, "C:/project", queue, true, false);
  assert.equal(labels.length, 2);
  assert.match(labels[0], /发布增量预览结果/);
  assert.match(labels[0], /plans\/corim\.yaml/);
  assert.match(labels[0], /nwpu2 → nwpu3/);
  assert.match(labels[0], /5000 个文件/);
  assert.match(labels[0], /批次 1\/2/);
  assert.match(labels[1], /批次 2\/2/);
  assert.match(labels[1], /1 个文件/);
  assert.deepEqual(copied, files);
});

test("every Worker fpsync call in the orchestrator passes a concrete task label", () => {
  const compiled = compiledLegacy();
  const marker = '"sync.serverToServerFpsync"';
  let index = 0;
  let count = 0;
  while ((index = compiled.indexOf(marker, index)) >= 0) {
    const call = compiled.slice(index, index + 900);
    assert.match(call, /taskLabel:/, `fpsync call ${count + 1} is missing taskLabel`);
    count += 1;
    index += marker.length;
  }
  assert.equal(count, 7);
  assert.match(compiled, /手动保留目录版本/);
  assert.match(compiled, /手动保留文件版本/);
  assert.match(compiled, /恢复手动保留目录/);
  assert.match(compiled, /恢复前保存旧 attempt 产物/);
  assert.match(compiled, /项目文件补齐/);
});
