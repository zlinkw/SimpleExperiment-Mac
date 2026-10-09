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

test("actual Mac provider reads settings, fails closed and bypasses private-session operations", async () => {
  let value = [endpoint()];
  const provider = compiledMethod("loadSetupConfig", { vscode: { workspace: { getConfiguration: () => ({ get: (key, fallback) => key === manual.MANUAL_ENDPOINT_SETTING ? value : fallback }) } } });
  provider.isMacVariant = () => true; provider.context = { globalState: { get: () => ({ savedSessionPath: "private.xsh" }) } };
  assert.equal(provider.loadSetupConfig().workerTunnels[0].localForwardPort, 29101);
  value = [{ ...endpoint(), localForwardPort: 0 }]; const invalid = provider.loadSetupConfig(); assert.match(invalid.manualEndpointError, /整数/); assert.equal(invalid.workerTunnels.length, 0);
  for (const name of ["refreshXshellSessionLibrary", "syncXshellConfigBeforeNetwork", "launchTunnelItem"]) {
    const instance = compiledMethod(name); instance.isMacVariant = () => true; instance.setupConfig = manual.setupFromManualEndpoints([endpoint()]);
    const result = await instance[name]({}, {}); if (name === "launchTunnelItem") assert.equal(result.launched, false);
    if (name === "refreshXshellSessionLibrary") assert.equal(instance.xshellLibrary.sessions.length, 0);
  }
});

test("manual server cards expose settings, guide and detection without session file controls", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
  const start = source.indexOf("    function renderManualServerCards("), end = source.indexOf("    function renderServerCardsV2(", start);
  let html = ""; const sandbox = { asArray: v => Array.isArray(v) ? v : [], esc: v => String(v).replace(/</g, "&lt;"), configSelect: () => "select", setHtmlIfChanged: (_, v) => { html = v; } };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  sandbox.renderManualServerCards({ setup: manual.setupFromManualEndpoints([{ ...endpoint(), displayName: "<script>" }]), topology: { mode: "single_worker", issues: [] } });
  for (const text of ["configureSessions", "prepareAgents", "准备项目与 Agent", "writeAgentCommands", "testAll", "29101", "29200", "研究 项目", "&lt;script>"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /\.xsh|Xshell|<script>/);
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
  const sandbox = { EMPTY_SERVER_SETUP: {}, serverSetupReadinessCacheSetup: null, serverSetupReadinessCacheWorkers: null, serverSetupReadinessCacheValue: null,
    enabledWorkerTunnelsForState: state => state.setup.workerTunnels.filter(worker => worker.enabled), meaningfulValue: value => Boolean(value), asArray: value => Array.isArray(value) ? value : [],
    setHtmlIfChanged() {}, renderServerChainOverview: () => "", renderCheckStaticReports: () => "" };
  const prepare = {}, start = {};
  sandbox.document = { querySelectorAll: selector => selector.includes('prepareAgents') ? [prepare] : [start] };
  vm.createContext(sandbox);
  for (const [name, next] of [["serverSetupReadiness", "executionWorkerReadiness"], ["hasAnyTunnelSession", "hasAnyAgentSession"], ["renderSyncSection", "renderManualServerCards"]]) {
    vm.runInContext(source.slice(source.indexOf("    function " + name + "("), source.indexOf("    function " + next + "(")), sandbox);
  }
  for (const mode of ["single_worker", "worker_pool", "hub_worker"]) {
    const points = mode === "single_worker" ? [endpoint()] : mode === "worker_pool" ? [endpoint(), endpoint("worker-b", 29102)] : [endpoint("hub", 29100), endpoint()];
    const state = { setup: manual.setupFromManualEndpoints(points), topology: { mode, valid: true } };
    assert.equal(sandbox.serverSetupReadiness(state).ready, true); assert.equal(sandbox.hasAnyTunnelSession(state), true);
    sandbox.renderSyncSection(state); assert.equal(prepare.textContent, "准备项目与 Agent"); assert.equal(start.textContent, "Termius 手动启动指引");
    state.setup.manualEndpointError = "配置错误"; assert.equal(sandbox.serverSetupReadiness(state).ready, false);
  }
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
