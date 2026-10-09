const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadStateReadiness() {
  const sandbox = {
    EMPTY_SERVER_SETUP: Object.freeze({}),
    EMPTY_AGENT_PREPARATION_BLOCKERS: Object.freeze([]),
    EMPTY_WORKER_TUNNELS_FOR_ALIAS: [],
    enabledWorkerTunnelsCacheSource: null,
    enabledWorkerTunnelsCacheValue: [],
    serverSetupReadinessCacheSetup: null,
    serverSetupReadinessCacheWorkers: null,
    serverSetupReadinessCacheValue: null,
    executionWorkerReadinessCacheWorkers: null,
    executionWorkerReadinessCacheValue: null,
    agentPreparationBlockersCacheSource: null,
    agentPreparationBlockersCacheValue: null,
    meaningfulValue: (value) => String(value || "").trim().length > 0,
    uniqueText: (values) => [...new Set(values)],
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("enabledWorkerTunnelsForState"),
    extractFunction("serverSetupReadiness"),
    extractFunction("executionWorkerReadiness"),
    extractFunction("agentPreparationBlockersFromState"),
    "this.serverReadiness = serverSetupReadiness;",
    "this.workerReadiness = executionWorkerReadiness;",
    "this.preparationBlockers = agentPreparationBlockersFromState;",
  ].join("\n"), sandbox);
  return sandbox;
}

function loadCapabilityReadiness() {
  const sandbox = {
    EMPTY_CAPABILITY_SOURCE: Object.freeze({}),
    uiCapabilityMap: {
      runPlan: ["actions.run-plan"],
      downloadDebugBundle: [],
    },
    uiCapabilityReadinessCacheKey: "",
    uiCapabilityReadinessCache: new Map(),
    objectReferenceIds: new WeakMap(),
    nextObjectReferenceId: 1,
    capabilityChecks: 0,
    hasCapability(state, key) {
      sandbox.capabilityChecks += 1;
      const capabilities = state.capabilities || {};
      const endpoints = capabilities.endpoints || {};
      if (key === "endpoints.fileDownload") return Boolean(endpoints.fileDownload || (state.fileCapabilities || {}).supportsDownload);
      if (key.startsWith("actions.")) return Boolean(endpoints.actions && (capabilities.actionEndpoints || {})[key.slice("actions.".length)] === true);
      return false;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("objectReferenceKey"),
    extractFunction("refListKey"),
    extractFunction("uiCapabilityReadinessForStateCommand"),
    "this.readiness = uiCapabilityReadinessForStateCommand;",
  ].join("\n"), sandbox);
  return sandbox;
}

function loadDisableReason() {
  const sandbox = {
    runMode: "formal",
    DEBUG_MODE_BLOCKED_UI_COMMANDS: new Set(["clearLegacyTasks"]),
    TASK_CONTROL_COMMANDS: new Set(["stopExperiment", "retryExperiment"]),
    PLAN_PREFLIGHT_COMMANDS: new Set(["validatePlan", "dryRunPlan"]),
    SELECTED_PLAN_RUN_COMMANDS: new Set(["runPlan", "reproducePlan"]),
    SELECTED_PLAN_ACTION_COMMANDS: new Set(["validatePlan", "dryRunPlan", "runPlan", "reproducePlan"]),
    SUBMITTED_RUN_COMMANDS: new Set(["runPlan", "reproducePlan", "runAllPlans"]),
    ARTIFACT_SCOPE_COMMANDS: new Set(["archiveArtifacts", "deleteArtifacts"]),
    usableTaskKey: (value) => Boolean(value),
    isRemoteAction: () => false,
    simpleSftpCommandDisableReason: () => "",
    uiCapabilityReadinessForStateCommand: () => ({ keys: [], missing: [] }),
    missingNoHubWorkerResultCapabilities: () => null,
    hasRealtimeSignal: () => false,
    hasAnyTunnelSession: () => true,
    serverSetupReadiness: () => ({ ready: true }),
    agentPreparationBlockersFromState: () => [],
    hasSelectedPlan: () => true,
    asArray: (value) => (Array.isArray(value) ? value : []),
    planFromContext: () => ({}),
    planActiveRunEvidence: () => ({ active: false }),
    executionWorkerReadiness: () => ({ ready: true }),
    projectEndpointReadiness: () => ({ ready: true, hubReady: true, missing: [], summary: "" }),
    projectOutputGateReason: () => "",
    uniqueText: (values) => [...new Set(values)],
    hasSelectedExperiment: () => false,
    hasSelectedArchive: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("debugModeBlockedUiCommand"),
    extractFunction("debugModeDisableReason"),
    extractFunction("disableReason"),
    "this.reason = disableReason;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("server, Worker, and Agent readiness reuse state-only derivations", () => {
  const sandbox = loadStateReadiness();
  let reads = 0;
  const worker = {
    get enabled() { reads += 1; return true; },
    get displayName() { reads += 1; return "Worker A"; },
    get savedSessionPath() { reads += 1; return "worker.xsh"; },
    get agentProjectDir() { reads += 1; return "/srv/project"; },
  };
  const setup = { savedSessionPath: "hub.xsh", agentProjectDir: "/srv/project", workerTunnels: [worker] };
  const state = { setup, agentSessions: { preparationBlockers: ["端口冲突", "端口冲突"] } };

  const firstServer = sandbox.serverReadiness(state);
  const firstReads = reads;
  assert.equal(firstServer.ready, true);
  assert.equal(sandbox.serverReadiness(state), firstServer);
  assert.equal(reads, firstReads);

  const firstWorker = sandbox.workerReadiness(state);
  assert.equal(firstWorker.ready, true);
  assert.equal(sandbox.workerReadiness(state), firstWorker);

  const firstBlockers = sandbox.preparationBlockers(state);
  assert.deepEqual(Array.from(firstBlockers), ["端口冲突"]);
  assert.equal(sandbox.preparationBlockers(state), firstBlockers);
});

test("state-only readiness invalidates when setup, Worker, or blocker sources are replaced", () => {
  const sandbox = loadStateReadiness();
  const worker = { enabled: true, displayName: "Worker A", savedSessionPath: "worker.xsh", agentProjectDir: "/srv/project" };
  const firstState = { setup: { savedSessionPath: "hub.xsh", agentProjectDir: "/srv/project", workerTunnels: [worker] }, agentSessions: { preparationBlockers: ["旧阻断"] } };
  const firstServer = sandbox.serverReadiness(firstState);
  const firstWorker = sandbox.workerReadiness(firstState);
  const firstBlockers = sandbox.preparationBlockers(firstState);

  const nextState = { setup: { savedSessionPath: "", agentProjectDir: "/srv/project", workerTunnels: [] }, agentSessions: { preparationBlockers: ["新阻断"] } };
  const nextServer = sandbox.serverReadiness(nextState);
  const nextWorker = sandbox.workerReadiness(nextState);
  const nextBlockers = sandbox.preparationBlockers(nextState);
  assert.notEqual(nextServer, firstServer);
  assert.equal(nextServer.ready, false);
  assert.notEqual(nextWorker, firstWorker);
  assert.equal(nextWorker.ready, false);
  assert.notEqual(nextBlockers, firstBlockers);
  assert.deepEqual(Array.from(nextBlockers), ["新阻断"]);
});

test("command capability gaps cache per source identity and invalidate on nested source replacement", () => {
  const sandbox = loadCapabilityReadiness();
  const state = {
    capabilities: { endpoints: { actions: true }, actionEndpoints: { "run-plan": true } },
    fileCapabilities: { supportsDownload: false },
  };

  const first = sandbox.readiness(state, "runPlan");
  assert.deepEqual(Array.from(first.missing), []);
  assert.equal(sandbox.capabilityChecks, 1);
  assert.equal(sandbox.readiness(state, "runPlan"), first);
  assert.equal(sandbox.capabilityChecks, 1);

  state.capabilities.endpoints = { actions: true };
  state.capabilities.actionEndpoints = { "run-plan": false };
  const replacedNestedSources = sandbox.readiness(state, "runPlan");
  assert.notEqual(replacedNestedSources, first);
  assert.deepEqual(Array.from(replacedNestedSources.missing), ["actions.run-plan"]);
  assert.equal(sandbox.capabilityChecks, 2);

  const readyDownload = sandbox.readiness(state, "downloadDebugBundle");
  assert.deepEqual(Array.from(readyDownload.missing), []);
});

test("final disable reasons keep run mode and operation context live", () => {
  const sandbox = loadDisableReason();
  assert.equal(sandbox.reason({}, "clearLegacyTasks", {}), "");
  sandbox.runMode = "debug";
  assert.match(sandbox.reason({}, "clearLegacyTasks", {}), /Debug 模式禁止/);

  sandbox.runMode = "formal";
  assert.equal(sandbox.reason({}, "stopExperiment", {}), "请先在任务表勾选实验");
  assert.equal(sandbox.reason({}, "stopExperiment", { runKey: "run-1" }), "");

  const readinessSource = extractFunction("featureReadinessRow");
  assert.doesNotMatch(readinessSource, /simpleSftpCommandDisableReason/);
  assert.match(readinessSource, /disableReason\(state, command, \{\}\)/);
});
