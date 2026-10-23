const test = require("node:test");
require("../_helpers/registerTsRequire");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "..", "..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

test("topology save is project-scoped and strongly confirmed", () => {
  const flow = extension.slice(extension.indexOf("async saveTopologyModeFromUi"), extension.indexOf("async saveHubConfigFromUi"));
  assert.match(flow, /showWarningMessage\(\[/);
  assert.match(flow, /\{ modal: true \}, "保存拓扑"/);
  assert.match(flow, /模式切换不会迁移、覆盖或删除已有任务与结果/);
  assert.match(flow, /config\.update\("topologyMode", requestedMode, vscode\.ConfigurationTarget\.WorkspaceFolder\)/);
  assert.match(flow, /applyTopologyRuntimeMode\(requestedMode, "topology saved from UI"\)/);
  assert.match(flow, /不会访问 Hub、同步到 Hub或创建跨节点自动备份/);
});

test("topology switch invalidates authority caches without deleting project records", () => {
  const start = extension.indexOf("private invalidateTopologyRuntimeCaches");
  const end = extension.indexOf("private createClient", start);
  const invalidation = extension.slice(start, end);
  assert.match(invalidation, /this\.resultsSummary = undefined/);
  assert.match(invalidation, /this\.lastRealtimeState = undefined/);
  assert.match(invalidation, /this\.lastProbe = undefined/);
  assert.match(invalidation, /this\.lastWorkerProbes = \{\}/);
  assert.match(invalidation, /this\.lastFullEndpointProbeAt = 0/);
  assert.match(invalidation, /this\.resultsSummary\.__offlineImport !== true/);
  assert.doesNotMatch(invalidation, /this\.localOperations = \{\}/);
  assert.doesNotMatch(invalidation, /this\.localPlanMetadata =/);
  assert.doesNotMatch(invalidation, /selectedRunKeys\.clear/);

  const configFlow = extension.slice(extension.indexOf("async handleConfigurationChanged"), extension.indexOf("async showFirstRunSetupPromptOnce"));
  // Mac 适配：配置键前缀为 simpleExperimentMac.*（Windows 为 simpleExperiment.*）。
  assert.match(configFlow, /affectsConfiguration\("simpleExperimentMac\.topologyMode"\)/);
  assert.match(configFlow, /applyTopologyRuntimeMode\(this\.projectTopologyAssessment\(\)\.mode/);
});

test("stale result collection cannot publish after project endpoint configuration changes", async () => {
  const f = require('../_helpers/freshResultHost').fixture();
  let release, publications = 0;
  f.host.refreshLocalResultCatalogForProject = async () => publications++;
  f.block(new Promise(resolve => {release = resolve;}));
  const pending = f.service.update();
  const rejected = assert.rejects(pending, /配置已变化|取消/);
  await new Promise(resolve => setImmediate(resolve));
  const targets = f.host.workerCodeSyncTargets();
  f.host.workerCodeSyncTargets = () => targets.map(row => ({...row,remotePath:'/new-project'}));
  release(); await rejected;
  assert.equal(publications, 0);
  const realtimeStart = extension.indexOf("async refreshResultsSummaryFromRealtime");
  const realtime = extension.slice(realtimeStart, extension.indexOf("scheduleResultsSummaryBudgetRetryFromRealtime(", realtimeStart));
  assert.match(realtime, /void reason/); assert.match(realtime, /void dirtyKey/);
  assert.doesNotMatch(realtime, /getResultsSummary\(|this\.resultsSummary\s*=/);
});

test("endpoint probes cannot publish after topology or tunnel client changes", () => {
  const tunnelStart = extension.indexOf("async testTunnel(userInitiated");
  const tunnel = extension.slice(tunnelStart, extension.indexOf("async runXshellRealIntegrationCheck", tunnelStart));
  assert.match(tunnel, /const authorityClient = this\.client/);
  assert.ok([...tunnel.matchAll(/authorityClient !== this\.client/g)].length >= 3);
  assert.ok(tunnel.indexOf("authorityClient !== this.client") < tunnel.indexOf("this.lastProbe = probe"));

  const integrationStart = extension.indexOf("async runXshellRealIntegrationCheck");
  const integration = extension.slice(integrationStart, extension.indexOf("async restartRealtimeStream", integrationStart));
  assert.match(integration, /return this\.testTunnel\(true\)/);

});

test("settings and overview expose Worker ownership without restoring retired Hub controls", () => {
  const cards = require('../_helpers/panelFunction')('renderServerCardsV2');
  assert.match(cards, /data-command="saveWorkerConfig"/);
  assert.doesNotMatch(cards, /data-command="(?:saveHubConfig|startHub)"|data-topology-mode="hub_worker"/);
  assert.match(cards, /Worker 服务器/); assert.match(cards, /saveAgentDefaults/);
  assert.match(panel, /serverObjectSummaryItem\("启用 Worker", enabledWorkers\.length \+ "\/" \+ workers\.length, "Worker"\)/);
  assert.match(panel, /每个 Plan 人工选择一台 Worker，由该 Worker 独立调度完整 Plan/);
  assert.doesNotMatch(panel, /独立分片调度|确定性任务分片/);
});

test("topology command is registered on both sides of the webview boundary", () => {
  assert.match(extension, /case "saveTopologyMode":\s*await this\.saveTopologyModeFromUi\(message\)/);
  assert.match(extension, /SAFE_WEBVIEW_COMMANDS = new Set\(\[[\s\S]*"saveTopologyMode"/);
  assert.match(panel, /webviewHandledCommands = new Set\(\[[\s\S]*"saveTopologyMode"/);
  assert.match(panel, /saveTopologyMode: "保存项目拓扑模式"/);
});
