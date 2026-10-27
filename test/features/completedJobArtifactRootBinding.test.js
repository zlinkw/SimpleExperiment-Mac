// r8：completedJob 产物复制的只读根绑定准备回归。执行 dist 编译的 REAL
// codeSyncRootProbeConfig/targetRootGuard/prepareCodeSyncRootGuards/assertCodeSyncProbeBindingCurrent
// + REAL mergeLatestWorkerVersions（真实方法夹具，同 planSubmissionStateGuard 先例：只注入编译模块
// 实际存在的标识符，vm 内无网络、无写入）。唯一 stub 边界：GET probe 内核、状态/清单/传输 host 桩。
// 复现现场形态：未知/旧缓存 → 有界只读 GET → 冻结 guard → 合法传输；失败/不匹配/状态覆盖均 fail-closed 且无 fpsync。
// r9：混合端点（source 合法/B 冻结保护/C 允许）逐目标拒绝；准备后共享缓存替换为安全形态
// 不得解除冻结保护；保护命中必须显式失败（空 files+空 errors 假成功禁止，见 identity 套件真实 host 用例）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");

const distSource = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
function sliceMethod(startMarker, endMarker, label) {
  const start = distSource.indexOf(startMarker);
  assert.ok(start > 0, `compiled slice ${label}: start marker not found`);
  const end = distSource.indexOf(endMarker, start);
  assert.ok(end > start, `compiled slice ${label}: end marker not found`);
  return distSource.slice(start, end);
}
const guardSlice = sliceMethod("codeSyncRootProbeConfig(target) {", "machineStatePrefixesForTarget(target) {", "guard");
const prefixSlice = sliceMethod("machineStatePrefixesForTarget(target) {", "localMachineStateGuard(root) {", "prefix helpers");
const localGuardSlice = sliceMethod("localMachineStateGuard(root) {", "async refreshSyncScopeStatus(", "localMachineStateGuard");
const runtimeDirsSlice = sliceMethod("agentRuntimeDirs(actualWorkRoot, agentInstallDir) {", "currentAssignments() {", "agentRuntimeDirs");
const expectedRootSlice = sliceMethod("expectedWorkerAgentProjectRoot(workerId) {", "async openSetupGuide() {", "expectedWorkerAgentProjectRoot");
const stampSlice = sliceMethod("stampWorkerProbeGeneration(workerId, probe) {", "schedulePostLaunchAutoTest() {", "stampWorkerProbeGeneration");
const boundedSlice = sliceMethod("async boundedPromise(work, timeoutMs, timeoutError) {", "async recoverPlanOperationsForStopClear(", "boundedPromise");
const mergeSlice = sliceMethod("async mergeLatestWorkerVersions(", "async verifiedSftpProjectInventory(", "merge");
assert.match(mergeSlice, /prepareCodeSyncRootGuards/, "r8：执行的 merge 必须包含只读根绑定准备调用");
assert.match(mergeSlice, /缺少本次产物同步的机器状态绑定快照/, "r8：冻结快照缺键必须显式 fail-closed，禁止共享缓存回退");
assert.match(mergeSlice, /本次冻结机器状态映射保护/, "r9：files/groups 保护命中必须显式拒绝，禁止空成功");
assert.match(mergeSlice, /含祖先覆盖/, "r9：每批发送前必须对来源+该目标复核全部批次路径（含祖先覆盖）");
assert.equal(mergeSlice.split(String.raw`(?:\.lock|\.pid|\.exit_code)`).length - 1, 2,
  "r9 返修：work 与 files 两处旧禁止后缀 regex 必须都在（files 层不得依赖 scopeInventoryPathAllowed 等价性）");

function moduleFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(distSource);
  assert.ok(match, `compiled module function ${name} not found`);
  const end = distSource.indexOf("\n}", match.index);
  return distSource.slice(match.index, end + 2);
}
const moduleFunctions = ["remoteProjectName", "normalizeRemoteWorkRoot", "normalizeAgentProjectRoot",
  "enforceExpectedAgentProjectRoot", "errorMessage", "isLocalCodeOwnedPath", "isExcludedCodePath"].map(moduleFunction).join("\n");
// isExcludedCodePath 的两个模块级 Set 常量（真实定义原样注入，闭包完整）。
const readyStatusLine = /^const ENDPOINT_READY_PROBE_STATUSES = .*$/m.exec(distSource)[0];
const protectedTopStart = distSource.indexOf("const protectedCodeSyncTopLevelDirs = new Set([");
const protectedTop = distSource.slice(protectedTopStart, distSource.indexOf("]);", protectedTopStart) + 3);
const protectedData = /^const protectedDataAssetDirs = .*$/m.exec(distSource)[0];
assert.ok(protectedTopStart > 0 && protectedData, "protected-dir constants not found");
// r49 迁类：同 planSubmissionStateGuard —— 真实 core 模块断言 + 裸标识符最小别名，
// UiCommandCancelled_1 由下方 legacyNamespaces 正则按编译清单自动注入。
const uiCancelledModule = require("../../dist/core/UiCommandCancelled.js");
assert.ok(typeof uiCancelledModule.UiCommandCancelled === "function"
  && new uiCancelledModule.UiCommandCancelled("x").code === "USER_CANCELLED", "real UiCommandCancelled class not found");
const uiCancelledClass = "const UiCommandCancelled = UiCommandCancelled_1.UiCommandCancelled;";
const legacyRequire = id => {
  try { return require(require.resolve(id, { paths: [path.join(__dirname, "../../dist/extension")] })); }
  catch { return {}; }
};
const legacyNamespaces = {};
for (const match of distSource.matchAll(/^(?:const|var) ([A-Za-z_$][\w$]*) = (?:__importStar\()?require\("([^"]+)"\)\)?;$/gm)) {
  legacyNamespaces[match[1]] = legacyRequire(match[2]);
}

const CODE_ROOT = "/srv/work/MultiModal";
const OUT = "work_dirs/p/job0";
const SHA = crypto.createHash("sha256").update("alpha").digest("hex");
const TOKEN = "fixture-token";
// H03 形态活观测（传输字段全、状态根在代码根外——现场三端当前合法形态）
const h03Probe = (workerId, overrides) => ({ status: "ok", tcpOpen: true, healthOk: true, capabilitiesOk: true,
  projectRoot: CODE_ROOT, localForwardHost: "localhost", remoteAgentHost: "localhost",
  localForwardPort: 18767, remoteTelemetryPort: 18765, workerId, gpuCollectorProtocol: 1,
  agentStateDir: "/srv/work/simple_agent/state/projects/MultiModal.fixture",
  workerStateDir: "/home/u/.simple-cluster/worker-state", message: "Worker Telemetry API 可用。", ...overrides });
// 旧缓存形态：无传输/状态字段——绝不直接绑定（准备路径至多一次只读 GET）
const legacyProbe = () => ({ status: "ok", tcpOpen: true, healthOk: true, capabilitiesOk: true,
  projectRoot: CODE_ROOT, localForwardPort: 18767, remoteTelemetryPort: 18765, message: "Worker Telemetry API 可用。" });
const TUNNELS = ids => ids.map(id => ({ id, enabled: true, agentProjectDir: "/srv/work",
  localForwardHost: "localhost", localForwardPort: 18767, remoteAgentHost: "localhost",
  remoteAgentPort: 18765, remoteTelemetryPort: 18765, agentInstallDir: null, agentStateDir: null, workerStateDir: null }));
const TARGETS = ids => ids.map(id => ({ id, role: "worker", label: id, remotePath: CODE_ROOT,
  localForwardHost: "localhost", localForwardPort: 18767, remoteAgentHost: "localhost", remoteAgentPort: 18765,
  agentInstallDir: null, agentStateDir: null, workerStateDir: null }));
// 默认 GET 回执身份：prepare 按 targets 顺序仅对不可绑定端点各发一次有界 GET（probe
// config 不携带端点身份，真实代码以调用内 target 上下文冻结），第 n 次调用即未解析子集
// 第 n 项。本夹具的不可绑定判据=缓存缺失或旧形态（无 workerId 身份），与真实
// targetRootGuard 的"旧形态绝不直绑"在此一致；需要非常规回执的用例自带 probeImpl。
const unbindableOrder = (probes, ids) => TARGETS(ids).map(t => t.id).filter(id => !(probes || {})[id]?.workerId);

function fixture({ ids = ["nwpu3", "nwpu2"], probes, probeImpl, verifyOnly, afterPrepareSwap }) {
  // 真实 localMachineStateGuard 消费 globalStorageUri：真实环境它不在工作区根内。夹具用
  // 两个互不嵌套的 mkdtemp 兄弟目录复刻该形态（此前同置 os.tmpdir() 使 codeRoot 嵌套于
  // state 根内 → 合法地得出 prefixes [""] 全保护，属夹具失真而非产品行为）。
  const rootState = { root: fs.mkdtempSync(path.join(os.tmpdir(), "artifact-binding-root-")) };
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-binding-store-"));
  const calls = [];
  const fpsync = [];
  const probeOrder = unbindableOrder(probes, ids);
  let swapped = false;
  const sandbox = {
    ...legacyNamespaces, console, path, os, process, crypto,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    require: legacyRequire,
    workspaceRoot: () => rootState.root,
    vscode: { workspace: { getConfiguration: () => ({ get: (_k, dflt) => dflt }) }, Uri: { file: p => ({ fsPath: p }) } },
  };
  sandbox.XshellTunnelPortProbe_1 = Object.assign({}, legacyNamespaces.XshellTunnelPortProbe_1, {
    probeWorkerTelemetryTunnel: async (config, options) => {
      calls.push({ config: { ...config }, options: { ...(options || {}) } });
      const injected = probeImpl ? await probeImpl(calls.length, { rootState, calls, host, probeOrder }) : undefined;
      return injected === undefined ? { ...h03Probe(probeOrder[calls.length - 1]) } : injected;
    },
  });
  vm.runInNewContext(
    readyStatusLine + ";" + uiCancelledClass + ";" + protectedTop + "\n" + protectedData + "\n" + moduleFunctions + ";class _Host {" + [runtimeDirsSlice, expectedRootSlice,
    localGuardSlice, guardSlice, prefixSlice, stampSlice, boundedSlice, mergeSlice].join("\n") + "}" +
    "\nglobalThis.HostProto = _Host.prototype;",
    sandbox, { filename: "legacy-excerpt.js" });
  let assertCurrentCalls = 0;
  const host = {
    setupConfig: { workerTunnels: TUNNELS(ids) },
    tunnelConfig: { token: TOKEN },
    lastWorkerProbes: probes || {},
    context: { globalStorageUri: { fsPath: storagePath } },
    client: { id: "client-a" }, projectContextGeneration: 7,
    workerProbeSignatures: new Map(), workerProbeGenerations: new Map(),
    syncScopeMutationInFlight: false, planSyncInFlight: 0, codeSyncInFlight: 0,
    activeArtifactSyncScopes: new Map(), planCleanupHosts: new Map(),
    enabledWorkerConfigs: () => TUNNELS(ids),
    // 源=ids[0]（恒 nwpu3）持有唯一最新版，其余端点缺该文件——dest=除源以外全部。
    // r9 返修控制：三个旧禁止后缀行（.lock/.pid/.exit_code）直喂 scoped（绕过上游清单），
    // 验证 merge 内 files/generation/传输三层均不收录；普通产物行照常同步。
    refreshSyncScopeStatus: async () => Object.fromEntries([
      [OUT, { copies: true, detail: "" }],
      ...["model.pth", "latest.lock", "runner.pid", "job.exit_code"].map(name => [`${OUT}/${name}`,
        { versions: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? { sha256: SHA, size: 5 } : {}])) }]),
    ]),
    assertSshTransportIdentities: async () => {},
    sftpServerOptions: row => ({ id: row.id, remotePath: CODE_ROOT }),
    simpleSftpApiCall: async (method, payload) => {
      assert.equal(method, "sync.serverToServerFpsync");
      if (afterPrepareSwap && !swapped) throw new Error("夹具时序断言：传输前缓存必须已被替换");
      fpsync.push(payload);
    },
    verifiedSftpProjectInventory: async ({ scopePaths }) => ({
      files: Object.fromEntries(scopePaths.filter(file => file === `${OUT}/model.pth`)
        .map(file => [file, { sha256: SHA }])) }),
  };
  const proto = sandbox.HostProto;
  for (const name of Object.getOwnPropertyNames(proto))
    if (name !== "constructor" && !(name in host)) host[name] = proto[name].bind(host);
  const run = async () => {
    const targets = TARGETS(ids);
    return await host.mergeLatestWorkerVersions(rootState.root, targets, [OUT], ".", () => {}, {
      completedJob: { sourceId: "nwpu3", planId: "plan", commandId: "command0",
        retentionKey: JSON.stringify(["job-artifacts", "plans/p.yaml", 0, "c0", 42]) },
      assertCurrent: async () => {
        assertCurrentCalls += 1;
        // r9 确定性时序：prepare 完成后（合并内第二次队列 fence）把指定端点的共享缓存
        // 替换为"看似安全"的健康形态——冻结 guard 必须继续拒绝，实时共享缓存不得翻案。
        if (afterPrepareSwap && assertCurrentCalls === 2) {
          host.lastWorkerProbes = { ...(host.lastWorkerProbes || {}), [afterPrepareSwap]: h03Probe(afterPrepareSwap) };
          swapped = true;
        }
      },
      verifyOnly,
    });
  };
  return { host, run, calls, fpsync, rootState, swapped: () => swapped, assertCurrentCount: () => assertCurrentCalls };
}

test("a bound current probe performs zero GETs and transfers with the r5/r6 identity", async () => {
  const f = fixture({ probes: { nwpu3: h03Probe("nwpu3"), nwpu2: h03Probe("nwpu2") } });
  // 夹具形态自检：globalStorage 不在工作区根内（同真实环境），local guard 不得全保护。
  // r17：项目内受管子树 simple_cluster 现在恒为已验证前缀——除它以外仍不得出现任何受保护映射。
  assert.deepEqual(f.host.localMachineStateGuard(f.rootState.root).prefixes.filter(p => !p.startsWith("simple_cluster")), [], "夹具 local 映射形态失真（r17 后仅允许项目受管子树被保护）");
  const result = await f.run();
  assert.equal(f.calls.length, 0, "已可绑定端点不得新增任何 GET");
  assert.equal(result.errors.length, 0);
  assert.equal(f.fpsync.length, 1);
  assert.equal(f.fpsync[0].retentionKey, JSON.stringify(["job-artifacts", "plans/p.yaml", 0, "c0", 42]));
  assert.match(f.fpsync[0].generation, /^[0-9a-f]{64}$/, "r5/r6 身份断言保持");
  // {…} 展开归一主 realm 原型（vm 上下文对象跨 realm，deepStrictEqual 不比内容先比原型）。
  assert.deepEqual({ ...result.files }, { [`${OUT}/model.pth`]: SHA }, "合法绑定下冻结源清单须含本次产物文件");
  assert.equal(f.fpsync[0].generation,
    require("../../dist/features/JobArtifactSyncIdentity.js").jobArtifactRunGeneration("plan", "command0", result.files),
    "r5：generation 必须由本次冻结源清单推导");
  // r9 返修控制：.lock/.pid/.exit_code 不进 files/generation 输入/传输批次（queue.artifacts
  // 在 host 层逐字 {...job.artifacts, ...result.files}，files 干净即源清单干净）。
  assert.deepEqual(Object.keys(result.files).filter(name => /\.(?:lock|pid|exit_code)$/i.test(name)), [],
    "旧禁止后缀不得进入源清单与 generation 输入");
  assert.deepEqual([...f.fpsync[0].relativePaths], [`${OUT}/model.pth`], "旧禁止后缀不得进入传输批次；普通产物照常传输");
});

test("cold or unbindable cached cache gets exactly one bounded read-only GET per unknown endpoint, then transfers", async () => {
  const f = fixture({ probes: { nwpu2: h03Probe("nwpu2") } }); // nwpu3 无缓存=未知，nwpu2 已合法绑定
  const result = await f.run();
  assert.equal(f.calls.length, 1, "仅未知端点 nwpu3 一次 GET；已绑定端点不重复 GET");
  assert.equal(f.calls[0].config.localForwardPort, 18767);
  assert.equal(result.errors.length, 0);
  assert.equal(f.fpsync.length, 1);
  assert.ok(f.assertCurrentCount() >= 3, "准备前后与传输前均须 await 原队列 assertCurrent");
  const cold = fixture({ probes: { nwpu2: legacyProbe() } }); // nwpu2 旧形状缓存：不绑定→一次 GET
  const coldResult = await cold.run();
  assert.equal(cold.calls.length, 2, "两个未知形态端点各至多一次 GET");
  assert.equal(coldResult.errors.length, 0);
  assert.equal(cold.fpsync.length, 1);
});

test("a real state root covering the frozen manifest still refuses the transfer after a successful GET", async () => {
  // 两端 GET 均成功、worker 身份各自正确，但状态根覆盖产物目录；prepare 完成后共享缓存
  // 被替换为健康（无覆盖）形态——冻结 guard 必须继续拒绝，r9：显式失败而非空成功。
  const f = fixture({ probes: {}, afterPrepareSwap: "nwpu2",
    probeImpl: async (n, { probeOrder }) => h03Probe(probeOrder[n - 1], { agentStateDir: `${CODE_ROOT}/work_dirs` }) });
  await assert.rejects(f.run(), /冻结机器状态映射均保护|来源 nwpu3 的本次冻结机器状态映射保护/);
  assert.equal(f.calls.length, 2, "两个未知端点各一次只读 GET，均返回覆盖收据");
  assert.equal(f.swapped(), true, "准备后共享缓存确已被替换为安全形态");
  assert.equal(f.fpsync.length, 0, "覆盖状态路径的产物文件必须被冻结 guard 拦下，不传输");
});

test("probe failure, mismatched worker, and transport-field-less receipts all fail closed with zero fpsync", async () => {
  const failing = fixture({ probes: {}, probeImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(failing.run(), /机器状态映射只读复核失败/);
  assert.equal(failing.fpsync.length, 0);
  const wrongWorker = fixture({ probes: {}, probeImpl: async () => h03Probe("someone-else") });
  await assert.rejects(wrongWorker.run(), /机器状态映射未知/);
  assert.equal(wrongWorker.fpsync.length, 0);
  const legacyReceipt = fixture({ probes: {}, probeImpl: async () => legacyProbe() });
  await assert.rejects(legacyReceipt.run(), /机器状态映射未知/);
  assert.equal(legacyReceipt.fpsync.length, 0);
});

test("workspace, token, endpoint and config changes during preparation cancel before any transfer", async () => {
  const switched = fixture({ probes: {}, probeImpl: async (_n, { rootState }) => { rootState.root = "/other/project"; } });
  await assert.rejects(switched.run(), /工作区或连接已切换/);
  assert.equal(switched.fpsync.length, 0);
  const token = fixture({ probes: {}, probeImpl: async (_n, { host }) => { host.tunnelConfig = { token: "rotated" }; } });
  await assert.rejects(token.run(), /隧道凭据已变化/);
  assert.equal(token.fpsync.length, 0);
  const endpoint = fixture({ probes: {}, probeImpl: async (_n, { host }) => { host.setupConfig.workerTunnels = []; } });
  await assert.rejects(endpoint.run(), /Worker 配置已变化/);
  assert.equal(endpoint.fpsync.length, 0);
  const config = fixture({ probes: {}, probeImpl: async (_n, { host }) => {
    host.setupConfig.workerTunnels = TUNNELS(["nwpu3", "nwpu2"]).map(row => ({ ...row, localForwardPort: 19999 }));
  } });
  // 改端口同时改变 worker 字段与有效配置：两类 fence 先后顺序属实现细节，必须命中"配置已变化"族之一。
  await assert.rejects(config.run(), /配置已变化/);
  assert.equal(config.fpsync.length, 0);
});

test("r9 mixed endpoints: source safe, B frozen-protected, C safe — B never joins a group and no bytes flow", async () => {
  // destinations.some 只证明"至少一个目标可达"：混合形态下 B 绝不能经 groups 收到文件。
  // B 可绑定（缓存即带覆盖状态根，零 GET），prepare 后共享缓存再替换为安全形态仍须拒绝。
  const f = fixture({ ids: ["nwpu3", "nwpu4", "nwpu2"], afterPrepareSwap: "nwpu4",
    probes: { nwpu3: h03Probe("nwpu3"), nwpu2: h03Probe("nwpu2"), nwpu4: h03Probe("nwpu4", { agentStateDir: `${CODE_ROOT}/work_dirs` }) } });
  await assert.rejects(f.run(), /nwpu4 的本次冻结机器状态映射保护/);
  assert.equal(f.calls.length, 0, "三端均可绑定：零 GET，也不得因缓存替换解除冻结保护");
  assert.equal(f.swapped(), true, "B 的共享缓存确已被替换为不保护形态");
  assert.equal(f.fpsync.length, 0, "受保护目标入组即显式拒绝；同 item 的合法目标也随本次操作停止，不得半发送");
});

test("verifyOnly reports pending without triggering probe GETs or transfers", async () => {
  const f = fixture({ probes: {}, verifyOnly: true });
  const result = await f.run();
  assert.equal(f.calls.length, 0, "verifyOnly 不触发写前准备 GET");
  assert.equal(f.fpsync.length, 0);
  assert.match(result.errors.join(""), /待同步/, "verifyOnly 保持原未决报告语义");
});
