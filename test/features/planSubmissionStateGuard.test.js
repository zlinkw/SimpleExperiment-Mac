const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

// Real-chain regression for the selected-PLAN submission gate, executing the
// REAL COMPILED targetRootGuard / codeSyncRootProbeConfig / prepareCodeSyncRootGuards /
// syncCodeTargets from dist/extension/legacy.js (plan r2: no src-AST copies, and
// the vm injects ONLY identifiers that exist in the compiled module — the
// historical injected remotePathKey masked the unbound identifier bug, so no
// production-absent free variable may reappear here). A static check below
// fails if the unbound remotePathKey call is ever reintroduced into the guard.
// Stubbed boundaries: the GET probe (network), the extension command, and the
// LOCAL manifest reader (fixture root is virtual); after the gate, the upload
// path is cut by a sentinel. Probe timeouts use the injected stub, never a
// real 8-second wait. Nothing here performs any network I/O or remote write.

const distSource = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");

function sliceMethod(startMarker, endMarker, label) {
  const start = distSource.indexOf(startMarker);
  assert.ok(start > 0, `compiled slice ${label}: start marker not found`);
  const end = distSource.indexOf(endMarker, start);
  assert.ok(end > start, `compiled slice ${label}: end marker not found`);
  return distSource.slice(start, end);
}
// The guard block: codeSyncRootProbeConfig + targetRootGuard +
// prepareCodeSyncRootGuards + assertCodeSyncProbeBindingCurrent.
const guardSlice = sliceMethod("codeSyncRootProbeConfig(target) {", "machineStatePrefixesForTarget(target) {", "guard");
const localGuardSlice = sliceMethod("localMachineStateGuard(root) {", "async refreshSyncScopeStatus(", "localMachineStateGuard");
const runtimeDirsSlice = sliceMethod("agentRuntimeDirs(actualWorkRoot, agentInstallDir) {", "currentAssignments() {", "agentRuntimeDirs");
const expectedRootSlice = sliceMethod("expectedWorkerAgentProjectRoot(workerId) {", "async openSetupGuide() {", "expectedWorkerAgentProjectRoot");
const stampSlice = sliceMethod("stampWorkerProbeGeneration(workerId, probe) {", "schedulePostLaunchAutoTest() {", "stampWorkerProbeGeneration");
const boundedSlice = sliceMethod("async boundedPromise(work, timeoutMs, timeoutError) {", "async recoverPlanOperationsForStopClear(", "boundedPromise");
const manifestKeySlice = sliceMethod("planSubmissionManifestKey(root, includePaths, scopePaths, holds) {", "async syncCodeTargets(", "planSubmissionManifestKey");
const syncSlice = sliceMethod("async syncCodeTargets(targets, scope, options = {}) {", "async inspectCodeSyncTarget(", "syncCodeTargets");
assert.match(syncSlice, /机器状态映射未知或代码清单覆盖状态路径，未上传/, "the executed slice must contain the gate loop");
assert.match(guardSlice, /ProjectRootMap_1\.remoteRootsEqual/, "the guard must bind the real root-comparison export");
assert.doesNotMatch(guardSlice, /[^.\w]remotePathKey\s*\(/,
  "the guard must never call the unbound remotePathKey again (the original defect)");
// R31: the gate loop consumes ONLY this operation's frozen map — the old
// shared-cache fallback `guards.get(target) || targetRootGuard(target)` is
// forbidden, and a missing map key must be a hard error, never a continue.
assert.doesNotMatch(syncSlice, /guards\.get\([^)]*\)\s*\|\|/,
  "the gate must never fall back to the live shared cache when the frozen map yields nothing");
assert.match(syncSlice, /缺少本次同步的机器状态绑定快照/,
  "a missing frozen-snapshot entry must fail closed explicitly");
// R41: the probe receipt is accepted only on an explicit ok status, checked
// separately BEFORE any frozen guard or cache registration.
assert.match(guardSlice, /probe\?\.status !== "ok"/,
  "the preparation path must verify an explicit ok receipt before accepting the guard or the cache");

function moduleFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(distSource);
  assert.ok(match, `compiled module function ${name} not found`);
  const end = distSource.indexOf("\n}", match.index);
  assert.ok(end > match.index, `compiled module function ${name}: end not found`);
  return distSource.slice(match.index, end + 2);
}
const moduleFunctions = ["remoteProjectName", "normalizeRemoteWorkRoot", "normalizeAgentProjectRoot",
  "enforceExpectedAgentProjectRoot", "errorMessage", "fingerprintFromManifest"]
  .map(moduleFunction).join("\n");
const readyStatusLine = /^const ENDPOINT_READY_PROBE_STATUSES = .*$/m.exec(distSource)[0];
// r49 迁类：UiCommandCancelled 已由 core 共享模块提供，编译产物改经 UiCommandCancelled_1 命名空间
// （下方 legacyNamespaces 正则按编译清单自动注入真实模块）。裸标识符仅是同一真实类的别名。
const uiCancelledModule = require("../../dist/core/UiCommandCancelled.js");
assert.ok(typeof uiCancelledModule.UiCommandCancelled === "function"
  && new uiCancelledModule.UiCommandCancelled("x").code === "USER_CANCELLED", "real UiCommandCancelled class not found");
const uiCancelledClass = "const UiCommandCancelled = UiCommandCancelled_1.UiCommandCancelled;";

// Real module namespaces exactly as the compiled module requires them (both
// plain require and __importStar shapes; vscode resolves to {} and is stubbed).
const legacyRequire = id => {
  try { return require(require.resolve(id, { paths: [path.join(__dirname, "../../dist/extension")] })); }
  catch { return {}; }
};
const legacyNamespaces = {};
for (const match of distSource.matchAll(/^(?:const|var) ([A-Za-z_$][\w$]*) = (?:__importStar\()?require\("([^"]+)"\)\)?;$/gm)) {
  legacyNamespaces[match[1]] = legacyRequire(match[2]);
}

const VIRTUAL_ROOT = "/virtual/MultiModal"; // basename == remote project name
const CODE_ROOT = "/srv/work/MultiModal";
const TOKEN = "fixture-token";

// H03-shaped live Agent observation (field shapes proven by host evidence
// H03; fixture paths only): exact tunnel id, protocol 1, state roots OUTSIDE
// the code root, transport fields recorded.
const h03Probe = overrides => ({ status: "ok", tcpOpen: true, healthOk: true, capabilitiesOk: true,
  projectRoot: CODE_ROOT, localForwardHost: "localhost", remoteAgentHost: "localhost",
  localForwardPort: 18767, remoteTelemetryPort: 18765, workerId: "nwpu3", gpuCollectorProtocol: 1,
  agentStateDir: "/srv/work/simple_agent/state/projects/MultiModal.fixture",
  workerStateDir: "/home/u/.simple-cluster/worker-state",
  message: "Worker Telemetry API 可用。", ...overrides });
// The verified legacy cached shape (recorded before transport/state fields
// existed): hosts/workerId/state dirs/protocol absent — must NEVER bind.
const legacyProbe = () => ({ status: "ok", tcpOpen: true, healthOk: true, capabilitiesOk: true,
  projectRoot: CODE_ROOT, localForwardPort: 18767, remoteTelemetryPort: 18765,
  message: "Worker Telemetry API 可用。" });

const DEFAULT_TUNNELS = () => [{ id: "nwpu3", enabled: true, agentProjectDir: "/srv/work",
  localForwardHost: "localhost", localForwardPort: 18767, remoteAgentHost: "localhost",
  remoteAgentPort: 18765, remoteTelemetryPort: 18765,
  agentInstallDir: null, agentStateDir: null, workerStateDir: null }];
// Base-level tunnel fields deliberately DIFFER from the worker row: effective
// values must follow the worker row / frozen target, never the base (E14a).
const BASE_CONFIG = () => ({ localForwardHost: "10.0.0.1", remoteAgentHost: "10.0.0.1", localForwardPort: 18765, remoteAgentPort: 18765 });
const SIMPLE_MANIFEST = () => ({ "train.py": { size: 2, sha256: "a" },
  "experiments/plans/comparison/tmdc.yaml": { size: 4, sha256: "b" } });

function makeHost({ probes, tunnels, manifest, base, targetOverrides, probeImpl, afterBuild }) {
  const rootState = { root: VIRTUAL_ROOT };
  const calls = [];   // GET probe calls: config + options, in order
  const writes = { sentinel: 0, confirms: 0 };
  const sandbox = {
    ...legacyNamespaces,
    console, path, os, process, crypto: require("node:crypto"),
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    require: legacyRequire,
    workspaceRoot: () => rootState.root,
    vscode: { workspace: { getConfiguration: () => ({ get: (_key, dflt) => dflt }) }, Uri: { file: p => ({ fsPath: p }) } },
    // LOCAL fixture stub: the manifest reader walks a real workspace; the test
    // root is virtual. Same shape as the real function: the manifest record
    // itself with stats attached. NOT a network or gate component.
    buildLocalCodeManifest: async () => {
      const built = Object.assign({}, manifest || SIMPLE_MANIFEST(),
        { stats: { listed: Object.keys(manifest || SIMPLE_MANIFEST()).length, reused: 0, hashed: 0 } });
      if (afterBuild) afterBuild();
      return built;
    },
  };
  // Network boundary stub: replaces ONLY the GET kernel inside the namespace
  // copy used by this operation; records every call's config and options.
  sandbox.XshellTunnelPortProbe_1 = Object.assign({}, legacyNamespaces.XshellTunnelPortProbe_1, {
    probeWorkerTelemetryTunnel: async (config, options) => {
      calls.push({ config: { ...config }, options: { ...(options || {}) } });
      // probeImpl may return a specific observation (returned as-is), throw,
      // or return undefined (default H03-shaped healthy Agent observation).
      const injected = probeImpl ? await probeImpl(calls.length, { rootState, calls }) : undefined;
      return injected === undefined ? { ...h03Probe() } : injected;
    },
  });
  vm.runInNewContext(
    readyStatusLine + ";" + uiCancelledClass + ";" + moduleFunctions +
    ";class _Host {" + [runtimeDirsSlice, expectedRootSlice, localGuardSlice, guardSlice, stampSlice,
      boundedSlice, manifestKeySlice, syncSlice].join("\n") + "}" +
    "\nglobalThis.HostProto = _Host.prototype;",
    sandbox, { filename: "legacy-excerpt.js" });
  const host = {
    setupConfig: Object.assign({ workerTunnels: tunnels || DEFAULT_TUNNELS() }, base || BASE_CONFIG()),
    tunnelConfig: { token: TOKEN },
    lastWorkerProbes: probes,
    context: { globalStorageUri: { fsPath: os.tmpdir() } },
    client: { id: "client-a" },
    projectContextGeneration: 7,
    workerProbeSignatures: new Map(), workerProbeGenerations: new Map(),
    syncScopeMutationInFlight: false, codeSyncInFlight: 0,
    distributedQueueTickPromise: undefined, pendingPlanSubmissionManifest: undefined,
    lastCodeSyncState: { workerVersions: {} },
    // Extension boundary (host command), never a gate decision.
    ensureSftpManagerCommand: async () => {},
    persistProjectCodeSyncState: async () => {}, postState: () => {},
    localCodeManifestCacheFile: () => undefined,
    // Post-gate WRITE sentinels: reaching either proves the gate let the
    // endpoint through; nothing beyond them is executed.
    safeWorkerCodeSyncTargets: async () => { writes.sentinel += 1; throw new Error("SENTINEL-PASSED-GUARD"); },
    confirmRemoteWriteTargets: async () => { writes.confirms += 1; },
  };
  const proto = sandbox.HostProto;
  for (const name of Object.getOwnPropertyNames(proto))
    if (name !== "constructor" && !(name in host)) host[name] = proto[name].bind(host);
  const target = Object.assign({ id: "nwpu3", role: "worker", label: "nwpu3", remotePath: CODE_ROOT,
    localForwardHost: "localhost", localForwardPort: 18767, remoteAgentPort: 18765,
    agentInstallDir: null, agentStateDir: null, workerStateDir: null }, targetOverrides || {});
  const run = () => host.syncCodeTargets([target], "plan-check", { hashCompare: true });
  return { host, target, run, calls, writes, rootState };
}

// outcome: { blocked, note: "sentinel"|"returned", error }
async function outcomeFor(options) {
  const fixture = makeHost(options);
  try {
    await fixture.run();
    return { blocked: false, note: "returned", fixture };
  } catch (error) {
    if (error.message === "SENTINEL-PASSED-GUARD") return { blocked: false, note: "sentinel", fixture };
    return { blocked: true, error, fixture };
  }
}
const GATE_RE = /机器状态映射未知或代码清单覆盖状态路径，未上传/;
const FENCE_RE = /未写入|已切换|已变化/;

test("legacy cached probe (unrecorded transport fields) is re-probed exactly ONCE and then passes", async () => {
  const { blocked, note, fixture } = await outcomeFor({ probes: { nwpu3: legacyProbe() } });
  assert.equal(blocked, false, "healthy endpoint must pass after one read-only refresh");
  assert.equal(note, "sentinel");
  assert.equal(fixture.calls.length, 1, "exactly one bounded GET probe per affected endpoint (no retry)");
  assert.equal(fixture.calls[0].options.timeoutMs, 8000);
  assert.deepEqual(fixture.calls[0].config, { localForwardHost: "localhost", localForwardPort: 18767,
    remoteAgentHost: "localhost", remoteAgentPort: 18765, realtimeEnabled: true, token: TOKEN },
  "probe config must be assembled from the worker row / frozen target, with the token via the existing header path");
  assert.equal(fixture.writes.sentinel, 1);
  assert.equal(fixture.writes.confirms, 0, "no remote write confirmation before the gate + manifest path completes");
  // The successful observation is registered only after all fences passed.
  assert.equal(fixture.host.lastWorkerProbes.nwpu3.workerId, "nwpu3");
  assert.ok(fixture.host.lastWorkerProbes.nwpu3.statusGeneration >= 1, "registration goes through stampWorkerProbeGeneration");
  const guard = fixture.host.targetRootGuard(fixture.target);
  assert.ok(guard && guard.unknown === false && guard.prefixes.length === 0, "guard now resolves with state roots outside the code root");
});

test("legacy probe plus a FAILED read-only probe stays blocked, writes nothing, caches nothing", async () => {
  const before = { nwpu3: legacyProbe() };
  const { blocked, error, fixture } = await outcomeFor({ probes: before, probeImpl: async () => {
    return { status: "timeout", message: "连接超时" };
  } });
  assert.equal(blocked, true);
  assert.match(error.message, GATE_RE);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.writes.sentinel, 0);
  assert.deepEqual(fixture.host.lastWorkerProbes.nwpu3, before.nwpu3, "a failed probe must not enter the cache");
});

test("legacy probe whose probe THROWS stays blocked with an explicit target/stage failure and caches nothing", async () => {
  const { blocked, error, fixture } = await outcomeFor({ probes: { nwpu3: legacyProbe() },
    probeImpl: async () => { throw new Error("socket hang up"); } });
  assert.equal(blocked, true);
  // The vm realm makes the host-realm Error fail `instanceof Error`, so the
  // production errorMessage() falls back to String(error) ("Error: …") here;
  // both spellings keep the endpoint id and the stage.
  assert.match(error.message, /^nwpu3 机器状态映射只读复核失败：(Error: )?socket hang up，未上传。$/,
    "the failure keeps the endpoint id and stage, is not dressed up as a pass, and aborts the operation");
  assert.equal(fixture.calls.length, 1, "no automatic retry");
  assert.equal(fixture.writes.sentinel, 0);
  assert.equal(fixture.host.lastWorkerProbes.nwpu3.status, "ok");
});

test("complete matching cached probe passes WITHOUT any new probe", async () => {
  const { blocked, note, fixture } = await outcomeFor({ probes: { nwpu3: h03Probe() } });
  assert.equal(blocked, false);
  assert.equal(note, "sentinel");
  assert.equal(fixture.calls.length, 0, "a bound, resolved guard must not trigger network");
});

test("worker-level host/port is used for the probe even when base config differs", async () => {
  const tunnels = DEFAULT_TUNNELS();
  tunnels[0].localForwardHost = "127.0.0.9";
  tunnels[0].localForwardPort = 23001;
  tunnels[0].remoteAgentHost = "127.0.0.9";
  tunnels[0].remoteAgentPort = 23002;
  tunnels[0].remoteTelemetryPort = 23002;
  const { blocked, fixture } = await outcomeFor({
    probes: { nwpu3: legacyProbe() }, tunnels,
    // Frozen target without transport fields: the worker row must supply them.
    targetOverrides: { localForwardHost: undefined, localForwardPort: undefined, remoteAgentPort: undefined },
    probeImpl: async () => { return { ...h03Probe({ localForwardHost: "127.0.0.9", remoteAgentHost: "127.0.0.9",
      localForwardPort: 23001, remoteTelemetryPort: 23002 }) }; },
  });
  assert.equal(blocked, false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].config.localForwardHost, "127.0.0.9", "never the base-level 10.0.0.1 (E14a)");
  assert.equal(fixture.calls[0].config.localForwardPort, 23001);
  assert.equal(fixture.calls[0].config.remoteAgentHost, "127.0.0.9");
  assert.equal(fixture.calls[0].config.remoteAgentPort, 23002);
});

test("RECORDED foreign host/port/project/id never pass directly; a failed refresh still blocks", async () => {
  const variants = [
    ["recorded foreign localForwardHost", { localForwardHost: "10.0.0.9" }],
    ["recorded foreign remoteAgentHost", { remoteAgentHost: "evil.example" }],
    ["recorded mismatched localForwardPort", { localForwardPort: 19999 }],
    ["recorded mismatched remoteTelemetryPort", { remoteTelemetryPort: 28765 }],
    ["recorded foreign workerId", { workerId: "other-node" }],
    ["recorded case-variant worker id is NOT equal", { workerId: "NWPU3" }],
    ["recorded foreign projectRoot", { projectRoot: "/srv/other-project" }],
    ["recorded uncanonicalizable projectRoot", { projectRoot: "relative/root" }],
  ];
  for (const [label, overrides] of variants) {
    const fixtureView = makeHost({ probes: { nwpu3: h03Probe(overrides) },
      probeImpl: async () => { return { status: "timeout", message: "不可达" }; } });
    assert.equal(fixtureView.host.targetRootGuard(fixtureView.target).unknown, true, label);
    const { blocked, error, fixture } = await outcomeFor({ probes: { nwpu3: h03Probe(overrides) },
      probeImpl: async () => { return { status: "timeout", message: "不可达" }; } });
    assert.equal(blocked, true, label + " must stay blocked");
    assert.match(error.message, GATE_RE, label);
    assert.equal(fixture.writes.sentinel, 0, label + " must not reach writes");
  }
});

test("a refresh that still reports the wrong project fails closed (enforce runs on the captured code root)", async () => {
  const { blocked, error, fixture } = await outcomeFor({ probes: { nwpu3: legacyProbe() },
    probeImpl: async () => { return { ...h03Probe({ projectRoot: "/srv/other-project" }) }; } });
  assert.equal(blocked, true);
  assert.match(error.message, /只读复核.*agent_project_mismatch|agent_project_mismatch.*只读复核|机器状态映射未知/);
  assert.equal(fixture.writes.sentinel, 0);
  assert.equal(fixture.host.lastWorkerProbes.nwpu3.status, "ok", "mismatched observation must not overwrite the cache");
});

test("Agent-contract default id 'worker' binds only under full transport binding; other ids compare exactly", async () => {
  const asDefault = await outcomeFor({ probes: { nwpu3: legacyProbe() },
    probeImpl: async () => { return { ...h03Probe({ workerId: "worker" }) }; } });
  assert.equal(asDefault.blocked, false, "default literal 'worker' + full binding is the Agent contract (H03 shows real id 'nwpu3'; 'worker' stays compatible)");
  assert.equal(asDefault.fixture.calls.length, 1);
  const boundCache = await outcomeFor({ probes: { nwpu3: h03Probe({ workerId: "worker" }) } });
  assert.equal(boundCache.blocked, false, "a cached fully-bound default-id probe needs no refresh");
  assert.equal(boundCache.fixture.calls.length, 0);
  // A cached probe with default id but MISSING transport fields never binds.
  const partialDefault = makeHost({ probes: { nwpu3: legacyProbe() },
    probeImpl: async () => { throw new Error("offline"); } });
  assert.equal(partialDefault.host.targetRootGuard(partialDefault.target).unknown, true);
  // A NON-default id must equal the endpoint id exactly — case-sensitive.
  const wrongCase = await outcomeFor({ probes: { nwpu3: legacyProbe() },
    probeImpl: async () => { return { ...h03Probe({ workerId: "NWPU3" }) }; } });
  assert.equal(wrongCase.blocked, true, "non-default ids compare exactly; a case variant never binds");
  assert.equal(wrongCase.fixture.writes.sentinel, 0);
});

test("protocol-1 observation without either state root reports unknown and blocks", async () => {
  const guardView = makeHost({ probes: {}, probeImpl: async () => { throw new Error("unused"); } });
  assert.equal(guardView.host.targetRootGuard(guardView.target, h03Probe({ workerStateDir: "", agentStateDir: "" })).unknown, true);
  const outcome = await outcomeFor({ probes: { nwpu3: legacyProbe() },
    probeImpl: async () => { return { ...h03Probe({ workerStateDir: "", agentStateDir: "" }) }; } });
  assert.equal(outcome.blocked, true);
  assert.match(outcome.error.message, GATE_RE);
  assert.equal(outcome.fixture.writes.sentinel, 0);
});

test("config, endpoint, project, client, generation or token change during the probe cancels without caching or writing", async () => {
  const disruptions = {
    project: f => { f.rootState.root = "/virtual/OtherProject"; },
    disabled: f => { f.host.setupConfig.workerTunnels[0].enabled = false; },
    removed: f => { f.host.setupConfig.workerTunnels.length = 0; },
    port: f => { f.host.setupConfig.workerTunnels[0].localForwardPort = 29999; },
    token: f => { f.host.tunnelConfig.token = "rotated"; },
    client: f => { f.host.client = { id: "client-b" }; },
    generation: f => { f.host.projectContextGeneration += 1; },
    inPlaceTarget: f => { f.target.remotePath = "/srv/elsewhere"; },
  };
  for (const [label, disrupt] of Object.entries(disruptions)) {
    const fixture = makeHost({ probes: { nwpu3: legacyProbe() },
      probeImpl: async () => { disrupt(fixture); return { ...h03Probe() }; } });
    let blocked = false, error;
    try {
      await fixture.run();
    } catch (thrown) {
      // R32: NO escape hatch here. Reaching the write sentinel means the
      // binding fence was bypassed mid-flight — that is a hard failure, never
      // a "continue" that would silently skip the safety assertions below.
      if (thrown.message === "SENTINEL-PASSED-GUARD")
        throw new Error(`${label}: a mid-flight change must cancel BEFORE any write, but the write sentinel was reached — the binding fence was bypassed`);
      blocked = true; error = thrown;
    }
    assert.equal(blocked, true, `${label}: a mid-flight change must cancel (the run completed silently instead)`);
    assert.match(error.message, FENCE_RE, `${label}: fence error`);
    assert.equal(fixture.writes.sentinel, 0, `${label}: nothing may be written`);
    assert.equal(fixture.host.lastWorkerProbes.nwpu3.status, "ok", `${label}: cancelled observation must not be cached`);
  }
});

test("a background cache downgrade after the frozen snapshot cannot rewrite the validated guard", async () => {
  const holder = {};
  const fixture = makeHost({ probes: { nwpu3: h03Probe() },
    // Between the frozen guard snapshot and the gate loop, a background 1.5s
    // refresh merges a timeout entry into the shared cache.
    afterBuild: () => { holder.fixture.host.lastWorkerProbes = { nwpu3: { status: "timeout", message: "background merge" } }; },
  });
  holder.fixture = fixture;
  let blocked = false, note = "returned";
  try {
    await fixture.run();
  } catch (thrown) {
    if (thrown.message === "SENTINEL-PASSED-GUARD") note = "sentinel";
    else blocked = true;
  }
  assert.equal(blocked, false, "the frozen snapshot must govern the gate, not the downgraded cache");
  assert.equal(note, "sentinel");
  assert.equal(fixture.calls.length, 0);
});

test("nested state roots keep blocking files and ancestors while siblings keep syncing; no probe needed", async () => {
  const nestedManifest = { ...SIMPLE_MANIFEST(), "run/state/collector.py": { size: 1, sha256: "c" } };
  const boundNested = { ...h03Probe(), agentStateDir: `${CODE_ROOT}/.agent/state`, workerStateDir: `${CODE_ROOT}/run/state` };
  const nested = await outcomeFor({ probes: { nwpu3: boundNested }, manifest: nestedManifest });
  assert.equal(nested.blocked, true, "a manifest covering the mapped state tree stays blocked");
  assert.equal(nested.fixture.calls.length, 0, "resolved guards never trigger the refresh path");
  const ancestor = await outcomeFor({ probes: { nwpu3: boundNested }, manifest: { "run": { size: 1, sha256: "d" } } });
  assert.equal(ancestor.blocked, true, "an ancestor directory of the state root is still protected");
  const sibling = await outcomeFor({ probes: { nwpu3: boundNested }, manifest: { "run/train.py": { size: 1, sha256: "e" } } });
  assert.equal(sibling.blocked, false, "sibling research code under run/ keeps syncing");
  assert.equal(sibling.fixture.writes.sentinel, 1);
});

test("explicit configured workerStateDir resolves the mapping without any network requirement", async () => {
  const tunnels = DEFAULT_TUNNELS();
  tunnels[0].workerStateDir = "/srv/data/nwpu3-state";
  const outcome = await outcomeFor({ probes: {}, tunnels,
    probeImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.fixture.calls.length, 0, "explicit legal config stays resolved — no new network requirement");
  assert.equal(outcome.fixture.host.targetRootGuard(outcome.fixture.target).unknown, false);
});

test("another endpoint's cached probe never rescues this endpoint; refresh targets this endpoint's own address", async () => {
  const outcome = await outcomeFor({ probes: { other: h03Probe() },
    probeImpl: async () => { return { status: "timeout", message: "不可达" }; } });
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.fixture.calls.length, 1);
  assert.equal(outcome.fixture.calls[0].config.localForwardHost, "localhost");
  assert.equal(outcome.fixture.calls[0].config.localForwardPort, 18767);
});

test("the submission manifest key stays independent of probe observations (no duplicate-submission coupling)", () => {
  const a = makeHost({ probes: {} });
  const key1 = a.host.planSubmissionManifestKey("/some/root", ["a"], undefined, []);
  const key2 = a.host.planSubmissionManifestKey("/some/root", ["a"], undefined, []);
  const changed = a.host.planSubmissionManifestKey("/some/root", ["b"], undefined, []);
  assert.equal(key1, key2);
  assert.notEqual(key1, changed);
});

// ---------- r4 (plan r3 R31/R32/R33) ----------

// R31: fully-bound cached probes resolve with ZERO GETs, yet their bindings
// are snapshotted and fenced: a Worker-row/target change during the later
// awaits (between preparation and confirm/write) must cancel, not pass.
test("R31: a fully-bound cached target does zero GETs but its binding is still fenced mid-await", async () => {
  const disruptions = {
    workerPort: f => { f.host.setupConfig.workerTunnels[0].localForwardPort = 29301; },
    workerDisabled: f => { f.host.setupConfig.workerTunnels[0].enabled = false; },
    workerRemoved: f => { f.host.setupConfig.workerTunnels.length = 0; },
    targetInPlace: f => { f.target.remotePath = "/srv/elsewhere"; },
    // R41: the sync-target row's enabled field is fenced explicitly — a
    // mid-flight disable must cancel, never freeze-and-continue.
    targetDisabled: f => { f.target.enabled = false; },
  };
  for (const [label, disrupt] of Object.entries(disruptions)) {
    const fixture = makeHost({ probes: { nwpu3: h03Probe() }, afterBuild: () => disrupt(fixture) });
    let blocked = false, error;
    try {
      await fixture.run();
    } catch (thrown) {
      if (thrown.message === "SENTINEL-PASSED-GUARD")
        throw new Error(`${label}: resolved-target change must cancel BEFORE any write; the write sentinel proves the fence was bypassed`);
      blocked = true; error = thrown;
    }
    assert.equal(blocked, true, `${label}: the run completed silently instead of cancelling`);
    assert.match(error.message, FENCE_RE, `${label}: fence error`);
    assert.equal(fixture.calls.length, 0, `${label}: resolved targets never probe`);
    assert.equal(fixture.writes.sentinel, 0, `${label}: nothing may be written`);
  }
});

test("R31: an explicit-config resolved target does zero GETs but a state-config change mid-await cancels", async () => {
  const tunnels = DEFAULT_TUNNELS();
  tunnels[0].workerStateDir = "/srv/data/nwpu3-state";
  const fixture = makeHost({ probes: {}, tunnels,
    afterBuild: () => { fixture.host.setupConfig.workerTunnels[0].workerStateDir = "/srv/data/other-state"; } });
  let blocked = false, error;
  try {
    await fixture.run();
  } catch (thrown) {
    if (thrown.message === "SENTINEL-PASSED-GUARD")
      throw new Error("explicit-config change must cancel BEFORE any write; the write sentinel proves the fence was bypassed");
    blocked = true; error = thrown;
  }
  assert.equal(blocked, true);
  assert.match(error.message, FENCE_RE);
  assert.equal(fixture.calls.length, 0, "explicit legal config keeps zero network requirements");
  assert.equal(fixture.writes.sentinel, 0);
});

// R31 mixed batch: one fully-bound target + one legacy-cache target.
test("R31: mixed batch probes the unresolved target exactly ONCE and fences BOTH bindings", async () => {
  const tunnels = DEFAULT_TUNNELS();
  tunnels.push({ id: "w2", enabled: true, agentProjectDir: "/srv/work2",
    localForwardHost: "localhost", localForwardPort: 25001, remoteAgentHost: "localhost",
    remoteAgentPort: 25002, remoteTelemetryPort: 25002,
    agentInstallDir: null, agentStateDir: null, workerStateDir: null });
  const w2Probe = () => ({ status: "ok", tcpOpen: true, healthOk: true, capabilitiesOk: true,
    projectRoot: "/srv/work2/w2", localForwardPort: 25001, remoteTelemetryPort: 25002,
    message: "Worker Telemetry API 可用。" });
  const w2Bound = { status: "ok", tcpOpen: true, healthOk: true, capabilitiesOk: true,
    projectRoot: "/srv/work2/w2", localForwardHost: "localhost", remoteAgentHost: "localhost",
    localForwardPort: 25001, remoteTelemetryPort: 25002, workerId: "w2", gpuCollectorProtocol: 1,
    agentStateDir: "/srv/work2/simple_agent/state/projects/w2.fixture",
    workerStateDir: "/home/u/.simple-cluster/worker-state-w2",
    message: "Worker Telemetry API 可用。" };
  const t2 = { id: "w2", role: "worker", label: "w2", remotePath: "/srv/work2/w2",
    localForwardHost: "localhost", localForwardPort: 25001, remoteAgentPort: 25002,
    agentInstallDir: null, agentStateDir: null, workerStateDir: null };
  // (a) happy mixed run: zero GETs for nwpu3, exactly one GET for w2.
  const ok = makeHost({ probes: { nwpu3: h03Probe(), w2: w2Probe() }, tunnels,
    probeImpl: async () => { return { ...w2Bound }; } });
  let okError, okNote = "returned";
  try { await ok.host.syncCodeTargets([ok.target, t2], "plan-check", { hashCompare: true }); }
  catch (thrown) { okNote = thrown.message === "SENTINEL-PASSED-GUARD" ? "sentinel" : "blocked"; okError = thrown; }
  assert.equal(okNote, "sentinel", `mixed batch must pass both targets: ${okError && okError.message}`);
  assert.equal(ok.calls.length, 1, "only the unresolved target is probed, exactly once");
  assert.equal(ok.calls[0].config.localForwardPort, 25001, "the probe targets w2's own address");
  assert.equal(ok.host.lastWorkerProbes.w2.workerId, "w2", "w2's observation registers after all fences");
  // (b) the RESOLVED target's row changes while w2 is being probed -> cancel, w2's observation must not be cached.
  const mid = makeHost({ probes: { nwpu3: h03Probe(), w2: w2Probe() }, tunnels,
    probeImpl: async () => { mid.host.setupConfig.workerTunnels[0].localForwardPort = 29401; return { ...w2Bound }; } });
  let midError;
  try { await mid.host.syncCodeTargets([mid.target, t2], "plan-check", { hashCompare: true }); }
  catch (thrown) { midError = thrown; }
  assert.ok(midError, "resolved-target change during another target's probe-await must cancel");
  if (midError.message === "SENTINEL-PASSED-GUARD")
    throw new Error("resolved-target change must cancel BEFORE any write; the write sentinel proves the fence was bypassed");
  assert.match(midError.message, FENCE_RE);
  assert.equal(mid.writes.sentinel, 0);
  assert.equal(mid.calls.length, 1, "the cancel happens on the batch fence; no extra probe was attempted");
  // w2's own registration semantics are deliberately NOT asserted here: w2's
  // own fences passed (per-target registration inside prepare); what R31
  // requires of this batch is cancel-before-write with zero remote effects.
});

test("R31: a target whose Worker config is missing or disabled is rejected up-front, before any probe", async () => {
  const missing = await outcomeFor({ probes: {}, tunnels: [],
    probeImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(missing.blocked, true);
  assert.match(missing.error.message, /缺少启用中的 Worker 端点配置/);
  assert.equal(missing.fixture.calls.length, 0, "missing config never reaches the network");
  assert.equal(missing.fixture.writes.sentinel, 0);
  const disabledTunnels = DEFAULT_TUNNELS();
  disabledTunnels[0].enabled = false;
  const disabled = await outcomeFor({ probes: { nwpu3: h03Probe() }, tunnels: disabledTunnels,
    probeImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(disabled.blocked, true);
  assert.match(disabled.error.message, /缺少启用中的 Worker 端点配置/);
  assert.equal(disabled.fixture.calls.length, 0);
  assert.equal(disabled.fixture.writes.sentinel, 0);
});

test("R31: a frozen-map miss fails closed — no shared-cache fallback, no silent continue", async () => {
  // With a fully-bound cached probe the OLD code (`guards.get(target) ||
  // targetRootGuard(target)`) would re-read the live cache and REACH THE
  // WRITE SENTINEL. The frozen map is now the only admissible source.
  const f = makeHost({ probes: { nwpu3: h03Probe() } });
  f.host.prepareCodeSyncRootGuards = async () => ({ guards: new Map(), assertBindingsCurrent: () => { } });
  let error, note = "returned";
  try { await f.run(); }
  catch (thrown) { note = thrown.message === "SENTINEL-PASSED-GUARD" ? "sentinel" : "blocked"; error = thrown; }
  assert.equal(note, "blocked", "a missing snapshot key must never fall back to the live cache nor continue");
  assert.match(error.message, /缺少本次同步的机器状态绑定快照/);
  assert.equal(f.writes.sentinel, 0);
});

// R33: declared-but-invalid ports reject the endpoint instead of stepping
// down a layer; only UNDECLARED fields step; default applies to nobody-declares.
test("R33: port selection matrix — integers 1..65535, declared-invalid rejects, undeclared steps down", () => {
  const rowOver = patch => { const rows = DEFAULT_TUNNELS(); Object.assign(rows[0], patch); return rows; };
  const CLEAR_TARGET = { localForwardPort: undefined, remoteAgentPort: undefined };
  const NO_BASE_PORTS = { localForwardHost: "10.0.0.1", remoteAgentHost: "10.0.0.1",
    localForwardPort: undefined, remoteAgentPort: undefined, remoteTelemetryPort: undefined };
  const configOf = ({ tunnelPatch, base, targetPatch }) => {
    const f = makeHost({ probes: {}, tunnels: rowOver(tunnelPatch || {}),
      base: base || BASE_CONFIG(), targetOverrides: targetPatch || {} });
    return f.host.codeSyncRootProbeConfig(f.target);
  };
  // worker row declares valid values (target cleared) -> worker wins over base.
  assert.equal(configOf({ tunnelPatch: { localForwardPort: 24001 }, targetPatch: CLEAR_TARGET }).localForwardPort, 24001);
  // worker undeclared -> base wins.
  assert.equal(configOf({ tunnelPatch: { localForwardPort: undefined },
    base: Object.assign({}, BASE_CONFIG(), { localForwardPort: 24002 }), targetPatch: CLEAR_TARGET }).localForwardPort, 24002);
  // nobody declares -> default 18765.
  assert.equal(configOf({ tunnelPatch: { localForwardPort: undefined, remoteTelemetryPort: undefined, remoteAgentPort: undefined },
    base: NO_BASE_PORTS, targetPatch: CLEAR_TARGET }).localForwardPort, 18765);
  // valid integer strings are declared values.
  assert.equal(configOf({ tunnelPatch: { localForwardPort: "24003" }, targetPatch: CLEAR_TARGET }).localForwardPort, 24003);
  // DECLARED-INVALID at any layer -> whole endpoint config rejected (no step-down).
  for (const bad of [0, -1, 70000, "18765.5", 18765.5, "abc"]) {
    assert.equal(configOf({ tunnelPatch: { localForwardPort: bad }, targetPatch: CLEAR_TARGET }), null,
      `worker-declared invalid localForwardPort ${JSON.stringify(bad)} must reject, never fall back to base/default`);
    assert.equal(configOf({ targetPatch: Object.assign({}, CLEAR_TARGET, { localForwardPort: bad }) }), null,
      `target-declared invalid localForwardPort ${JSON.stringify(bad)} must reject, never fall back to the worker row`);
    assert.equal(configOf({ tunnelPatch: { remoteTelemetryPort: bad }, targetPatch: CLEAR_TARGET }), null,
      `worker-declared invalid remoteTelemetryPort ${JSON.stringify(bad)} must reject (telemetry wins over remoteAgentPort, no step-down)`);
  }
  // declared 0 must not slip to the SAME worker row's remoteAgentPort layer either.
  assert.equal(configOf({ tunnelPatch: { remoteTelemetryPort: 0, remoteAgentPort: 25002 }, targetPatch: CLEAR_TARGET }), null);
});

test("R33: a worker-declared port 0 blocks end-to-end with zero GETs (never probes the base 18765/18767)", async () => {
  const tunnels = DEFAULT_TUNNELS();
  tunnels[0].localForwardPort = 0;
  const outcome = await outcomeFor({ probes: { nwpu3: legacyProbe() }, tunnels,
    targetOverrides: { localForwardPort: undefined },
    probeImpl: async () => { throw new Error("must not probe an invalid endpoint"); } });
  assert.equal(outcome.blocked, true);
  assert.match(outcome.error.message, /机器状态映射未知（端点配置无效或已移除\/禁用）/);
  assert.equal(outcome.fixture.calls.length, 0, "no GET to the base address may be attempted");
  assert.equal(outcome.fixture.writes.sentinel, 0);
});

// ---------- r5 (plan r4 R41) ----------

// R41-2: an explicit legal state-root mapping must NOT exempt the endpoint
// from the effective-config validity check — a declared-invalid port rejects
// up-front with zero GETs and never touches the write sentinel.
test("R41: explicit workerStateDir plus a declared-invalid port rejects up-front with zero GETs", async () => {
  for (const bad of [0, "18765.5", 70000]) {
    for (const layer of ["target", "worker"]) {
      const tunnels = DEFAULT_TUNNELS();
      tunnels[0].workerStateDir = "/srv/data/nwpu3-state";
      const targetOverrides = layer === "target" ? { localForwardPort: bad } : { localForwardPort: undefined };
      if (layer === "worker") tunnels[0].localForwardPort = bad;
      const outcome = await outcomeFor({ probes: { nwpu3: h03Probe() }, tunnels, targetOverrides,
        probeImpl: async () => { throw new Error("must not probe an invalid endpoint"); } });
      assert.equal(outcome.blocked, true, `${layer}-declared ${JSON.stringify(bad)} with explicit state root must block`);
      assert.match(outcome.error.message, /机器状态映射未知（端点配置无效或已移除\/禁用）/,
        `${layer}-declared ${JSON.stringify(bad)}: explicit rejection naming the invalid endpoint`);
      assert.equal(outcome.fixture.calls.length, 0, `${layer}-declared ${JSON.stringify(bad)}: zero GETs`);
      assert.equal(outcome.fixture.writes.sentinel, 0, `${layer}-declared ${JSON.stringify(bad)}: no write sentinel`);
    }
  }
  // The valid explicit-state-config path keeps zero GETs and still passes.
  const okTunnels = DEFAULT_TUNNELS();
  okTunnels[0].workerStateDir = "/srv/data/nwpu3-state";
  const ok = await outcomeFor({ probes: {}, tunnels: okTunnels,
    probeImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(ok.blocked, false, "valid explicit config stays resolved with no network requirement");
  assert.equal(ok.fixture.calls.length, 0);
});

// R41-3: only an explicit ok receipt may be accepted into the frozen guard
// and the shared cache; a fully-bound-shaped non-ok answer stays blocked.
test("R41: a non-ok receipt is never accepted into the frozen guard or the cache", async () => {
  const before = legacyProbe();
  for (const receipt of [
    { status: "file_api_unavailable", message: "文件 API 不可用" },
    { status: undefined, message: undefined },
  ]) {
    const outcome = await outcomeFor({ probes: { nwpu3: before },
      probeImpl: async () => { return { ...h03Probe(), ...receipt }; } });
    assert.equal(outcome.blocked, true, `receipt ${JSON.stringify(receipt)} must not pass`);
    assert.match(outcome.error.message, GATE_RE);
    assert.equal(outcome.fixture.calls.length, 1, "one read-only attempt, no retry");
    assert.equal(outcome.fixture.writes.sentinel, 0);
    assert.deepEqual(outcome.fixture.host.lastWorkerProbes.nwpu3, before, "a non-ok receipt never enters the cache");
  }
});

// R41 (ports): a whitespace-only declared port is UNDECLARED (trims to ""),
// never the number 0; a padded valid integer keeps its value.
test("R41: whitespace ports step down as undeclared; padded valid integers keep", () => {
  const rowOver = patch => { const rows = DEFAULT_TUNNELS(); Object.assign(rows[0], patch); return rows; };
  const CLEAR_TARGET = { localForwardPort: undefined, remoteAgentPort: undefined };
  const configOf = ({ tunnelPatch, base, targetPatch }) => {
    const f = makeHost({ probes: {}, tunnels: rowOver(tunnelPatch || {}),
      base: base || BASE_CONFIG(), targetOverrides: targetPatch || {} });
    return f.host.codeSyncRootProbeConfig(f.target);
  };
  assert.equal(configOf({ tunnelPatch: { localForwardPort: "   " },
    base: Object.assign({}, BASE_CONFIG(), { localForwardPort: 24002 }), targetPatch: CLEAR_TARGET }).localForwardPort, 24002,
  "worker-declared whitespace falls to the base layer, never reads as 0");
  assert.equal(configOf({ tunnelPatch: { localForwardPort: " 24003 " }, targetPatch: CLEAR_TARGET }).localForwardPort, 24003,
  "a padded valid integer is a declared valid value");
});

test("R41: a Worker row WITHOUT an enabled field stays legitimate (enabled !== false convention)", async () => {
  const tunnels = DEFAULT_TUNNELS();
  delete tunnels[0].enabled;
  const outcome = await outcomeFor({ probes: { nwpu3: legacyProbe() }, tunnels });
  assert.equal(outcome.blocked, false, "undeclared enabled is legitimate per the project convention");
  assert.equal(outcome.note, "sentinel");
  assert.equal(outcome.fixture.calls.length, 1);
});
