const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("action buttons are capability-driven", () => {
  const html = renderPanelHtml();
  assert.match(html, /uiCapabilityMap/);
  for (const command of ["validatePlan", "runPlan", "stopExperiment", "parseResults", "archiveArtifacts", "selfCheck", "createDebugBundle", "downloadDebugBundle", "downloadRemoteResult"]) {
    assert.match(html, new RegExp(command), command);
  }
  assert.doesNotMatch(html, /listRemoteFiles|downloadRemoteFile|uploadRemoteFile|selectRemoteFile/);
  assert.match(html, /需要升级 Hub Agent/);
  assert.match(html, /button\.disabled/);
});

test("SFTP downloads stay enabled when Agent fileDownload is absent", () => {
  const html = renderPanelHtml();
  const start = html.indexOf("function disableReason");
  const end = html.indexOf("function isRemoteAction");
  const body = html.slice(start, end);
  const sandbox = {
    SIMPLE_SFTP_GATED_COMMANDS: new Set(["downloadDebugBundle", "downloadRemoteResult"]),
    simpleSftpCommandDisableReason: (state) => state.integrations.simpleSftp.ready ? "" : state.integrations.simpleSftp.message,
    uiCapabilityReadinessForStateCommand: () => ({ keys: [], missing: [] }),
    missingNoHubWorkerResultCapabilities: () => null,
    debugModeDisableReason: () => "",
    usableTaskKey: () => "",
    isRemoteAction: () => false,
    SELECTED_PLAN_ACTION_COMMANDS: new Set(),
    PLAN_PREFLIGHT_COMMANDS: new Set(),
    SUBMITTED_RUN_COMMANDS: new Set(),
    SELECTED_PLAN_RUN_COMMANDS: new Set(),
    TASK_CONTROL_COMMANDS: new Set(),
    ARTIFACT_SCOPE_COMMANDS: new Set(),
    uniqueText: (values) => values,
    asArray: (values) => values || [],
    hasSelectedExperiment: () => false,
    hasSelectedArchive: () => false,
    projectEndpointReadiness: () => ({ ready: true, hubReady: true, missing: [], summary: "" }),
    isLenientRun: false,
    LENIENT_RUN: false,
  };
  require("node:vm").runInNewContext(body + "\nthis.reason = disableReason;", sandbox);
  const state = {
    connectionMode: "tunnel",
    debugBundlePath: "simple_cluster/debug/bundle.json",
    capabilities: { endpoints: { fileDownload: false } },
    integrations: { simpleSftp: { ready: true, message: "" } },
  };
  assert.equal(sandbox.reason(state, "downloadDebugBundle", {}), "");
  assert.equal(sandbox.reason(state, "downloadRemoteResult", {}), "");
  state.integrations.simpleSftp = { ready: false, message: "配套 SimpleSFTP 未就绪。" };
  assert.match(sandbox.reason(state, "downloadRemoteResult", {}), /SimpleSFTP/);
});
