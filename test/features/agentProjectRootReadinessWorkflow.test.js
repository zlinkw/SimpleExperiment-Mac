const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const probeSource = readSource("src/tunnel/XshellTunnelPortProbe.ts");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadAgentRootHelpers() {
  const sandbox = { ApiWorkflow_1: require("../../dist/features/ApiWorkflow"), ENDPOINT_READY_PROBE_STATUSES: new Set(["ok", "file_api_unavailable"]) };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(extension, "normalizeAgentProjectRoot"),
    extractFunction(extension, "enforceExpectedAgentProjectRoot"),
    extractFunction(extension, "assertAgentProjectProbeReady"),
    "this.api = { normalizeAgentProjectRoot, enforceExpectedAgentProjectRoot, assertAgentProjectProbeReady };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

function loadEndpointReadiness() {
  const sandbox = {
    HUB_OPERATION_READY_STATUS_TOKENS: new Set(["agent_ok", "ok", "file_api_unavailable"]),
    EMPTY_WORKER_TUNNELS_FOR_ALIAS: [],
    enabledWorkerTunnelsCacheSource: null,
    enabledWorkerTunnelsCacheValue: [],
    projectEndpointReadinessCacheState: null,
    projectEndpointReadinessCacheValue: null,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(panel, "enabledWorkerTunnelsForState"),
    extractFunction(panel, "projectEndpointReadiness"),
    "this.check = projectEndpointReadiness;",
  ].join("\n"), sandbox);
  return sandbox.check;
}

test("Agent project roots normalize separators and trailing slashes", () => {
  const { normalizeAgentProjectRoot } = loadAgentRootHelpers();
  assert.equal(normalizeAgentProjectRoot("/remote//experiments/project/"), "/remote/experiments/project");
  assert.equal(normalizeAgentProjectRoot("/remote/中文 Project "), "/remote/中文 Project ");
  for (const invalid of [" /remote/project", "C:\\Experiments\\Project\\", "/", "/remote/../project"])
    assert.equal(normalizeAgentProjectRoot(invalid), "");
});

test("matching roots pass while missing or stale roots become a dedicated mismatch", () => {
  const { enforceExpectedAgentProjectRoot, assertAgentProjectProbeReady } = loadAgentRootHelpers();
  const matching = enforceExpectedAgentProjectRoot({ status: "ok", projectRoot: "/remote/project/" }, "/remote//project", "Hub");
  assert.equal(matching.status, "ok");
  assert.equal(matching.expectedProjectRoot, "/remote/project");
  for (const projectRoot of ["", "/remote/old-project"]) {
    const checked = enforceExpectedAgentProjectRoot({ status: "ok", projectRoot }, "/remote/new-project", "Hub");
    assert.equal(checked.status, "agent_project_mismatch");
    assert.equal(checked.expectedProjectRoot, "/remote/new-project");
    assert.match(checked.suggestion, /准备 Agent 并启动/);
    assert.throws(() => assertAgentProjectProbeReady(checked, "/remote/new-project", "Hub"), /当前项目目录与本工作区不一致/);
  }
  const stale = enforceExpectedAgentProjectRoot({ status: "file_api_unavailable", projectRoot: "/remote/project-a" }, "/remote/project-b", "Hub");
  const restored = enforceExpectedAgentProjectRoot(stale, "/remote/project-a", "Hub");
  assert.equal(restored.status, "file_api_unavailable");
  assert.equal(restored.projectRootValidatedStatus, undefined);
});

test("Agent root gates reuse fixed endpoint readiness statuses", () => {
  assert.match(extension, /const AGENT_READY_HEALTH_STATES = new Set\(\["agent_ok", "file_api_unavailable"\]\)/);
  assert.match(extension, /const ENDPOINT_READY_PROBE_STATUSES = new Set\(\["ok", "file_api_unavailable"\]\)/);
  assert.match(extractFunction(extension, "enforceExpectedAgentProjectRoot"), /ENDPOINT_READY_PROBE_STATUSES\??\.has\(validatedStatus\)/);
  assert.match(extractFunction(extension, "assertAgentProjectProbeReady"), /ENDPOINT_READY_PROBE_STATUSES\.has/);
  assert.doesNotMatch(extension, /\["ok", "file_api_unavailable"\]\.includes/);
});

test("Hub-only checks and execution checks use different endpoint scopes", () => {
  const handlerStart = extension.indexOf("async handleMessageCore(message");
  const validateStart = extension.indexOf("if (PLAN_PREFLIGHT_COMMANDS.has(command))", handlerStart);
  const runStart = extension.indexOf("if (PLAN_SUBMISSION_COMMANDS.has(command))", validateStart);
  assert.ok(handlerStart >= 0 && validateStart > handlerStart && runStart > validateStart);
  const validateGuard = extension.slice(validateStart, runStart);
  const runGuard = extension.slice(runStart, runStart + 5000);
  const runAll = extension.slice(extension.indexOf("async runAllPlansFromUi()"), extension.indexOf("async generatePlanGuideFromUi("));
  assert.match(validateGuard, /assertPlanSchedulerAgentReady\(command,\s*body\)/);
  assert.doesNotMatch(validateGuard, /assertExecutionAgentProjectsReady\(\)/);
  assert.match(runGuard, /assertExecutionAgentProjectsReady\(body\)/);
  assert.match(runAll, /assertExecutionAgentProjectsReady\(candidate\.body\)/);
  assert.ok(runAll.indexOf("assertExecutionAgentProjectsReady(candidate.body)") < runAll.indexOf("confirmPlanBatchRunSubmission"));
  const applySetup = extension.slice(extension.indexOf("async applySetupDraft(patch, options = {})"), extension.indexOf("currentUiLayoutState()"));
  assert.match(applySetup, /enforceExpectedAgentProjectRoot\(this\.lastProbe/);
  assert.match(applySetup, /enforceExpectedAgentProjectRoot\(this\.lastWorkerProbes\[worker\.id\]/);
});

test("probe and webview compaction retain actual and expected project roots", () => {
  assert.match(probeSource, /const projectRoot = String\(health\.projectRoot \|\| ""\)\.trim\(\)/);
  assert.match(probeSource, /healthOk: true, projectRoot/);
  const compactHub = extractFunction(extension, "compactProbeForWebview");
  const compactWorker = extractFunction(extension, "compactWorkerProbeForWebview");
  assert.match(compactHub, /projectRoot: probe\.projectRoot/);
  assert.match(compactHub, /expectedProjectRoot: probe\.expectedProjectRoot/);
  assert.match(compactWorker, /projectRoot: probe\.projectRoot/);
  assert.match(compactWorker, /expectedProjectRoot: probe\.expectedProjectRoot/);
  assert.match(extension, /probe\.status === "agent_project_mismatch" \? "agent_project_mismatch"/);
});
