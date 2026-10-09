const test = require("node:test");
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
  assert.match(configFlow, /affectsConfiguration\("simpleExperiment\.topologyMode"\)/);
  assert.match(configFlow, /applyTopologyRuntimeMode\(this\.projectTopologyAssessment\(\)\.mode/);
});

test("stale result requests cannot repopulate caches after topology switch", () => {
  const manualStart = extension.indexOf("async refreshResultsSummary(planHint");
  const realtimeStart = extension.indexOf("async refreshResultsSummaryFromRealtime");
  const manual = extension.slice(manualStart, extension.indexOf("scheduleResultsSummaryRefreshFromRealtime", manualStart));
  assert.match(manual, /const client = this\.client/);
  assert.match(manual, /client\.getResultsSummary\(planFile,\s*\{\s*userInitiated:\s*true\s*\}\)/);
  assert.match(manual, /client !== this\.client/);
  assert.match(manual, /generation === this\.projectContextGeneration && client === this\.client/);

  const realtime = extension.slice(realtimeStart, extension.indexOf("scheduleResultsSummaryBudgetRetryFromRealtime(", realtimeStart));
  assert.match(realtime, /void reason/);
  assert.match(realtime, /void dirtyKey/);
  assert.doesNotMatch(realtime, /getResultsSummary\(|this\.resultsSummary\s*=/);
  const snapshotStart = extension.indexOf("async manualSnapshot()");
  const snapshot = extension.slice(snapshotStart, extension.indexOf("async manualGpuSnapshot()", snapshotStart));
  assert.match(snapshot, /const client = this\.client/);
  assert.match(snapshot, /client\.getSnapshot\(\)/);
  assert.match(snapshot, /client !== this\.client/);
});

test("endpoint probes cannot publish after topology or tunnel client changes", () => {
  const tunnelStart = extension.indexOf("async testTunnel(userInitiated");
  const tunnel = extension.slice(tunnelStart, extension.indexOf("async runXshellRealIntegrationCheck", tunnelStart));
  assert.match(tunnel, /const authorityClient = this\.client/);
  assert.ok([...tunnel.matchAll(/authorityClient !== this\.client/g)].length >= 3);
  assert.ok(tunnel.indexOf("authorityClient !== this.client") < tunnel.indexOf("this.lastProbe = probe"));

  const integrationStart = extension.indexOf("async runXshellRealIntegrationCheck");
  const integration = extension.slice(integrationStart, extension.indexOf("async restartRealtimeStream", integrationStart));
  assert.match(integration, /const authorityClient = this\.client/);
  assert.ok([...integration.matchAll(/authorityClient !== this\.client/g)].length >= 4);
  assert.ok(integration.indexOf("authorityClient !== this.client") < integration.indexOf("this.lastIntegrationReport = result.report"));
});

test("settings and overview render topology ownership without active Hub controls", () => {
  assert.match(panel, /data-command="saveTopologyMode" data-config-scope="topology"/);
  assert.match(panel, /taskDetailLine\("调度所有者", esc\(topology\.schedulerOwner/);
  assert.match(panel, /taskDetailLine\("状态与结果", esc\(topology\.stateOwner/);
  assert.match(panel, /if \(hubParticipates\) cards\.push/);
  assert.match(panel, /Hub 不参与当前模式/);
  assert.match(panel, /当前模式不访问 Hub/);
  assert.match(panel, /无自动备份/);
  assert.match(panel, /data-topology-mode="' \+ escAttr\(noHubMode\) \+ '"[^>]*>停用 Hub/);
  assert.match(panel, /data-topology-mode="hub_worker"[^>]*>恢复 Hub/);
  assert.match(panel, /if \(button\.dataset\.topologyMode\) patch\.mode = button\.dataset\.topologyMode/);
  assert.match(panel, /hubParticipates \? "启动全部隧道" : "启动 Worker 隧道"/);
  assert.match(panel, /hubParticipates \? "检测全部" : "检测 Worker"/);
  assert.match(panel, /serverObjectSummaryItem\("模式", topology\.modeLabel \|\| topologyModeLabel\(topology\.mode\), topology\.schedulerOwner \|\| "尚未确认"\)/);
  assert.match(panel, /serverObjectSummaryItem\("启用 Worker", enabledWorkers\.length \+ "\/" \+ workers\.length, "Worker"\)/);
  assert.match(panel, /topology\.mode === "worker_pool" \? "人工选择 Plan 目标"/);
  assert.match(panel, /每个 Plan 人工选择一台 Worker，由该 Worker 独立调度完整 Plan/);
  assert.doesNotMatch(panel, /独立分片调度/);
  assert.doesNotMatch(panel, /确定性任务分片/);
});

test("topology command is registered on both sides of the webview boundary", () => {
  assert.match(extension, /case "saveTopologyMode":\s*await this\.saveTopologyModeFromUi\(message\)/);
  assert.match(extension, /SAFE_WEBVIEW_COMMANDS = new Set\(\[[\s\S]*"saveTopologyMode"/);
  assert.match(panel, /webviewHandledCommands = new Set\(\[[\s\S]*"saveTopologyMode"/);
  assert.match(panel, /saveTopologyMode: "保存项目拓扑模式"/);
});
