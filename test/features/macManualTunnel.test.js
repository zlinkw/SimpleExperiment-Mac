const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const manual = require("../../dist/mac/ManualTunnel");
const topology = require("../../dist/features/TopologyMode");
const endpoint = (id = "worker-a", localForwardPort = 29101) => ({ id, role: id === "hub" ? "hub" : "worker", host: "gpu.example.org", user: "scientist", sshPort: 2222,
  localForwardHost: "[::1]", localForwardPort, remoteAgentHost: "127.0.0.1", remoteAgentPort: 29200, projectParentDir: "/data/研究 项目/Model/尾部 ", enabled: true });

test("manual endpoints preserve explicit ports, POSIX case and spaces without private session identity", () => {
  const setup = manual.setupFromManualEndpoints([endpoint()], { xshellExePath: "private.exe", savedSessionPath: "private.xsh", transferHost: "stale", workerTunnels: [{ id: "worker-a", sshConfigAlias: "stale", transferHost: "stale" }] });
  const worker = setup.workerTunnels[0];
  assert.equal(worker.localForwardHost, "::1"); assert.equal(worker.localForwardPort, 29101); assert.equal(worker.remoteTelemetryPort, 29200);
  assert.equal(worker.agentProjectDir, endpoint().projectParentDir); assert.equal(worker.workerHost, endpoint().host);
  assert.equal(worker.savedSessionPath, undefined); assert.equal(worker.sshConfigAlias, undefined); assert.equal(worker.transferHost, undefined);
  assert.equal(setup.xshellExePath, ""); assert.equal(setup.autoStartTunnelOnExtensionActivation, false);
  const roundtrip = manual.endpointsFromSetup(setup)[0]; assert.equal(roundtrip.projectParentDir, endpoint().projectParentDir); assert.equal(roundtrip.localForwardPort, 29101);
});

test("invalid config never falls back to fixed ports or private session paths", () => {
  for (const patch of [{ localForwardPort: "29101" }, { localForwardPort: 0 }, { remoteAgentPort: 65536 }, { sshPort: -1 }, { projectParentDir: "C:\\data" }, { projectParentDir: "/data/../root" }, { host: "bad host" }, { role: "hub" }, { enabled: "false" }]) {
    assert.throws(() => manual.setupFromManualEndpoints([{ ...endpoint(), ...patch }]));
  }
  assert.throws(() => manual.setupFromManualEndpoints([endpoint(), endpoint("worker-b")]));
  assert.throws(() => manual.setupFromManualEndpoints([endpoint(), endpoint("worker-a", 29102)]));
  assert.equal(manual.setupFromManualEndpoints([]).hubHost, "");
});

test("single Worker, Worker pool and Hub/Worker retain topology inventory and disabled Hub", () => {
  for (const [mode, endpoints] of [["single_worker", [endpoint()]], ["worker_pool", [endpoint(), endpoint("worker-b", 29102)]], ["hub_worker", [endpoint("hub", 29100), endpoint()]]]) {
    const setup = manual.setupFromManualEndpoints(endpoints);
    assert.equal(topology.assessProjectTopology(mode, { hubConfigured: Boolean(setup.hubHost), enabledWorkerIds: setup.workerTunnels.filter(w => w.enabled).map(w => w.id) }).valid, true);
  }
  const setup = manual.setupFromManualEndpoints([{ ...endpoint("hub", 29100), enabled: false }, endpoint()]);
  assert.equal(setup.hubHost, ""); assert.equal(manual.endpointsFromSetup(setup)[0].enabled, false);
});

test("tmux guide quotes Chinese paths and preserves existing Agent sessions without copying tokens", () => {
  const setup = manual.setupFromManualEndpoints([{ ...endpoint(), projectParentDir: "/data/研究 '项目", condaEnv: "/opt/环境 A" }]);
  const guide = manual.manualAgentGuide(setup, "single_worker", "实验 A", true);
  assert.match(guide, /tmux has-session/); assert.match(guide, /tmux attach-session/); assert.match(guide, /worker_telemetry/);
  assert.ok(guide.includes("'/data/研究 '\\''项目/实验 A'")); assert.ok(guide.includes("'/opt/环境 A/bin/python'"));
  assert.ok(guide.includes('--port 29200')); assert.ok(guide.includes('--token "$SIMPLE_EXPERIMENT_AGENT_TOKEN"'));
  assert.doesNotMatch(guide, /kill-session|kill-server|\.xsh|password=/); assert.throws(() => manual.manualAgentGuide(setup, "single_worker", "../bad"));
});

function compiledMethod(name, globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = source.search(new RegExp("^    (?:async )?" + name + "\\(", "m"));
  assert.ok(start >= 0, name);
  const tail = source.slice(start), end = tail.slice(1).search(/^    (?:async )?[a-zA-Z][a-zA-Z0-9_]*\(/m) + 1;
  assert.ok(end > 0, name);
  return vm.runInNewContext("({" + tail.slice(0, end) + "})", { ManualTunnel_1: manual, keys: { setupConfig: "setup" }, errorMessage: e => e.message, ...globals });
}

test("legacy script command opens the actual Termius guide on Mac for all three topologies", async () => {
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const documents = [], shown = [];
    const points = mode === "single_worker" ? [endpoint()] : mode === "worker_pool" ? [endpoint(), endpoint("worker-b", 29102)] : [endpoint("hub", 29100), endpoint()];
    const vscode = { workspace: { openTextDocument: async value => { documents.push(value); return value; } },
      window: { showTextDocument: async (doc, options) => { shown.push({ doc, options }); }, showSaveDialog: () => { throw Error("Windows script dialog must not open"); } } };
    const globals = { vscode, remoteProjectName: () => "实验 A", fs: { writeFile: () => { throw Error("Must not write a launch script"); } },
      XshellTunnelSetup_1: { validateXshellSetupConfig: () => { throw Error("Windows Xshell validation must not run"); } } };
    const instance = compiledMethod("generateTunnelScript", globals);
    instance.showManualAgentGuide = compiledMethod("showManualAgentGuide", globals).showManualAgentGuide;
    instance.isMacVariant = () => true;
    instance.setupConfig = manual.setupFromManualEndpoints(points);
    instance.tunnelConfig = { token: "PRIVATE_TOKEN_MUST_NOT_APPEAR" };
    instance.assertTopologyReady = () => ({ mode });
    instance.tunnelLaunchItems = () => { throw Error("Windows session launch items must not be queried"); };
    await instance.generateTunnelScript();
    assert.equal(documents.length, 1); assert.equal(shown.length, 1); assert.equal(shown[0].options.preview, true);
    assert.equal(documents[0].language, "markdown"); assert.match(documents[0].content, /Termius/);
    assert.match(documents[0].content, /tmux has-session/); assert.ok(documents[0].content.includes("实验 A"));
    assert.doesNotMatch(documents[0].content, /PRIVATE_TOKEN_MUST_NOT_APPEAR|\.bat|\.ps1|Xshell/);
    const workerPoints = points.filter(point => point.role !== "hub");
    for (const point of workerPoints) { assert.ok(documents[0].content.includes(String(point.localForwardPort))); assert.ok(documents[0].content.includes(String(point.remoteAgentPort))); }
    // Hub removal is the current contract: a legacy hub endpoint is never guided as an active section.
    for (const point of points.filter(point => point.role === "hub")) assert.equal(documents[0].content.includes(String(point.localForwardPort)), false, "the retired Hub endpoint is not guided");
  }
});

test("actual Mac provider reads settings, fails closed and bypasses private-session operations", async () => {
  let value = [endpoint()];
  const provider = compiledMethod("loadSetupConfig", { vscode: { workspace: { getConfiguration: () => ({ get: (key, fallback) => key === manual.MANUAL_ENDPOINT_SETTING ? value : fallback }) } } });
  provider.isMacVariant = () => true; provider.context = { globalState: { get: () => ({ savedSessionPath: "private.xsh" }) } };
  const parsed = provider.loadSetupConfig();
  assert.equal(parsed.workerTunnels[0].localForwardPort, 29101);
  assert.equal(parsed.workerTunnels[0].savedSessionPath, undefined, "a saved private session file never enters the Mac setup");
  value = [{ ...endpoint(), localForwardPort: 0 }]; const invalid = provider.loadSetupConfig(); assert.match(invalid.manualEndpointError, /整数/); assert.equal(invalid.workerTunnels.length, 0);
  // The production chain applies the Mac host adapter over the shared provider; run the real module.
  const adapterFile = path.resolve(__dirname, "../../dist/platform/MacHostAdapter.js");
  const localRequire = require("node:module").createRequire(adapterFile);
  const vscodeStub = { workspace: { getConfiguration: () => ({ inspect: () => ({ globalValue: value }), get: (key, fallback) => key === manual.MANUAL_ENDPOINT_SETTING ? value : fallback }) },
    extensions: { getExtension: () => undefined }, window: { showInformationMessage: async () => {} }, commands: { executeCommand: async () => {} } };
  const sharedExports = {};
  const sandbox = { require: name => name === "vscode" ? vscodeStub : localRequire(name), exports: sharedExports, module: { exports: sharedExports }, console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder };
  vm.runInNewContext(fs.readFileSync(adapterFile, "utf8"), sandbox);
  class BaseProvider {
    constructor() { this.context = { globalState: { get: () => undefined }, extension: { packageJSON: { name: "simple-experiment-mac" } } }; }
    loadSetupConfig() { return { workerTunnels: [], condaEnv: "", remoteTmuxSessionPrefix: "simple" }; }
    async applySetupDraft(draft) { this.applied = draft; }
    async refreshLocalSshConfig() { this.sshRefreshed = (this.sshRefreshed || 0) + 1; }
    async assertSshTransportIdentities() { this.identitiesChecked = (this.identitiesChecked || 0) + 1; }
    sftpSharedTargets() { return []; }
    tunnelLaunchItems() { throw new Error("Windows session launch items must not be queried"); }
  }
  sandbox.module.exports.installMacHostAdapter(BaseProvider);
  value = [endpoint()];
  const mac = new BaseProvider();
  const loaded = mac.loadSetupConfig();
  assert.equal(loaded.workerTunnels[0].localForwardPort, 29101); assert.equal(loaded.macManagedSessions, true);
  value = [{ ...endpoint(), localForwardPort: 0 }];
  const adapterInvalid = mac.loadSetupConfig(); assert.match(adapterInvalid.manualEndpointError, /整数/); assert.equal(adapterInvalid.workerTunnels.length, 0);
  value = [endpoint()];
  await mac.refreshXshellSessionLibrary();
  assert.deepEqual(Array.from(mac.xshellLibrary.sessions), []); assert.deepEqual(Array.from(mac.xshellLibrary.searchedDirs), []);
  mac.setupConfig = manual.setupFromManualEndpoints([endpoint()]);
  await mac.syncXshellConfigBeforeNetwork("fixture");
  assert.equal(mac.sshRefreshed, 1); assert.equal(mac.identitiesChecked, 1);
  mac.startMacSystemTunnels = async (requireConfirm, ids) => { mac.launchCall = { requireConfirm, ids }; return { declined: false, outcomes: [{ id: ids[0], state: "verified", message: "已确认监听" }] }; };
  assert.equal(await mac.launchTunnelItem({ id: "worker-a" }), true);
  assert.deepEqual(Array.from(mac.launchCall.ids), ["worker-a"], "launch routes to the sanctioned one-click system tunnel entry");
});

test("manual server cards expose settings, guide and detection without session file controls", () => {
  // The shared Windows renderer owns the Mac cards too (macManaged identity); this gate keeps
  // the real renderServerCardsV2 + configSessionSelect running with every other helper stubbed.
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
  const terminal = require("../../dist/platform/Terminal");
  const slice = (name, next) => { const s = source.indexOf("    function " + name + "("); assert.ok(s >= 0, name); const e = source.indexOf("    function " + next + "(", s + 10); assert.ok(e > s, name); return source.slice(s, e); };
  const inputs = [], html = {}, escaped = v => String(v === undefined || v === null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const base = {
    Map, Set, JSON, Math, Number, String, Boolean, Date, RegExp, Array, Object, parseInt, parseFloat, isNaN, encodeURIComponent,
    esc: escaped, escAttr: escaped, asArray: v => Array.isArray(v) ? v : [],
    configInput: (scope, key, label, value) => { inputs.push({ scope, key, value: String(value === undefined || value === null ? "" : value) }); return '<i data-key="' + key + '">' + escaped(value) + "</i>"; },
    configSelect: () => "<select></select>", configDraftValue: (scope, key, value) => value,
    configPortPair: (scope, label, localKey, remoteKey, localValue, remoteValue) => { inputs.push({ scope, key: localKey, value: String(localValue ?? "") }, { scope, key: remoteKey, value: String(remoteValue ?? "") }); return ""; },
    setHtmlIfChanged: (id, value) => { html[id] = String(value); },
    nativeWorkerTransportConfigured: terminal.configuredWorkerTransport, lastState: null,
  };
  const sandbox = new Proxy(base, { get: (target, key) => key in target ? target[key] : (typeof key === "string" ? () => "" : undefined), has: () => true });
  vm.createContext(sandbox);
  vm.runInContext(slice("configSessionSelect", "configPortPair") + "\n" + slice("renderServerCardsV2", "isSingleWorkerDense"), sandbox);
  const state = { setup: manual.setupFromManualEndpoints([{ ...endpoint(), displayName: "<script>" }]), topology: { mode: "single_worker", valid: true, issues: [] } };
  sandbox.lastState = state;
  sandbox.renderServerCardsV2(state);
  const card = html.serverSettingsCards || "";
  assert.ok(card.length > 0);
  assert.deepEqual(inputs.filter(input => input.key === "agentProjectDir").map(input => input.value), ["/data/研究 项目/Model/尾部 "], "edge space byte-identical in the card form");
  for (const key of ["workerSshPort", "localForwardHost", "remoteAgentHost"]) assert.ok(inputs.some(input => input.key === key && input.scope === "worker:worker-a"), key + " native endpoint field");
  assert.equal(inputs.some(input => input.key === "savedSessionPath"), false, "Mac cards never expose a session-file field");
  assert.deepEqual(inputs.filter(input => input.scope === "worker:worker-a" && ["localForwardPort", "remoteTelemetryPort"].includes(input.key)).map(input => input.value), ["29101", "29200"]);
  for (const text of ["startTunnelEndpoint", "saveWorkerConfig", "研究 项目", "&lt;script&gt;"]) assert.ok(card.includes(text), text);
  assert.doesNotMatch(card, /\.xsh|Xshell|<script>/);
  const serverCardsSource = slice("renderServerCards", "renderTensorBoardLinkRow");
  for (const command of ["prepareAgents", "testAll", "startAll"]) assert.ok(serverCardsSource.includes('data-command="' + command + '"'), command);
});

test("actual Mac preparation blockers accept manual endpoints and report invalid topology without Xshell checks", () => {
  const instance = compiledMethod("currentAgentPreparationBlockers");
  instance.isMacVariant = () => true; instance.setupConfig = manual.setupFromManualEndpoints([endpoint()]);
  instance.projectTopologyAssessment = () => ({ valid: true });
  instance.currentTunnelLaunchBlockers = () => { throw Error("Xshell must not be inspected"); };
  assert.equal(instance.currentAgentPreparationBlockers().length, 0);
  instance.projectTopologyAssessment = () => ({ valid: false, issues: ["需要两个 Worker"] });
  assert.equal(instance.currentAgentPreparationBlockers()[0], "需要两个 Worker");
  instance.setupConfig.manualEndpointError = "无效端点";
  assert.equal(instance.currentAgentPreparationBlockers()[0], "无效端点");
});

test("Mac UI readiness and toolbar follow saved endpoints rather than missing session files", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
  const terminal = require("../../dist/platform/Terminal");
  const base = { EMPTY_SERVER_SETUP: {},
    enabledWorkerTunnelsForState: state => state.setup.workerTunnels.filter(worker => worker.enabled), meaningfulValue: value => Boolean(value), asArray: value => Array.isArray(value) ? value : [],
    nativeWorkerTransportConfigured: terminal.configuredWorkerTransport };
  const sandbox = new Proxy(base, { get: (target, key) => key in target ? target[key] : (typeof key === "string" ? () => "" : undefined), has: () => true });
  vm.createContext(sandbox);
  for (const [name, next] of [["serverSetupReadiness", "executionWorkerReadiness"], ["hasAnyTunnelSession", "hasAnyAgentSession"]]) {
    const start = source.indexOf("    function " + name + "("), end = source.indexOf("    function " + next + "(", start);
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(source.slice(start, end), sandbox);
  }
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const points = mode === "single_worker" ? [endpoint()] : mode === "worker_pool" ? [endpoint(), endpoint("worker-b", 29102)] : [endpoint("hub", 29100), endpoint()];
    const state = { setup: manual.setupFromManualEndpoints(points), topology: { mode, valid: true } };
    assert.equal(sandbox.serverSetupReadiness(state).ready, true); assert.equal(sandbox.hasAnyTunnelSession(state), true);
    state.setup.manualEndpointError = "配置错误"; const failed = sandbox.serverSetupReadiness(state);
    assert.equal(failed.ready, false); assert.equal(failed.missing[0], "配置错误", "endpoint errors fail the readiness closed");
  }
  // Toolbar: the managed lifecycle entries stay available with the real one-click tunnel label.
  assert.ok(source.includes('data-command="prepareAgents"') && source.includes("部署Agent"), "prepare entry");
  assert.ok(source.includes("启动全部隧道"), "one-click tunnel entry");
  assert.equal(source.includes("renderManualServerCards"), false, "the retired manual-card renderer must not return");
  const pkg = require("../../package.json");
  const title = pkg.contributes.commands.find(command => command.command === "simpleExperimentMac.prepareAgents").title;
  for (const file of ["README.md", "docs/simple-experiment-setup.md"]) {
    const doc = fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");
    assert.ok(doc.includes(title)); assert.ok(doc.includes("确认上传并查看指引")); assert.ok(doc.includes("检查更新"));
  }
});

test("actual endpoint registry uses each configured port and excludes an absent Hub", () => {
  const registry = require("../../dist/tunnel/TunnelEndpointRegistry");
  const instance = compiledMethod("realtimeEndpoints", { TunnelEndpointRegistry_1: registry, endpointCapabilitiesFromProbe: () => [] });
  instance.isMacVariant = () => true; instance.setupConfig = manual.setupFromManualEndpoints([endpoint(), endpoint("worker-b", 29102)]);
  instance.projectTopologyAssessment = () => ({ hubAllowed: true }); instance.lastWorkerProbes = {}; instance.tunnelConfig = {};
  instance.expectedWorkerAgentProjectRoot = () => "/data/project";
  const endpoints = instance.realtimeEndpoints(); assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].localPort, 29101); assert.equal(endpoints[1].localPort, 29102); assert.equal(endpoints[0].localHost, "::1");
  const probeFile = path.resolve(__dirname, "../../dist/tunnel/XshellTunnelPortProbe.legacy.js");
  const probeSource = fs.readFileSync(probeFile, "utf8");
  const localRequire = require("node:module").createRequire(probeFile); const exports = {};
  vm.runInNewContext(probeSource + "\nexports.probeBase = resolveProbeBase;", { exports, require: localRequire });
  assert.equal(exports.probeBase({ localForwardHost: "::1", localForwardPort: 29101 }), "http://[::1]:29101");
});
