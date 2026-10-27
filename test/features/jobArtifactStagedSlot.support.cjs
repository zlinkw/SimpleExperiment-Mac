// r7：job-artifacts 两链身份回归的共享夹具（供可移植身份用例与 Linux 专属 receiver 用例复用）。
// 入口 A = CompletedJobSyncHost→mergeLatestWorkerVersions→fpsync（completedJob 链）
// 入口 B = syncDistributedJobArtifacts→fpsync（Plan 专用链）
// 夹具根全部取 os.tmpdir 下独占目录（mkdtemp），不依赖任何固定机器路径；跨平台部分不引用
// receiver/python；真实 staged-tar-receive.py 路径由调用方经显式 env 注入传入。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const vm = require("node:vm");
const ts = require("typescript");
const { spawnSync } = require("node:child_process");
require("../_helpers/registerTsRequire");
const { CompletedJobSyncHost } = require("../../src/extension/CompletedJobSyncHost.ts");
const { canonicalProjectId } = require("../../src/features/DistributedPlanQueue.ts");
const { buildScopeStatuses, scopeInventoryPathAllowed } = require("../../src/features/SyncScopeStatus.ts");
const { planLatestWorkerMerge } = require("../../src/features/SyncLatestMerge.ts");
const { runSyncScopeBatch } = require("../../src/features/SyncScopeBatch.ts");
const { jobArtifactRunGeneration } = require("../../src/features/JobArtifactSyncIdentity.ts");
const { safeSyncPath } = require("../../src/features/SyncResolution.ts");
const queueApi = require("../../dist/features/DistributedPlanQueue.js");
const retention = require("../../dist/features/PlanOutputRetention.js");

const OUT = "work_dirs/p/job0";
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const H = { alpha: sha("alpha"), beta: sha("beta"), gamma: sha("gamma"), delta: sha("delta") };
// 专用链 required 集含 jobEvidenceName(protocol2)="artifact_manifest.json"（NativeResultManifest.ts
// L3-5、legacy.ts L13114-13116），清单域必须含它；证据文件内容跨代不变，仅 model.pth 变化开新代。
const FILES = names => Object.fromEntries(Object.entries(names).map(([name, item]) => [`${OUT}/${name}`, item]));
const V1 = FILES({ "model.pth": { sha256: H.alpha, content: "alpha" }, "run.log": { sha256: H.beta, content: "beta" }, "artifact_manifest.json": { sha256: H.beta, content: "beta" } });
const V2 = FILES({ "model.pth": { sha256: H.gamma, content: "gamma" }, "run.log": { sha256: H.beta, content: "beta" }, "artifact_manifest.json": { sha256: H.beta, content: "beta" } });
const V3 = FILES({ "model.pth": { sha256: H.delta, content: "delta" }, "run.log": { sha256: H.beta, content: "beta" }, "artifact_manifest.json": { sha256: H.beta, content: "beta" } });

const legacyTs = fs.readFileSync(path.resolve(__dirname, "../../src/extension/legacy.ts"), "utf8");
const tsAst = ts.createSourceFile("legacy.ts", legacyTs, ts.ScriptTarget.Latest, true);
let mergeMember;
(function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(tsAst) === "mergeLatestWorkerVersions") mergeMember = node; ts.forEachChild(node, visit); })(tsAst);
const legacyJs = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
function jsMethod(start, end) {
  const assert = require("node:assert/strict");
  const first = legacyJs.indexOf(start), last = legacyJs.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return legacyJs.slice(first, last).replace(/}\s+async /g, "}, async ");
}
const fixtureRoot = tag => fs.mkdtempSync(path.join(os.tmpdir(), `simpleex-slot-${tag}-`));

// ---- 入口 A：completedJob 链（真实 CompletedJobSyncHost + vm 抽取的真实 merge 方法） ----
function completedJobEntry(files, options = {}) {
  const assert = require("node:assert/strict");
  const root = fixtureRoot("jobA");
  // r10 夹具扩展（默认形态与旧用例逐字一致：ids=["a","b"]、files 全在来源 a、b 空）：
  // options.ids 多端点、options.foreign={端点:{路径:清单行}} 他端独有路径、options.mirrorFiles
  // 目标已全部一致、options.job 覆盖队列行字段（含 artifacts 已记录必要项）、options.unverified
  // 未校验清单行、options.inventoryError 刷新抛错、options.codeOwned 本机代码归属。
  const ids = options.ids || ["a", "b"];
  const targets = ids.map(id => ({ id, host: id + ".invalid", port: 2222, user: "u", remotePath: "/safe/project" }));
  const jobs = [{ index: 0, case: "c0", seed: 42, attempt: 0, status: "completed", lifecycleProtocol: 2, workerId: ids[0], commandId: "command0", outputDir: OUT, actualExecutionMode: "train", ...(options.job || {}) }];
  const plan = { id: "plan", projectId: canonicalProjectId(root), planFile: "plans/p.yaml", enqueuedAt: "2026-10-14T00:00:00Z", executionMode: "train", jobs };
  const inventory = Object.fromEntries(ids.map(id => [id, {}]));
  for (const [file, item] of Object.entries(files)) inventory[ids[0]][file] = { sha256: item.sha256, size: item.content.length, modifiedAtMs: 1 };
  for (const [id, rows] of Object.entries(options.foreign || {})) { assert.ok(inventory[id], `未知端点 ${id}`); for (const [file, row] of Object.entries(rows)) inventory[id][file] = row; }
  for (const file of options.mirrorFiles || []) for (const id of ids.slice(1)) inventory[id][file] = structuredClone(inventory[ids[0]][file]);
  const transfers = [];
  const config = { get: (_k, fallback) => fallback };
  const h = {
    context: { globalStorageUri: { fsPath: root } }, workerCodeSyncTargets: () => targets, enabledWorkerConfigs: () => targets,
    loadDistributedQueue: async () => structuredClone({ plans: [plan] }),
    localMachineStateGuard: () => ({ prefixes: [], unknown: false }), targetRootGuard: () => null, machineStatePrefixesById: () => [], machineStatePrefixesForTarget: () => [],
    sftpServerOptions: row => row, recordActionError() {}, assertSshTransportIdentities: async () => {},
    // r8 最小依赖补全：本夹具端点无状态映射，prepare 呈现"已可绑定、零 GET"冻结形态。
    // r9：options.freezeGuard(row) 可为指定端点返回冻结保护（三端 source/B/C 用例）。
    prepareCodeSyncRootGuards: async rows => ({ guards: new Map(rows.map(t => [t, (options.freezeGuard && options.freezeGuard(t)) || { prefixes: [], unknown: false }])), assertBindingsCurrent: () => {} }),
    refreshSyncScopeStatus: async (_root, _targets, _mode, scopes) => {
      if (options.inventoryError) throw new Error(options.inventoryError);
      return buildScopeStatuses({ local: {}, unverified: options.unverified || {}, workers: Object.fromEntries(Object.entries(inventory).map(([id, row]) => [id, Object.fromEntries(Object.entries(row).filter(([file]) => scopes.some(scope => file === scope || file.startsWith(scope + "/"))))])) },
        "server-server", scopes, new Set(), { entries: {} }, new Set(), options.holds || {});
    },
    verifiedSftpProjectInventory: async ({ source, scopePaths }) => ({ files: Object.fromEntries(Object.entries(inventory[source.id]).filter(([file]) => scopePaths.some(scope => file === scope || file.startsWith(scope + "/")))) }),
    simpleSftpApiCall: async (method, p) => { assert.equal(method, "sync.serverToServerFpsync"); transfers.push(p); for (const file of p.relativePaths) inventory[p.destination.id][file] = structuredClone(inventory[p.source.id][file]); },
    patchDistributedJob: async (_root, _id, index, _attempt, patch) => { const j = jobs[index]; if (j.commandId !== patch.expectedCommandId) return; const { expectedCommandId, replaceMirroredWorkerIds, ...fields } = patch; Object.assign(j, fields); },
  };
  h.mergeLatestWorkerVersions = vm.runInNewContext(ts.transpileModule("class Host{" + mergeMember.getText(tsAst) + "};Host.prototype.mergeLatestWorkerVersions", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { vscode: { workspace: { getConfiguration: () => config }, Uri: { file: x => x } }, scopeInventoryPathAllowed, planLatestWorkerMerge, runSyncScopeBatch, loadSyncHolds: async () => options.holds || {}, isLocalCodeOwnedPath: file => (options.codeOwned || []).includes(file), safeSyncPath, path, workerFpsyncTaskLabel: () => "", UiCommandCancelled: Error, jobArtifactRunGeneration, isUnderMachineStatePrefixes: require("../../src/features/ProjectRootMap.ts").isUnderMachineStatePrefixes });
  return {
    jobs, root, inventory, h,
    run: async (selected = ["."], hostOptions = { force: true }) => { await new CompletedJobSyncHost(h, root, () => true).run(selected, hostOptions); return transfers; },
    // r9：真实 CompletedJobSyncHost 完整消费面（report/synced/mirrored 断言用）。
    runWithReport: async (selected = ["."], hostOptions = { force: true }) => ({ report: await new CompletedJobSyncHost(h, root, () => true).run(selected, hostOptions), transfers, jobs, inventory }),
  };
}

// ---- 入口 B：Plan 专用链（vm 抽取的真实 syncDistributedJobArtifacts 方法，manual 夹具同形） ----
function dedicatedEntry(files) {
  const assert = require("node:assert/strict");
  const root = fixtureRoot("jobB");
  const inventory = { w1: Object.fromEntries(Object.entries(files).map(([file, item]) => [file, { sha256: item.sha256 }])), w2: {} };
  const state = { schemaVersion: 1, plans: [{
    id: "plan", planFile: "plans/p.yaml", revision: "r", codeFingerprint: "fp", fullPlanJobCount: 1, resultPathPolicy: "declared",
    enqueuedAt: "2026-10-14T00:00:00Z", jobs: [{
      index: 0, case: "c0", seed: 42, attempt: 0, lifecycleProtocol: 2, resultPathPolicy: "declared", globalJobId: "plan:0",
      status: "completed", commandId: "command0", workerId: "w1", outputDir: OUT, actualExecutionMode: "train",
      artifacts: Object.fromEntries(Object.entries(files).map(([file, item]) => [file, item.sha256])),
      mirroredWorkerIds: ["w1"], fragmentWorkerIds: ["w1"],
    }],
  }] };
  const transfers = [];
  const sandbox = {
    Buffer, NativeResultManifest_1: require("../../dist/results/NativeResultManifest.js"),
    SafeRequestRetry_1: require("../../dist/core/SafeRequestRetry.js"), PlanOutputRetention: retention,
    PlanRunFreshness: require("../../dist/results/PlanRunFreshness.js"),
    workspaceRoot: () => root, errorMessage: value => value.message,
    collectDistributedJobArtifacts: require("../../dist/features/DistributedJobArtifacts.js").collectDistributedJobArtifacts,
    DistributedJobArtifacts_1: require("../../dist/features/DistributedJobArtifacts.js"),
    workerFpsyncTaskLabel: () => "sync", PlanArtifactTransfer_1: { workerFpsyncTaskLabel: () => "sync" },
    // dist 编译形态是命名空间引用（JobArtifactSyncIdentity_1.jobArtifactRunGeneration）。
    JobArtifactSyncIdentity_1: require("../../src/features/JobArtifactSyncIdentity.ts"),
    mapLimited: async (items, _count, fn) => Promise.all(items.map(fn)),
    vscode: { ProgressLocation: { Notification: 15 }, window: { withProgress: async (_o, work) => work({ report() {} }) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`this.methods = { ${jsMethod("async syncDistributedJobArtifacts(", "async rebuildDistributedResults(")} };`, sandbox);
  const host = {
    ...sandbox.methods,
    localPlanMetadata: { plans: [{ planFile: "plans/p.yaml", revision: "r", jobCount: 1 }] },
    lastWorkerProbes: { w1: { status: "ok" }, w2: { status: "ok" } },
    loadDistributedQueue: async () => queueApi.cloneDistributedQueue(state),
    distributedProjectContract: () => ({ fragmentPaths: ["fragment.json"], requiredPaths: ["model.pth", "run.log"] }),
    planOutputRetentionMode: () => "latest-complete",
    workerCodeSyncTargets: () => ["w1", "w2"].map(id => ({ id })),
    sftpServerOptions: value => ({ id: value.id }), assertSshTransportIdentities: async () => {},
    distributedOutputHashes: async (server, paths) => {
      const row = inventory[server.id]; const out = {};
      for (const p of paths) { if (row[p]) out[p] = row[p].sha256; for (const [file, item] of Object.entries(row)) if (file === p || file.startsWith(p + "/")) out[file] = item.sha256; }
      return out;
    },
    simpleSftpApiCall: async (method, payload) => {
      assert.equal(method, "sync.serverToServerFpsync");
      transfers.push(payload);
      for (const file of payload.relativePaths) inventory[payload.destination.id][file] = { ...inventory[payload.source.id][file] };
    },
    async patchDistributedJob(_root, id, index, _attempt, fields) {
      const job = state.plans.find(plan => plan.id === id).jobs.find(row => row.index === index);
      for (const [key, value] of Object.entries(fields)) {
        if (/^replace/.test(key)) continue;
        job[key] = Array.isArray(value) ? [...value] : value;
      }
    },
    recordActionError() {}, postState() {}, queuePlanArtifactSyncStatusCheck() {},
  };
  return { run: async () => { await host.syncDistributedJobArtifacts(root, await host.loadDistributedQueue(), "bulk", true); return transfers; } };
}

// ---- 现成 receiver 直调工具（Linux 专属套件使用；receiverPath 由调用方显式注入） ----
function tarOf(files) {
  const encoder = [];
  const header = (name, size) => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, "utf8");
    block.write("0000600\0", 100, 8, "ascii"); block.write("0001000\0", 108, 8, "ascii"); block.write("0001000\0", 116, 8, "ascii");
    block.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    block.write("00000000000\0", 136, 12, "ascii"); block.write("        ", 148, 8, "ascii"); block.write("0", 156, 1, "ascii");
    block.write("ustar\0", 257, 6, "ascii"); block.write("00", 263, 2, "ascii");
    let sum = 0; for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    return block;
  };
  for (const [name, item] of Object.entries(files)) {
    const data = Buffer.from(item.content, "utf8");
    encoder.push(header(name, data.length), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  encoder.push(Buffer.alloc(1024));
  return Buffer.concat(encoder);
}
function receive(receiverPath, root, identity, generation, files) {
  const entries = Object.entries(files).map(([name, item]) => ({ path: name, sha256: item.sha256, size: Buffer.byteLength(item.content, "utf8") }));
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify({ root, identity, generation, entries }), "utf8")).toString("base64");
  return spawnSync(process.env.PYTHON || "python3", ["-I", receiverPath, payload], { input: tarOf(files), encoding: "utf8", timeout: 20000 });
}
function slotsOf(root, identity) {
  const base = path.join(root, "simple_cluster", ".simple-sftp-staging", "d-" + identity.slice(0, 24));
  const seen = [];
  for (const leaf of ["0", "1"]) {
    try { seen.push(JSON.parse(fs.readFileSync(path.join(base, leaf, "manifest.json"), "utf8"))); } catch { /* empty slot */ }
  }
  return seen;
}

module.exports = { OUT, H, V1, V2, V3, completedJobEntry, dedicatedEntry, jobArtifactRunGeneration, receive, slotsOf };
