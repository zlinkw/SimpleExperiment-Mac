const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  projectIdentityKey, resolveProjectRootMap, isMachineStateAbsolute,
  machineStateRelativePrefixes, isUnderMachineStatePrefixes, machineStateGuard, canonicalRemotePath,
} = require("../../dist/features/ProjectRootMap");
const { scopeInventoryPathAllowed, collectLocalScopeInventory, hashLocalScopeNames,
  collectSelectedLocalScopeFiles } = require("../../dist/features/SyncScopeStatus.js");
const { classifyCleanupCandidates } = require("../../dist/features/PlanCleanup");

test("POSIX root mapping preserves legal final spaces in project and machine-state identities", () => {
  const map = resolveProjectRootMap({ projectDir: "/srv/项目 ", installDir: "/srv/runtime ",
    stateDir: "/srv/项目 / state ", machineStateDirs: ["/srv/machine state "], artifactDirs: ["/srv/项目 /runs "] });
  assert.equal(map.mapping, "resolved");
  assert.equal(map.codeRoot, "/srv/项目 ");
  assert.equal(map.programRoot, "/srv/runtime ");
  assert.equal(map.stateRoot, "/srv/项目 / state ");
  assert.deepEqual(map.artifactRoots, ["/srv/项目 /runs "]);
  assert.deepEqual(machineStateRelativePrefixes(map), [" state "]);
  assert.ok(isMachineStateAbsolute(map, "/srv/项目 / state /frame.json"));
  assert.ok(!isMachineStateAbsolute(map, "/srv/项目 / state/frame.json"));
  assert.ok(!isMachineStateAbsolute(map, "/srv/machine state/frame.json"));
  assert.notEqual(projectIdentityKey({ projectDir: "/srv/项目 " }), projectIdentityKey({ projectDir: "/srv/项目" }));
});

const candidate = relative => ({ nodeId: "local", relativePath: relative, type: "file", category: "产物",
  owners: ["plan-key-1"], evidence: ["任务产物: runner.outputs"], dependencies: [] });

function fixtureTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-map-"));
  for (const [rel, content] of Object.entries(spec)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf-8");
  }
  return root;
}

test("project identity is stable across separator and drive-case drift and prefers an explicit id", () => {
  assert.equal(projectIdentityKey({ projectId: " proj-7 " }), "proj-7");
  assert.equal(projectIdentityKey({ projectDir: "D:/Lab/Proj" }), projectIdentityKey({ projectDir: "d:\\Lab\\Proj\\" }));
  assert.notEqual(projectIdentityKey({ projectDir: "/data/a" }), projectIdentityKey({ projectDir: "/data/b" }));
});

test("state root defaults to <installDir>/state, matching the Agent's real default namespace anchor", () => {
  // The Agent's default_agent_state_dir is <install>/state/projects/<ns>; the map
  // default must anchor at the SAME <install>/state (covering the projects
  // namespace), never at a guessed global like <home>/.se or the code root itself.
  const map = resolveProjectRootMap({ projectId: "p", projectDir: "/srv/proj", installDir: "/srv/runtime" });
  assert.equal(map.stateRoot, "/srv/runtime/state");
  assert.ok(isMachineStateAbsolute(map, "/srv/runtime/state/projects/ns7/gpu_frame.json"));
  assert.ok(!isMachineStateAbsolute(map, "/srv/runtime/stateX/gpu_frame.json"));
  assert.ok(!isMachineStateAbsolute(map, "/srv/proj/state/projects/ns7/gpu_frame.json"));
});

test("relative prefixes come from the verified mapping, never from name substrings", (t) => {
  const nested = resolveProjectRootMap({ projectId: "p", projectDir: "/srv/proj",
    installDir: "/srv/runtime", stateDir: "/srv/proj/.se-deploy/zlk_state" });
  assert.deepEqual(machineStateRelativePrefixes(nested), [".se-deploy/zlk_state"]);
  // Outside the code root: relative enumeration cannot reach it → no exclusions.
  const outside = resolveProjectRootMap({ projectId: "p", projectDir: "/srv/proj",
    installDir: "/srv/runtime", stateDir: "/data/zlk_state" });
  assert.deepEqual(machineStateRelativePrefixes(outside), []);
  // A sibling path that merely shares a branch is still outside.
  const sibling = resolveProjectRootMap({ projectId: "p", projectDir: "/srv/proj/deep",
    installDir: "/srv/runtime", stateDir: "/srv/proj/state" });
  assert.deepEqual(machineStateRelativePrefixes(sibling), []);
  // Degenerate equal roots: the WHOLE code root is machine state (callers must obey).
  const equal = resolveProjectRootMap({ projectId: "p", projectDir: "/srv/proj",
    installDir: "/srv/proj", stateDir: "/srv/proj" });
  assert.deepEqual(machineStateRelativePrefixes(equal), [""]);
  const prefixes = machineStateRelativePrefixes(nested);
  assert.ok(isUnderMachineStatePrefixes(".se-deploy/zlk_state/workers/w/gpu_frame.json", prefixes));
  // Legitimate project data that merely CONTAINS state/projects segments stays legal.
  assert.ok(!isUnderMachineStatePrefixes("work_dirs/run/state/projects/x/keep.txt", prefixes));
  assert.ok(!isUnderMachineStatePrefixes("state/projects/x", prefixes));
  // Ancestors: cleanup must also protect a directory whose deletion would take
  // the state root with it; the sync gate (no ancestors) must not over-exclude.
  assert.ok(isUnderMachineStatePrefixes(".se-deploy", prefixes, true));
  assert.ok(!isUnderMachineStatePrefixes(".se-deploy", prefixes, false));
  // Unresolvable traversal fails CLOSED for cleanup and stays open for sync.
  assert.ok(isUnderMachineStatePrefixes(".se-deploy/../zlk_state", prefixes, true));
  assert.ok(!isUnderMachineStatePrefixes("x/../../etc/passwd", prefixes, false));
  // Whole-root prefix covers everything; empty prefix covers nothing.
  assert.ok(isUnderMachineStatePrefixes("src/main.py", [""]));
  assert.ok(!isUnderMachineStatePrefixes("src/main.py", []));
});

test("sync inventory excludes exactly the mapped state tree and keeps look-alike project data", async (t) => {
  const root = fixtureTree({
    "src/main.py": "print(1)\n",
    "run/state/nest/gpu_frame.json": "{}",
    "run/state/loose.bin": "x",
    "work_dirs/run/state/projects/x/keep.txt": "science\n",
    "state/projects/legacy.txt": "unmapped dir named state\n",
  });
  // Fixture KEPT for audit (no recursive deletion of absolute paths from tests).
  console.log("kept root-map fixture at " + root);
  const map = resolveProjectRootMap({ projectId: "p", projectDir: root,
    installDir: path.join(root, "runtime"), stateDir: path.join(root, "run", "state") });
  const prefixes = machineStateRelativePrefixes(map);
  const without = Object.keys(await collectLocalScopeInventory(root, ".", true)).sort();
  assert.ok(without.includes("run/state/nest/gpu_frame.json"), without.join(","));
  const withMap = Object.keys(await collectLocalScopeInventory(root, ".", true, undefined, undefined, prefixes)).sort();
  assert.deepEqual(withMap, ["src/main.py", "state/projects/legacy.txt", "work_dirs/run/state/projects/x/keep.txt"]);
  // The gate itself: mapped paths rejected only WITH the verified prefixes.
  assert.ok(scopeInventoryPathAllowed("run/state/nest/gpu_frame.json", false, []));
  assert.ok(!scopeInventoryPathAllowed("run/state/nest/gpu_frame.json", false, prefixes));
  assert.ok(!scopeInventoryPathAllowed("run/state", true, prefixes));
  assert.ok(scopeInventoryPathAllowed("work_dirs/run/state/projects/x/keep.txt", false, prefixes));
  // Hashing a mapped path is a hard error, not a silent skip.
  await assert.rejects(() => hashLocalScopeNames(root, ["run/state/loose.bin"], undefined, undefined, {}, prefixes),
    /机器状态|排除项/);
  // Selecting the state directory as a source finds nothing to sync (pruned walk).
  await assert.rejects(() => collectSelectedLocalScopeFiles(root, [{ path: "run/state", directory: true }],
    undefined, prefixes), /没有可同步文件/);
  // Without the mapping the same call still works — exclusion is mapping-driven only.
  const selected = await collectSelectedLocalScopeFiles(root, [{ path: "run/state", directory: true }]);
  assert.equal(Object.keys(selected).length, 2);
});

test("default install-internal mapping excludes the state namespace inside the code root", async (t) => {
  const root = fixtureTree({
    "train.py": "x\n",
    "state/projects/ns7/gpu_frame.json": "{}",
    "state/agent/register.json": "{}",
    "work_dirs/exp1/result.json": "{}",
  });
  // Fixture KEPT for audit (no recursive deletion of absolute paths from tests).
  console.log("kept root-map fixture at " + root);
  // No custom stateDir: the default <install>/state with install == code root is
  // exactly the Agent's real layout, so state/projects/<ns>/... is machine state.
  const map = resolveProjectRootMap({ projectId: "p", projectDir: root, installDir: root });
  const prefixes = machineStateRelativePrefixes(map);
  assert.deepEqual(prefixes, ["state"]);
  const keys = Object.keys(await collectLocalScopeInventory(root, ".", true, undefined, undefined, prefixes));
  assert.deepEqual(keys, ["train.py", "work_dirs/exp1/result.json"]);
});

test("cleanup classification protects mapped state paths AND their ancestors, never look-alikes", () => {
  const scope = {
    projectId: "p", planKey: "k", planFile: "plan.json", planHash: "h", runIds: [],
    machineStateByNode: { local: { prefixes: ["run/state"], unknown: false } },
    candidates: [
      candidate("run/state/nest/gpu_frame.json"),
      candidate("run"),
      candidate("work_dirs/run/state/projects/x/keep.txt"),
      candidate("state/projects/legacy.txt"),
    ],
  };
  const rows = classifyCleanupCandidates(scope);
  const byPath = new Map(rows.map(row => [row.relativePath, row]));
  assert.match(byPath.get("run/state/nest/gpu_frame.json").scopeProtectedReason, /机器状态/);
  assert.match(byPath.get("run").scopeProtectedReason, /机器状态/); // ancestor deletion would take state with it
  assert.equal(byPath.get("work_dirs/run/state/projects/x/keep.txt").scopeProtectedReason, undefined);
  assert.equal(byPath.get("state/projects/legacy.txt").scopeProtectedReason, undefined);
  // Scopes for endpoints without a resolved guard entry keep previous semantics.
  const legacyScope = { ...scope, machineStateByNode: undefined };
  const legacyRows = classifyCleanupCandidates(legacyScope);
  assert.equal(new Map(legacyRows.map(r => [r.relativePath, r])).get("run/state/nest/gpu_frame.json").scopeProtectedReason, undefined);
});

test("cleanup guards bind per endpoint: WorkerA's nested state never touches WorkerB's same-spelled artifact", () => {
  // WorkerA maps state to <code>/run/state; WorkerB has no mapping at all and a
  // LEGITIMATE research artifact spelled run/state/. A unioned prefix list
  // would (wrongly) protect B's artifact — per-node binding must not.
  const workerA = resolveProjectRootMap({ projectId: "a", projectDir: "/data/wa", installDir: "/data/wa/runtime",
    stateDir: "/data/wa/run/state" });
  const workerB = resolveProjectRootMap({ projectId: "b", projectDir: "/data/wb", installDir: "/opt/runtime-b" });
  assert.deepEqual(machineStateRelativePrefixes(workerA), ["run/state"]);
  assert.deepEqual(machineStateRelativePrefixes(workerB), []); // state root lives outside B's code root
  const rowA = { ...candidate("run/state/train_frame.json"), nodeId: "worker-a" };
  const rowB = { ...candidate("run/state/measurements.csv"), nodeId: "worker-b" };
  const scope = { projectId: "p", planKey: "k", planFile: "plan.json", planHash: "h", runIds: [],
    machineStateByNode: { "worker-a": machineStateGuard(workerA), "worker-b": machineStateGuard(workerB) },
    candidates: [rowA, rowB] };
  const rows = classifyCleanupCandidates(scope);
  const byNode = new Map(rows.map(row => [row.nodeId, row]));
  assert.match(byNode.get("worker-a").scopeProtectedReason, /机器状态/);
  assert.equal(byNode.get("worker-b").scopeProtectedReason, undefined);
});

test("cleanup fails closed for a node whose state config cannot be canonicalized", () => {
  const broken = resolveProjectRootMap({ projectId: "x", projectDir: "/data/x", stateDir: "/data/x/../../../etc" });
  assert.equal(broken.mapping, "unknown");
  assert.ok(broken.unknownFields.includes("stateRoot"), JSON.stringify(broken.unknownFields));
  const guard = machineStateGuard(broken);
  assert.equal(guard.unknown, true);
  assert.deepEqual(guard.prefixes, []); // no bogus prefix invented
  const scope = { projectId: "p", planKey: "k", planFile: "plan.json", planHash: "h", runIds: [],
    machineStateByNode: { "worker-x": guard }, candidates: [{ ...candidate("anything/train.py"), nodeId: "worker-x" }] };
  const row = classifyCleanupCandidates(scope)[0];
  assert.match(row.scopeProtectedReason, /映射不可用/); // unknown is NOT silently safe
});

test("canonicalization folds in-bounds traversals and rejects relative, escaping and empty roots", () => {
  assert.deepEqual(canonicalRemotePath("/srv/proj/../other"), { ok: true, path: "/srv/other" });
  assert.deepEqual(canonicalRemotePath("/srv/./a//b/"), { ok: true, path: "/srv/a/b" });
  assert.deepEqual(canonicalRemotePath("D:\\Lab\\Proj"), { ok: true, path: "d:/lab/proj" });
  assert.deepEqual(canonicalRemotePath("/"), { ok: true, path: "/" });
  assert.deepEqual(canonicalRemotePath("srv/proj"), { ok: false, reason: "relative" });
  assert.deepEqual(canonicalRemotePath("/srv/../../etc"), { ok: false, reason: "escaping" });
  assert.deepEqual(canonicalRemotePath("/data/x/../../../etc"), { ok: false, reason: "escaping" });
  assert.deepEqual(canonicalRemotePath("d:/a/../.."), { ok: false, reason: "escaping" });
  assert.deepEqual(canonicalRemotePath("   "), { ok: false, reason: "empty" });
  // In-bounds ".." folds to the true location, so the old "../machine"-shaped
  // relative prefix can no longer be produced: the folded /srv/machine simply
  // lives OUTSIDE the code root (no relative enumeration reaches it) → no prefix.
  const folded = resolveProjectRootMap({ projectId: "p", projectDir: "/srv/proj", stateDir: "/srv/proj/../machine" });
  assert.equal(folded.mapping, "resolved");
  assert.equal(folded.stateRoot, "/srv/machine");
  assert.deepEqual(machineStateRelativePrefixes(folded), []);
  // A genuinely escaping explicit state dir stays UNKNOWN with nothing invented.
  const escaping = resolveProjectRootMap({ projectId: "p", projectDir: "/srv/proj", stateDir: "/srv/proj/../../../machine" });
  assert.equal(escaping.mapping, "unknown");
  assert.equal(escaping.stateRoot, "");
  assert.deepEqual(machineStateRelativePrefixes(escaping), []);
});

test("identity and mapping survive separator/spelling drift but never merge distinct roots", () => {
  assert.equal(projectIdentityKey({ projectDir: "/srv/proj/sub/.." }), projectIdentityKey({ projectDir: "/srv/proj" }));
  // Root-boundary: the code root "/" contains everything; no empty-segment
  // misjudgment (old bug: "/" split produced empty prefixes/mismatches).
  const rootMap = resolveProjectRootMap({ projectId: "root", projectDir: "/", stateDir: "/run/state" });
  assert.equal(rootMap.mapping, "resolved");
  assert.deepEqual(machineStateRelativePrefixes(rootMap), ["run/state"]);
  const wholeRoot = resolveProjectRootMap({ projectId: "root", projectDir: "/", stateDir: "/" });
  assert.deepEqual(machineStateRelativePrefixes(wholeRoot), [""]); // pathological: whole tree is state
  // Drive and POSIX roots are different spaces and never contain each other.
  const win = resolveProjectRootMap({ projectId: "w", projectDir: "D:/lab", stateDir: "d:/lab/.state" });
  assert.deepEqual(machineStateRelativePrefixes(win), [".state"]);
  assert.ok(isMachineStateAbsolute(win, "D:/lab/.state/projects/ns/gpu_frame.json"));
  assert.ok(!isMachineStateAbsolute(win, "/srv/lab/.state/x.json"));
});

test("all machine roots and ancestors are protected, including code nested inside state", () => {
  const map = resolveProjectRootMap({ projectDir: "/srv/project", installDir: "/opt/runtime",
    stateDir: "/srv/project/agent", machineStateDirs: ["/srv/project/run/collector", "/other/state"] });
  assert.deepEqual(machineStateGuard(map), { prefixes: ["agent", "run/collector"], unknown: false });
  assert.ok(isMachineStateAbsolute(map, "/srv/project/run/collector/gpu_frame.json"));
  assert.ok(isUnderMachineStatePrefixes("run", machineStateRelativePrefixes(map), true));
  assert.ok(isUnderMachineStatePrefixes("RUN/Collector/frame.json", machineStateRelativePrefixes(map), true));
  assert.ok(!isUnderMachineStatePrefixes("work_dirs/run", machineStateRelativePrefixes(map), true));
  assert.deepEqual(machineStateRelativePrefixes(resolveProjectRootMap({ projectDir: "/srv/state/project", stateDir: "/srv/state" })), [""]);
  assert.deepEqual(machineStateRelativePrefixes(resolveProjectRootMap({ projectDir: "D:/Lab", stateDir: "d:/" })), [""]);
  assert.ok(isMachineStateAbsolute(resolveProjectRootMap({ projectDir: "D:/lab", stateDir: "d:/" }), "D:/LAB/a"));
  assert.equal(resolveProjectRootMap({ projectDir: "/srv/project", machineStateDirs: ["relative"] }).mapping, "unknown");
  assert.equal(canonicalRemotePath("/srv/\u0000bad").ok, false);
  assert.equal(canonicalRemotePath("\\\\server\\share").ok, false);
});

test("host maps configured roots and the bound worker probe using the actual code root", () => {
  const ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  let member;
  function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "targetRootGuard") member = node; ts.forEachChild(node, visit); }
  visit(ast);
  const method = vm.runInNewContext(ts.transpileModule("class Host{" + member.getText(ast) + "};Host.prototype.targetRootGuard",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { resolveProjectRootMap, machineStateGuard, remotePathKey: value => canonicalRemotePath(String(value || "")).path });
  const host = { setupConfig: { workerTunnels: [{ id: "w", agentProjectDir: "/srv", agentInstallDir: "/opt/runtime",
    agentStateDir: "/srv/project/control", workerStateDir: "/srv/project/run/collector", remoteAgentPort: 23457, localForwardPort: 23456 }] },
    agentRuntimeDirs: () => ({ workDir: "/srv/project", installDir: "/opt/runtime" }), lastWorkerProbes: {} };
  const target = { id: "w", remotePath: "/srv/project", localForwardPort: 23456, remoteAgentPort: 23457 };
  assert.deepEqual(JSON.parse(JSON.stringify(method.call(host, target))), { prefixes: ["control", "run/collector"], unknown: false });
  host.lastWorkerProbes.w = { status: "ok", workerId: "w", projectRoot: "/srv/project", localForwardHost: "127.0.0.1",
    remoteAgentHost: "127.0.0.1", remoteTelemetryPort: 23457, localForwardPort: 23456,
    agentStateDir: "/srv/project/actual-agent", workerStateDir: "/srv/project/actual-collector", gpuCollectorProtocol: 1 };
  assert.deepEqual(JSON.parse(JSON.stringify(method.call(host, target))), { prefixes: ["actual-agent", "actual-collector", "control", "run/collector"], unknown: false });
  host.lastWorkerProbes.w.localForwardHost = "another-host";
  assert.deepEqual(JSON.parse(JSON.stringify(method.call(host, target))), { prefixes: ["control", "run/collector"], unknown: false });
  host.lastWorkerProbes.w.localForwardHost = "127.0.0.1";
  host.lastWorkerProbes.w.remoteTelemetryPort = 23458;
  assert.deepEqual(JSON.parse(JSON.stringify(method.call(host, target))), { prefixes: ["control", "run/collector"], unknown: false });
  host.lastWorkerProbes.w.remoteTelemetryPort = 23457;
  host.lastWorkerProbes.w.workerId = "foreign";
  assert.deepEqual(JSON.parse(JSON.stringify(method.call(host, target))), { prefixes: ["control", "run/collector"], unknown: false });
  delete host.setupConfig.workerTunnels[0].workerStateDir;
  assert.equal(method.call(host, target).unknown, true);
});


test("shared transfer boundary protects both endpoints, mapped downloads and unknown scopes", () => {
  const ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
  let member;
  function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "assertTransferRootSafety") member = node; ts.forEachChild(node, visit); }
  visit(ast);
  const method = vm.runInNewContext(ts.transpileModule("class Host{" + member.getText(ast) + "};Host.prototype.assertTransferRootSafety",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      isUnderMachineStatePrefixes, fileOperationIndexPaths: require("../../dist/features/ProjectFileIndex.js").fileOperationIndexPaths,
      workspaceRoot: () => "/local/project"
    });
  const host = { targetRootGuard: node => node && ({prefixes: node.id === "a" ? ["work_dirs/state"] : [], unknown: false}),
    localMachineStateGuard: () => ({prefixes: ["control"], unknown: false}) };
  const request = {source:{id:"a"}, destination:{id:"b"}, relativePaths:["work_dirs/state/frame.json"]};
  assert.throws(() => method.call(host, "sync.serverToServerFpsync", request), /MACHINE_STATE/);
  request.relativePaths = ["work_dirs"];
  assert.throws(() => method.call(host, "sync.serverToServerFpsync", request), /MACHINE_STATE/);
  request.relativePaths = ["tmp/result/metrics.csv", "work_dir/job/model.pt"];
  assert.doesNotThrow(() => method.call(host, "sync.serverToServerFpsync", request));
  request.destination = null;
  assert.throws(() => method.call(host, "sync.serverToServerFpsync", request), /MACHINE_STATE/);
  assert.throws(() => method.call(host, "sync.downloadMappedPaths", {server:{id:"b"}, entries:[{remotePath:"tmp/result/metrics.csv",localRelativePath:"control/result.csv"}]}), /MACHINE_STATE/);
  assert.throws(() => method.call(host, "upload.workspace", {server:{id:"a"}}), /MACHINE_STATE/);
  assert.doesNotThrow(() => method.call(host, "sync.projectInventory", {}));
});
