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

// Minimal sandbox that reproduces the baseline.yaml scenario:
//  - Hub 报告了 validate-plan 能力，但未上报 dry-run-plan 能力键
//  - plans/recentPlans 列表为空，但用户已选择 baseline.yaml（planFileInput 有值）
//  - Hub/Worker 可达，SimpleSFTP 就绪
function loadDisableReason(opts) {
  const actionEndpoints = opts.actionEndpoints || {};
  const hasPlanInput = opts.hasPlanInput !== false;
  const isLenient = opts.isLenient !== undefined ? Boolean(opts.isLenient) : true;
  const sandbox = {
    LENIENT_RUN: isLenient,
    isLenientRun: isLenient,
    runMode: "formal",
    DEBUG_MODE_BLOCKED_UI_COMMANDS: new Set(["clearLegacyTasks"]),
    TASK_CONTROL_COMMANDS: new Set(["stopExperiment", "retryExperiment"]),
    PLAN_PREFLIGHT_COMMANDS: new Set(["validatePlan", "dryRunPlan"]),
    SELECTED_PLAN_ACTION_COMMANDS: new Set(["validatePlan", "dryRunPlan", "runPlan", "reproducePlan"]),
    SELECTED_PLAN_RUN_COMMANDS: new Set(["runPlan", "reproducePlan"]),
    SUBMITTED_RUN_COMMANDS: new Set(["runPlan", "reproducePlan", "runAllPlans"]),
    ARTIFACT_SCOPE_COMMANDS: new Set(["archiveArtifacts", "deleteArtifacts"]),
    usableTaskKey: (value) => Boolean(value),
    isRemoteAction: () => false,
    simpleSftpCommandDisableReason: () => "",
    uiCapabilityReadinessForStateCommand(state, command) {
      const key = command === "validatePlan" ? "actions.validate-plan" : command === "dryRunPlan" ? "actions.dry-run-plan" : null;
      const keys = key ? [key] : [];
      const missing = key && actionEndpoints[key] !== true ? [key] : [];
      return { keys, missing };
    },
    missingNoHubWorkerResultCapabilities: () => null,
    hasRealtimeSignal: () => false,
    hasAnyTunnelSession: () => true,
    serverSetupReadiness: () => ({ ready: true }),
    agentPreparationBlockersFromState: () => [],
    hasSelectedPlan: () => hasPlanInput,
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

test("dryRun 与 validate 在 Hub 仅上报 validate-plan 时门禁一致", () => {
  // Hub 报告 validate-plan，但未上报 dry-run-plan（旧/不一致能力面）
  const sandbox = loadDisableReason({ actionEndpoints: { "actions.validate-plan": true } });
  const state = { capabilities: { endpoints: { actions: true }, actionEndpoints: { "actions.validate-plan": true } } };
  assert.equal(sandbox.reason(state, "validatePlan", {}), "", "validate 应可点击");
  assert.equal(sandbox.reason(state, "dryRunPlan", {}), "", "dryRun 应与 validate 一致可点击");
});

test("dryRun 在 validate 能力也缺失时仍被正确拦截", () => {
  const state = { capabilities: { endpoints: { actions: true }, actionEndpoints: {} } };
  // LENIENT 宽松门禁：能力缺失转为软告警，validate/dryRun 同为可点（同色），不硬拦截
  const sandboxLenient = loadDisableReason({ actionEndpoints: {}, isLenient: true });
  assert.equal(sandboxLenient.reason(state, "validatePlan", {}), "", "LENIENT 校验应软放行");
  assert.equal(sandboxLenient.reason(state, "dryRunPlan", {}), "", "LENIENT 预演应软放行，与校验同色");
  // 严格模式仍保持硬拦截，用于回归校验
  const sandboxStrict = loadDisableReason({ actionEndpoints: {}, isLenient: false });
  const validateReason = sandboxStrict.reason(state, "validatePlan", {});
  const dryRunReason = sandboxStrict.reason(state, "dryRunPlan", {});
  assert.ok(validateReason, "validate 缺失能力应被拦截");
  assert.ok(dryRunReason, "dryRun 缺失能力应同样被拦截");
  assert.match(dryRunReason, /Hub Agent|validate-plan/);
});

test("runAllPlans 在 plans 列表为空但已选择 plan 时不应置灰", () => {
  const sandbox = loadDisableReason({ hasPlanInput: true, actionEndpoints: { "actions.run-plan": true } });
  const state = {
    capabilities: { endpoints: { actions: true }, actionEndpoints: { "actions.run-plan": true } },
    plans: [],
    recentPlans: [],
  };
  assert.equal(sandbox.reason(state, "runAllPlans", {}), "", "已选 plan 时 runAllPlans 应可点击");
});

test("runAllPlans 在 plans 列表为空且未选择 plan 时仍被拦截", () => {
  const sandbox = loadDisableReason({ hasPlanInput: false, actionEndpoints: { "actions.run-plan": true } });
  const state = {
    capabilities: { endpoints: { actions: true }, actionEndpoints: { "actions.run-plan": true } },
    plans: [],
    recentPlans: [],
  };
  assert.match(sandbox.reason(state, "runAllPlans", {}), /没有可运行的计划文件/);
});
