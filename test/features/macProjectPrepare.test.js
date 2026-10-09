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
const receiptSource = compiled.slice(compiled.indexOf("function sftpUploadSucceeded("), compiled.indexOf("const NON_SUCCESSFUL_SYNC_STATUSES"));
const receipts = vm.runInNewContext(receiptSource + "; ({sftpUploadSucceeded, sftpUploadFilesSucceeded})", {});
const endpoint = (id = "worker-a", localForwardPort = 29101) => ({ id, role: id === "hub" ? "hub" : "worker", host: id + ".example.org", user: "scientist", sshPort: 2222,
  localForwardHost: "::1", localForwardPort, remoteAgentHost: "127.0.0.1", remoteAgentPort: 29200, projectParentDir: "/data/研究 " + id,
  condaEnv: "/opt/环境 A", enabled: true });

function method(name, globals) {
  const start = compiled.search(new RegExp("^    (?:async )?" + name + "\\(", "m")); assert.ok(start >= 0, name);
  const tail = compiled.slice(start), end = tail.slice(1).search(/^    (?:async )?[a-zA-Z][a-zA-Z0-9_]*\(/m) + 1;
  assert.ok(end > 0, name);
  return vm.runInNewContext("({" + tail.slice(0, end) + "})", globals)[name];
}

function fixture(mode = "single_worker", options = {}) {
  const uploads = [], events = [], documents = [], changes = [];
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
    ensureSimpleSftpReadyForSetup: async () => true, ensureSftpManagerCommand: async () => {},
    async applySetupDraft(setup) { changes.push("setup"); this.setupConfig = setup; },
    saveTopologyModeFromApi: async () => { changes.push("topology"); },
    async writeSftpManagerServerProfiles(ids) { changes.push("profiles"); return { targetCount: ids.length }; },
    async apiAdvanceFlow(step, patch) { events.push([step, patch]); this.apiFlowState = workflow.advanceFlowStep(this.apiFlowState, step, patch); },
    async testTunnel() { events.push(["probe"]); this.lastProbe = { status: options.disconnected ? "timeout" : "agent_ok" }; this.lastWorkerProbes = Object.fromEntries(this.enabledWorkerConfigs().map(worker => [worker.id, { status: options.disconnected ? "timeout" : "agent_ok" }])); },
    async verifyDeployedAgentRuntime(targets, manifest) { events.push(["verify", targets, manifest]); return { fatal: [], warnings: options.verifyWarning ? ["hash mismatch"] : [] }; },
    ensureRemoteAgentVersionConsistent() { throw Error("preparation must not depend on an already running Agent"); },
    writeXshellAgentStartupCommands() { throw Error("must not write Xshell sessions"); }, startAllXshellConnections() { throw Error("must not start sessions"); },
    openWorkspaceFolderForContinuation: async () => {},
  };
  const globals = { ManualTunnel_1: manual, ApiWorkflow_1: workflow, TopologyMode_1: topology, XshellTunnelSetup_1: xshell, RuntimeManifest_1: runtime,
    AgentRuntimeScope_1: require("../../dist/features/AgentRuntimeScope"), SshTransportIdentity_1: ssh,
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
    ...receipts,
    resultError: result => result?.error || "", stringFromRecord: result => result?.error || "",
    AGENT_STARTUP_BLOCKED_SKIP_REASONS: new Set(), UiCommandCancelled: class extends Error {},
    vscode: { ProgressLocation: { Notification: 1 }, commands: { async executeCommand(command, args) {
      uploads.push({ command, args }); return options.uploadFailure ? { ok: false, error: "mock transfer refused" } : options.uploadReceipt || { ok: true };
    } }, workspace: { async openTextDocument(value) { documents.push(value); return value; } }, window: {
      showWarningMessage: async (...args) => { events.push(["confirm", ...args]); if (options.onConfirm) options.onConfirm(provider); return options.cancel ? undefined : "确认上传并查看指引"; },
      withProgress: (_options, operation) => operation(), showTextDocument: async () => {}, showInformationMessage: async () => {},
    } } };
  for (const name of ["apiProjectPrepare", "apiMergedSetupConfig", "apiSetupConfigChanged", "apiPrepareTopology", "apiTopologyAssessmentForConfig", "apiPrepareServerTargets",
    "apiMergedWorkerConfigs", "apiPublicTopology", "apiServerTestAll", "apiStartAllConnections", "apiPlanValidate", "apiResolveSelectedPlan", "apiProjectBootstrap", "apiPrepareConfirmationPreview", "prepareMacAgentsForFirstRun", "prepareAgentsForFirstRun", "assertExecutionCondaEnvReady",
    "agentRuntimeDirs", "hubActualWorkRootTarget", "workerActualWorkRootTarget", "workerActualWorkRootTargets", "sshTransportIdentity", "sftpServerOptions",
    "prepareSftpTargets", "sftpSharedTargets", "hubCodeSyncTarget", "workerCodeSyncTarget", "assertSshTransportIdentities", "agentRuntimeDeployTargets", "agentRuntimeUploadTargets", "deployLatestAgentRuntime", "expectedAgentRuntimeForTargets", "runApiBootstrapOperation"]) provider[name] = method(name, globals);
  return { provider, uploads, events, documents, changes, setRoot(value) { root = value; } };
}

test("Mac preview covers all three topologies without Xshell requirements, uploads or remote probes", async () => {
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const f = fixture(mode);
    await assert.rejects(f.provider.apiProjectPrepare({ confirm: false }), error => {
      assert.equal(error.apiCode, 2001); const data = error.apiData;
      assert.equal(data.missing.some(item => ["select_servers", "select_mode", "prepare_agents"].includes(item.step)), false);
      assert.equal(data.preview.topology.mode, mode); assert.equal(data.preview.modifications.xshellSessions.length, 0);
      assert.equal(data.preview.modifications.remoteProject.length, mode === "single_worker" ? 1 : 2);
      assert.equal(data.preview.modifications.remoteProject[0].remotePath, data.preview.servers[0].remoteRoot + "/研究 A");
      assert.match(data.preparationScope, /^[a-f0-9]{64}$/); return true;
    });
    assert.equal(f.uploads.length, 0); assert.equal(f.changes.length, 0); assert.equal(f.events.length, 0);
  }
});

test("confirmed Mac prepare uses actual runtime deployment and project commands with independent targets", async () => {
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const f = fixture(mode), result = await f.provider.apiProjectPrepare({ confirm: true, startSessions: true });
    const count = mode === "single_worker" ? 1 : 2;
    assert.equal(result.ok, true); assert.equal(result.runtimeDeployed, true); assert.equal(result.projectUploads.length, count);
    assert.equal(result.agentReady, false); assert.equal(result.manualStart.automaticStart, false); assert.equal(result.manualStart.required, true);
    assert.equal(f.uploads.length, count * 2);
    for (const upload of f.uploads) {
      assert.equal(upload.args.confirm, true); assert.equal(upload.args.pathConfirmed, true);
      assert.equal(upload.args.server.host, upload.args.targetId.replace(/-agent-runtime$/, "") + ".example.org");
      assert.equal(upload.args.server.port, 2222); assert.equal(upload.args.server.user, "scientist");
      if (upload.command.endsWith("uploadFiles")) {
        assert.ok(upload.args.remotePath.endsWith("/simple_agent/simple_cluster/runtime"));
        assert.equal(upload.args.files.length, 2); assert.equal(upload.args.manifest.files["cluster_agent.py"], crypto.createHash("sha256").update(fs.readFileSync(upload.args.files[0].localPath)).digest("hex"));
      } else { assert.equal(upload.command, "simpleSftpMac.uploadWorkspace"); assert.ok(upload.args.remotePath.endsWith("/研究 A")); assert.equal(upload.args.pruneManagedFiles, false); }
    }
    assert.ok(result.manualStart.guide.includes("tmux has-session")); assert.ok(result.manualStart.guide.includes("--port 29200"));
    assert.equal(f.events.find(item => item[0] === "prepare_agents")[1].completed, false);
  }
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
  assert.equal(f.uploads.length, 0); assert.equal(f.changes.length, 0);
});

test("selected servers have scoped guides; start-only and explicit upload skips never start or upload", async () => {
  const f = fixture("worker_pool"), result = await f.provider.apiProjectPrepare({ confirm: true, serverIds: ["worker-b"], deployRuntime: false, uploadProject: false });
  assert.equal(result.enabledServers.length, 1); assert.ok(result.manualStart.guide.includes("worker-b.example.org"));
  assert.ok(!result.manualStart.guide.includes("worker-a.example.org")); assert.equal(f.uploads.length, 0);
  const start = await f.provider.apiStartAllConnections({ confirm: true, startSessions: true });
  assert.equal(start.manualStart.required, true); assert.equal(f.uploads.length, 0);
});

test("fresh HTTP readiness plus matching runtime evidence is required before Agent preparation is complete", async () => {
  for (const verifyWarning of [false, true]) {
    const f = fixture("single_worker", { verifyWarning }), result = await f.provider.apiProjectPrepare({ confirm: true, autoTest: true });
    assert.equal(result.agentReady, !verifyWarning); assert.equal(result.manualStart.required, verifyWarning);
    assert.equal(f.events.filter(item => item[0] === "probe").length, 1); assert.equal(f.events.filter(item => item[0] === "verify").length, 1);
    assert.equal(f.events.find(item => item[0] === "prepare_agents")[1].completed, !verifyWarning);
  }
});

test("UI cancellation changes nothing; accepted preview uploads and opens the manual guide", async () => {
  const cancelled = fixture("single_worker", { cancel: true });
  await assert.rejects(cancelled.provider.prepareAgentsForFirstRun(), /准备已取消/); assert.equal(cancelled.uploads.length, 0); assert.equal(cancelled.changes.length, 0);
  const f = fixture(); assert.equal(await f.provider.prepareAgentsForFirstRun(), false);
  assert.equal(f.uploads.length, 2); assert.equal(f.documents.length, 1); assert.ok(f.documents[0].content.includes("Termius"));
  assert.ok(f.events.find(item => item[0] === "confirm")[1].includes("/data/研究 worker-a/研究 A"));
});

test("changing a confirmed endpoint or workspace prevents upload until a new preview is approved", async () => {
  const f = fixture("single_worker", { onConfirm(provider) { provider.setupConfig = manual.setupFromManualEndpoints([{ ...endpoint(), host: "changed.example.org" }]); } });
  await assert.rejects(f.provider.prepareMacAgentsForFirstRun(), /重新预览并确认/); assert.equal(f.uploads.length, 0); assert.equal(f.changes.length, 0);
  const moved = fixture(); await assert.rejects(moved.provider.apiProjectPrepare({ confirm: true, workspace: "/Users/test/different" }), /当前打开/); assert.equal(moved.uploads.length, 0);
});

test("failed runtime upload stops before project upload and leaves Agent readiness incomplete", async () => {
  const f = fixture("single_worker", { uploadFailure: true });
  await assert.rejects(f.provider.apiProjectPrepare({ confirm: true }), /部署失败/);
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].command, "simpleSftpMac.uploadFiles"); assert.equal(f.events.length, 0);
});

test("Mac accepts an explicit empty Python environment and rejects incomplete nested upload receipts", async () => {
  const f = fixture(); f.provider.setupConfig = manual.setupFromManualEndpoints([{ ...endpoint(), condaEnv: "" }]);
  const result = await f.provider.apiProjectPrepare({ confirm: true });
  assert.ok(result.manualStart.guide.includes("python3")); assert.equal(f.uploads.length, 2);
  for (const uploadReceipt of [{ ok: true, results: [{ status: "completed" }, { status: "failed" }] }, { status: "running" }]) {
    const failed = fixture("single_worker", { uploadReceipt });
    await assert.rejects(failed.provider.apiProjectPrepare({ confirm: true }), /部署失败/);
    assert.equal(failed.uploads.length, 1); assert.equal(failed.events.length, 0);
  }
});

test("manual bootstrap records an actionable blocked phase and rechecks without uploading again", async () => {
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const options = { disconnected: true }, f = fixture(mode, options);
    f.provider.apiPlanValidate = async () => { f.events.push(["validate"]); return { ok: true }; };
    await f.provider.runApiBootstrapOperation("initial", {});
    const blocked = f.provider.localOperations.initial;
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.phase, "manual_start"); assert.ok(blocked.manualStart.guide.includes("Termius"));
    assert.equal(f.events.filter(item => item[0] === "validate").length, 0);
    assert.equal(f.events.find(item => item[0] === "prepare_agents")[1].completed, false);
    const count = f.uploads.length; options.disconnected = false;
    await f.provider.runApiBootstrapOperation("retry", { ...blocked.calls[0].params, confirm: true });
    assert.equal(f.provider.localOperations.retry.status, "succeeded"); assert.equal(f.uploads.length, count);
    assert.equal(f.events.filter(item => item[0] === "verify").length, 1);
    const verification = f.events.find(item => item[0] === "verify");
    assert.equal(verification[1].length, mode === "single_worker" ? 1 : 2);
    assert.equal(verification[2].files["cluster_agent.py"], crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "../../dist/runtime/cluster_agent.py"))).digest("hex"));
  }
});

test("read-only recheck cannot mark bootstrap complete with mismatching runtime or failed Plan validation", async () => {
  const bad = fixture("single_worker", { verifyWarning: true });
  bad.provider.apiPlanValidate = async () => { throw Error("validation must wait for actual Agent proof"); };
  await bad.provider.runApiBootstrapOperation("bad-hash", { deployRuntime: false, uploadProject: false });
  assert.equal(bad.provider.localOperations["bad-hash"].status, "blocked"); assert.equal(bad.uploads.length, 0);
  const failed = fixture(); failed.provider.apiPlanValidate = async () => ({ ok: false, missing: ["Plan 契约未通过"] });
  await assert.rejects(failed.provider.runApiBootstrapOperation("bad-plan", { deployRuntime: false, uploadProject: false }), /前置检查未通过/);
  assert.notEqual(failed.provider.localOperations["bad-plan"].status, "succeeded"); assert.equal(failed.uploads.length, 0);
});

test("actual Mac version checks never deploy or restart and validation rejects warnings and mismatches", async () => {
  const globals = { fs: fs.promises, path, __dirname: path.join(__dirname, "../../dist/extension"), RuntimeManifest_1: runtime,
    console: { warn() {} }, vscode: { window: { showInformationMessage: async () => {}, showWarningMessage: async () => {} } } };
  for (const outcome of [{ fatal: ["old runtime"], warnings: [] }, { fatal: [], warnings: ["unreachable"] }, { fatal: [], warnings: [] }]) {
    const f = fixture(); f.provider.verifyDeployedAgentRuntime = async () => outcome;
    for (const name of ["checkRemoteAgentVersionAndNotify", "ensureRemoteAgentVersionConsistent"]) f.provider[name] = method(name, globals);
    f.provider.deployLatestAgentRuntime = () => { throw Error("must not automatically deploy"); };
    f.provider.restartRealtimeTunnelSessionsIfNeeded = () => { throw Error("must not restart"); };
    const result = await f.provider.checkRemoteAgentVersionAndNotify(true);
    assert.deepEqual(result, outcome); assert.equal(f.uploads.length, 0);
    if (outcome.fatal.length || outcome.warnings.length) await assert.rejects(f.provider.ensureRemoteAgentVersionConsistent(), /只读版本\/哈希校验未通过/);
    else await f.provider.ensureRemoteAgentVersionConsistent();
  }
});

test("Plan validation cannot succeed after a failed read-only runtime check, even with healthy cached probes", async () => {
  for (const failure of ["runtime mismatch", "hash mismatch", "unreachable"]) {
    const f = fixture(); f.provider.localPlanMetadata.plans = [{ planFile: "experiments/plans/main.yaml" }];
    f.provider.lastWorkerProbes = { "worker-a": { status: "ok" } };
    f.provider.expectedWorkerAgentProjectRoot = () => "/data/project";
    f.provider.ensureRemoteAgentVersionConsistent = async () => { throw Error(failure); };
    const result = await f.provider.apiPlanValidate({}); assert.equal(result.ok, false);
    assert.ok(result.missing.some(item => item.step === "prepare_agents" && item.reason === failure)); assert.equal(f.uploads.length, 0);
  }
});

test("confirmed upload scopes bind endpoint ports, Python environment, tmux prefix and token", async () => {
  for (const change of [provider => { provider.setupConfig.workerTunnels[0].localForwardPort++; },
    provider => { provider.setupConfig.workerTunnels[0].condaEnv = "/different/python"; },
    provider => { provider.setupConfig.remoteTmuxSessionPrefix = "changed"; }, provider => { provider.tunnelConfig.token = "changed-token"; }]) {
    const f = fixture("single_worker", { onConfirm: change });
    await assert.rejects(f.provider.prepareMacAgentsForFirstRun(), /重新预览并确认/);
    assert.equal(f.uploads.length, 0); assert.equal(f.changes.length, 0);
  }
});

test("bootstrap confirmation binds the background operation to the exact reviewed workspace and scope", async () => {
  const f = fixture(); f.provider.apiPlanValidate = async () => ({ ok: true, missing: [] });
  let queued;
  f.provider.runApiBootstrapOperation = async (id, params) => { queued = { id, params }; };
  await assert.rejects(f.provider.apiProjectBootstrap({}), error => error.apiCode === 2001 && error.apiData.operation === "project.bootstrap");
  assert.equal(queued, undefined); assert.equal(f.uploads.length, 0);
  const result = await f.provider.apiProjectBootstrap({ confirm: true }); assert.equal(result.status, "started");
  assert.equal(queued.params.workspace, "/Users/test/研究 A"); assert.match(queued.params.expectedPreparationScope, /^[a-f0-9]{64}$/);
  f.provider.setupConfig.workerTunnels[0].localForwardPort++;
  const run = method("runApiBootstrapOperation", {
    stringArrayField: () => [], errorMessage: error => error.message,
  }).bind(f.provider);
  await assert.rejects(run(queued.id, queued.params), /重新预览并确认/);
  assert.equal(f.uploads.length, 0);
});
