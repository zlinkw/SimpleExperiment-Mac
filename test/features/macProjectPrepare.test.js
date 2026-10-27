const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const manual = require("../../dist/mac/ManualTunnel");
const workflow = require("../../dist/features/ApiWorkflow");
const topology = require("../../dist/features/TopologyMode");
const runtime = require("../../dist/runtime/RuntimeManifest");
const ssh = require("../../dist/tunnel/SshTransportIdentity");
const xshell = require("../../dist/tunnel/XshellTunnelSetup");
const compiled = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
const adapterSource = fs.readFileSync(path.join(__dirname, "../../dist/platform/MacHostAdapter.js"), "utf8");
const endpoint = (id = "worker-a", localForwardPort = 29101) => ({ id, role: id === "hub" ? "hub" : "worker", host: id + ".example.org", user: "scientist", sshPort: 2222,
  localForwardHost: "::1", localForwardPort, remoteAgentHost: "127.0.0.1", remoteAgentPort: 29200, projectParentDir: "/data/研究 " + id,
  condaEnv: "/opt/环境 A", enabled: true });

function method(name, globals) {
  const start = compiled.search(new RegExp("^    (?:async )?" + name + "\\(", "m")); assert.ok(start >= 0, name);
  const tail = compiled.slice(start), end = tail.slice(1).search(/^    (?:async )?[a-zA-Z][a-zA-Z0-9_]*\(/m) + 1;
  assert.ok(end > 0, name);
  return vm.runInNewContext("({" + tail.slice(0, end) + "})", globals)[name];
}

// The frozen Windows shared chain blocks these receipt reasons; the Mac managed
// lifecycle receipt must stay outside this set so preparation is not faked or frozen.
const BLOCKED = new Set(["non_simple_remote_command", "different_simple_agent_session"]);

function fixture(mode = "single_worker", options = {}) {
  const uploads = [], events = [], documents = [], changes = [], calls = [];
  let clock = Date.now();
  class FixtureDate extends Date { static now() { return clock; } }
  let root = "/Users/test/研究 A";
  const points = mode === "single_worker" ? [endpoint()] : mode === "worker_pool" ? [endpoint(), endpoint("worker-b", 29102)] : [endpoint("hub", 29100), endpoint()];
  const provider = { setupConfig: manual.setupFromManualEndpoints(points), tunnelConfig: { token: "" }, localPlanMetadata: { plans: [] }, localOperations: {},
    markLocalOperationsDirty() {}, postState() {},
    context: { extension: { packageJSON: { version: require("../../package.json").version } } }, lastWorkerProbes: {}, apiFlowState: workflow.defaultFlowState(),
    isMacVariant: () => true, refreshLocalPlanMetadata: async () => {}, refreshLocalSshConfig: async () => {},
    projectTopologyAssessment() { return this.apiTopologyAssessmentForConfig(mode); },
    assertTopologyReady() { const value = this.projectTopologyAssessment(); assert.equal(value.valid, true); return value; },
    enabledWorkerConfigs() { return this.setupConfig.workerTunnels.filter(worker => worker.enabled); },
    assertTopologyActualWorkRoots() { this.apiPrepareServerTargets(this.projectTopologyAssessment(), [], undefined); },
    ensureSimpleSftpReadyForSetup: async () => options.sftpReady !== false, ensureSftpManagerCommand: async () => {},
    syncXshellConfigBeforeNetwork: async () => { calls.push({ method: "sync" }); },
    async applySetupDraft(setup) { changes.push("setup"); this.setupConfig = setup; },
    saveTopologyModeFromApi: async () => { changes.push("topology"); },
    async writeSftpManagerServerProfiles(ids) { changes.push("profiles"); return { targetCount: ids.length }; },
    async apiAdvanceFlow(step, patch) { events.push([step, patch]); this.apiFlowState = workflow.advanceFlowStep(this.apiFlowState, step, patch); },
    async testTunnel() { events.push(["probe"]); this.lastProbe = { status: options.disconnected ? "timeout" : "agent_ok" }; this.lastWorkerProbes = Object.fromEntries(this.enabledWorkerConfigs().map(worker => [worker.id, { status: options.disconnected ? "timeout" : "agent_ok" }])); },
    async apiServerTestAll() { events.push(["testAll"]);
      const rows = this.enabledWorkerConfigs().map(worker => ({ serverId: worker.id, status: options.disconnected || options.testFailure ? "timeout" : "ok" }));
      return { ok: rows.every(row => row.status === "ok") && !options.testFailure, rows }; },
    async verifyDeployedAgentRuntime(targets, manifest) { events.push(["verify", targets, manifest]); return { fatal: [], warnings: options.verifyWarning ? ["hash mismatch"] : [] }; },
    ensureRemoteAgentVersionConsistent() { throw Error("preparation must not depend on an already running Agent"); },
    async deployLatestAgentRuntime(showMessage, pathConfirmed, serverIds, defer) {
      calls.push({ method: "deploy", serverIds, pathConfirmed, defer });
      if (options.deployFailure) throw Error("mock 部署失败：runtime 上传未完成");
      return { targets: this.enabledWorkerConfigs(), manifest: { files: {} } }; },
    async startAllXshellConnections(requireConfirm, scheduleAutoTest, ids) { calls.push({ method: "start", ids }); return true; },
    async writeXshellAgentStartupCommands() {
      calls.push({ method: "commands" });
      if (options.blockedCommands) return this.enabledWorkerConfigs().map(worker => ({ id: worker.id, changed: false, skippedReason: "non_simple_remote_command", summary: `${worker.id}: blocked` }));
      // The real MacHostAdapter receipt shape: honest skip, never a fake write, outside the blocked set.
      return this.enabledWorkerConfigs().map(worker => ({ id: worker.id, changed: false, skippedReason: "mac_openssh_managed_lifecycle", summary: `${worker.id}: 受管生命周期` })); },
    agentStartupTargets() { return this.enabledWorkerConfigs().map(worker => ({ id: worker.id, filePath: "", tmuxSessionName: "agent-worker-" + worker.id, command: "python3 cluster_agent.py" })); },
    currentAgentPreparationBlockers() { return []; },
    assertExecutionCondaEnvReady() {}, workerActionTargets() { return this.enabledWorkerConfigs(); },
    agentRuntimeUploadTargets() { return this.enabledWorkerConfigs(); },
    async confirmRemoteWriteTargets() {},
    openWorkspaceFolderForContinuation: async () => {},
  };
  const globals = { ManualTunnel_1: manual, ApiWorkflow_1: workflow, TopologyMode_1: topology, XshellTunnelSetup_1: xshell, RuntimeManifest_1: runtime,
    AgentRuntimeScope_1: require("../../dist/features/AgentRuntimeScope"), SshTransportIdentity_1: ssh,
    // 编译产物按模块命名空间引用取消类型（UiCommandCancelled_1.UiCommandCancelled），沙箱补同一形状。
    UiCommandCancelled_1: { UiCommandCancelled: class extends Error {} },
    crypto, path, fs: fs.promises, __dirname: path.join(__dirname, "../../dist/extension"), console: { log() {}, warn() {} },
    workspaceRoot: () => root, remoteProjectName: () => path.posix.basename(root), assertSingleProjectWorkspace: () => {},
    firstNonEmpty: (...items) => items.find(item => item), normalizeRemoteWorkRoot: value => value, normalizeCondaEnvSetting: value => value || "",
    effectiveWorkerCondaEnv: (worker, fallback) => worker.condaEnv || fallback || "", remoteRootPolicyConfig: () => ({}),
    isCondaEnvAbsolutePathValid: value => value.startsWith("/") && !value.split("/").includes(".."),
    projectOutputGateDiagnostics: () => ({ rows: [] }), enforceExpectedAgentProjectRoot: probe => probe,
    topologyModeLabel: value => value, stringArrayField: (params, key) => params[key] || [], errorMessage: error => error.message,
    confirmationRequired(data) { return Object.assign(Error("CONFIRM_REQUIRED"), { apiCode: 2001, apiData: data }); },
    makeOpId: prefix => prefix + "-mock",
    simpleSftpIntegrationReadiness: () => ({ ready: options.sftpReady !== false }),
    resultError: result => result?.error || "", stringFromRecord: result => result?.error || "",
    AGENT_STARTUP_BLOCKED_SKIP_REASONS: BLOCKED, UiCommandCancelled: class UiCommandCancelled extends Error {},
    tunnelTestCompletion: (setup, probe, health, probes) => ({ ready: !options.disconnected && !options.testFailure, issues: options.disconnected ? ["worker 未就绪"] : [] }),
    Date: FixtureDate, sleep: async milliseconds => { clock += milliseconds; },
    agentStartupWriteConfirmationDetail: targets => "确认准备 " + targets.map(target => target.id).join(","),
    vscode: { ProgressLocation: { Notification: 1 }, commands: { async executeCommand(command, args) {
      uploads.push({ command, args }); return options.uploadFailure ? { ok: false, error: "mock transfer refused" } : options.uploadReceipt || { ok: true };
    } }, workspace: { async openTextDocument(value) { documents.push(value); return value; } }, window: {
      showWarningMessage: async (...args) => { events.push(["confirm", ...args]); if (options.onConfirm) options.onConfirm(provider); return options.cancel ? undefined : "确认准备并启动"; },
      withProgress: async (_options, operation) => operation({ report() {} }), showTextDocument: async () => {}, showInformationMessage: async () => {},
    } } };
  for (const name of ["apiProjectPrepare", "apiMergedSetupConfig", "apiSetupConfigChanged", "apiPrepareTopology", "apiTopologyAssessmentForConfig", "apiPrepareServerTargets",
    "apiMergedWorkerConfigs", "apiPublicTopology", "apiPlanValidate", "apiResolveSelectedPlan", "prepareAgentsForFirstRun",
    "agentRuntimeDirs", "hubActualWorkRootTarget", "workerActualWorkRootTarget", "workerActualWorkRootTargets", "sshTransportIdentity", "sftpServerOptions",
    "prepareSftpTargets", "sftpSharedTargets", "hubCodeSyncTarget", "workerCodeSyncTarget", "assertSshTransportIdentities"]) provider[name] = method(name, globals);
  return { provider, uploads, events, documents, changes, calls, setRoot(value) { root = value; } };
}

test("Mac preview needs no Xshell sessions, uploads or changes, and Hub requests are refused outright", async () => {
  for (const mode of ["single_worker", "worker_pool"]) {
    const f = fixture(mode);
    await assert.rejects(f.provider.apiProjectPrepare({ confirm: false }), error => {
      assert.equal(error.apiCode, 2001); const data = error.apiData;
      assert.equal(data.requires.includes("confirm"), true);
      assert.equal(data.preview.modifications.xshellSessions.length, 0, "Mac endpoints carry no editable saved session paths");
      assert.equal(data.preview.modifications.remoteRuntime.length, mode === "single_worker" ? 1 : 2);
      assert.equal(data.preview.servers[0].host, "worker-a.example.org");
      return true;
    });
    assert.equal(f.uploads.length, 0); assert.equal(f.changes.length, 0); assert.equal(f.events.length, 0);
  }
  const hub = fixture("hub_worker");
  await assert.rejects(hub.provider.apiProjectPrepare({ confirm: false, serverIds: ["hub"] }), /HUB_REMOVED/);
  assert.equal(hub.uploads.length, 0);
});

test("Mac managed-lifecycle receipts proceed while genuine blocked receipts still stop preparation", async () => {
  assert.ok(adapterSource.includes('"mac_openssh_managed_lifecycle"'), "Mac adapter must emit the managed lifecycle receipt");
  assert.ok(!adapterSource.includes("non_simple_remote_command"), "Mac adapter must not fabricate blocked Windows receipts");
  assert.equal(BLOCKED.has("mac_openssh_managed_lifecycle"), false);
  const f = fixture("single_worker");
  const result = await f.provider.apiProjectPrepare({ confirm: true });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map(call => call.method), ["commands", "deploy"]);
  const blocked = fixture("single_worker", { blockedCommands: true });
  await assert.rejects(blocked.provider.apiProjectPrepare({ confirm: true }), /project\.prepare 未修改 Xshell 自启动命令/);
  assert.deepEqual(blocked.calls.map(call => call.method), ["commands"], "blocked receipts must stop before any deployment");
});

test("confirmed prepare binds selected ids, optional session start and completes Agent flow only on fresh evidence", async () => {
  const f = fixture("worker_pool");
  const result = await f.provider.apiProjectPrepare({ confirm: true, startSessions: true, serverIds: ["worker-b"] });
  assert.equal(result.ok, true); assert.deepEqual(Array.from(result.enabledServers), ["worker-b"]);
  const deploy = f.calls.find(call => call.method === "deploy");
  assert.deepEqual(Array.from(deploy.serverIds), ["worker-b"]); assert.equal(deploy.pathConfirmed, true);
  const start = f.calls.find(call => call.method === "start");
  assert.deepEqual(Array.from(start.ids), ["worker-b"], "sessions start only when explicitly requested");
  assert.equal(f.events.find(item => item[0] === "prepare_agents")[1].completed, true);
  const stale = fixture("single_worker", { testFailure: true });
  await assert.rejects(stale.provider.apiProjectPrepare({ confirm: true }), /AGENT_PREPARATION_UNVERIFIED/);
  assert.equal(stale.events.some(item => item[0] === "prepare_agents"), false, "unverified probes never complete Agent preparation");
  const notStarted = fixture("single_worker");
  await notStarted.provider.apiProjectPrepare({ confirm: true });
  assert.equal(notStarted.calls.some(call => call.method === "start"), false, "prepare without startSessions must not start sessions");
});

test("legacy API endpoint patches retain explicit ports and POSIX paths and reject missing or coerced ports", () => {
  const setup = manual.setupFromManualEndpoints([endpoint()]);
  const merged = manual.setupFromPreparationApi(setup, { workerTunnels: [{ id: "worker-a", remoteRoot: "/new/中文 项目", condaEnv: "", port: 2200 }] });
  assert.equal(merged.workerTunnels[0].agentProjectDir, "/new/中文 项目"); assert.equal(merged.workerTunnels[0].localForwardPort, 29101);
  assert.equal(merged.workerTunnels[0].localForwardHost, "::1"); assert.equal(merged.workerTunnels[0].workerSshPort, 2200);
  assert.throws(() => manual.setupFromPreparationApi(setup, { workerTunnels: [{ id: "worker-new", host: "new.example.org", user: "u", remoteRoot: "/data/new" }] }));
  assert.throws(() => manual.setupFromPreparationApi(setup, { workerTunnels: [{ id: "worker-a", localForwardPort: "29102" }] }));
  assert.throws(() => manual.setupFromPreparationApi(setup, { manualEndpoints: [endpoint()], workerTunnels: [] }));
});

test("workflow readiness accepts the existing simpleSftp field and manual endpoints, while unavailable SFTP blocks", async () => {
  const setup = manual.setupFromManualEndpoints([endpoint()]);
  const args = { workspace: "/Users/test/project", setup, topology: { mode: "single_worker", valid: true }, requirePlan: false };
  assert.equal(workflow.structuredMissingInventory({ ...args, simpleSftp: { ready: true } }).length, 0);
  assert.equal(workflow.structuredMissingInventory({ ...args, simpleSftpMac: { ready: true } }).length, 0);
  const f = fixture("single_worker", { sftpReady: false });
  await assert.rejects(f.provider.apiProjectPrepare({ confirm: true }), error => error.apiCode === 2001 && error.apiData.missing.some(item => item.step === "prepare_agents"));
  assert.equal(f.uploads.length, 0); assert.equal(f.changes.length, 0); assert.equal(f.calls.length, 0);
});

test("failed runtime deployment stops before session start and leaves Agent preparation incomplete", async () => {
  const f = fixture("single_worker", { deployFailure: true });
  await assert.rejects(f.provider.apiProjectPrepare({ confirm: true, startSessions: true }), /部署失败/);
  assert.equal(f.calls.some(call => call.method === "start"), false);
  assert.equal(f.events.some(item => item[0] === "prepare_agents"), false);
});

test("prepareAgentsForFirstRun cancels without any side effect and completes only on ready plus clean verification", async () => {
  const cancelled = fixture("single_worker", { cancel: true });
  await assert.rejects(cancelled.provider.prepareAgentsForFirstRun(), /Agent 准备已取消/);
  assert.equal(cancelled.uploads.length, 0); assert.equal(cancelled.changes.length, 0);
  assert.equal(cancelled.calls.some(call => call.method === "deploy"), false, "cancellation never deploys");
  const ready = fixture("single_worker");
  assert.equal(await ready.provider.prepareAgentsForFirstRun(), true);
  assert.deepEqual(ready.calls.map(call => call.method), ["sync", "commands", "deploy", "start"]);
  assert.ok(ready.events.some(item => item[0] === "confirm" && String(item[1]).includes("worker-a")));
  const unverified = fixture("single_worker", { disconnected: true });
  await assert.rejects(unverified.provider.prepareAgentsForFirstRun(), /健康检测未通过/);
  assert.equal(unverified.calls.some(call => call.method === "deploy"), true, "deployment happened, but readiness is never claimed on failed probes");
});
