const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("overview prioritizes an active Plan over newly introduced readiness blockers", () => {
  const start = panel.indexOf("function overviewProjectReadiness(state)");
  const end = panel.indexOf("function renderServerObjectOverview", start);
  const source = panel.slice(start, end);
  assert.match(source, /const activeRun = selectedPlan \? planActiveRunEvidence\(state, planFile, selectedPlan\)/);
  assert.match(source, /activeRun\.taskCount > 0 \? "运行中" : "提交中"/);
  assert.ok(source.indexOf("if (activeRun.active)") < source.indexOf("if (!serverReadiness.ready)"));
  assert.ok(source.indexOf("if (activeRun.active)") < source.indexOf("if (!outputGate.ok)"));
  assert.ok(source.indexOf('const terminalPhase =') < source.indexOf("const simpleSftp = simpleSftpReadinessForState(state)"));
  assert.ok(source.indexOf("PLAN_WORKFLOW_TERMINAL_PHASES.has") < source.indexOf("const simpleSftp = simpleSftpReadinessForState(state)"));
});

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = panel.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = panel.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadReadiness() {
  const sandbox = {
    overviewProjectReadinessCacheState: null,
    overviewProjectReadinessCacheValue: null,
    EMPTY_SIMPLE_SFTP_INTEGRATION: {},
    DEFAULT_SIMPLE_SFTP_READINESS: { ready: true, message: "" },
    PLAN_WORKFLOW_RUNNING_PHASES: new Set(["validating", "dry-running", "submitting", "monitor"]),
    PLAN_WORKFLOW_TERMINAL_PHASES: new Set(["results", "debug-review", "review"]),
    simpleSftpReadinessCacheSource: null,
    simpleSftpReadinessCacheValue: null,
    asArray(value) { return Array.isArray(value) ? value : []; },
    overviewProjectStats(state) { return state._stats || { plans: 0, resultSignals: 0, ready: false }; },
    planFromContext(state) { return state._selectedPlan; },
    serverSetupReadiness(state) { return state._server || { ready: false, summary: "缺少服务器" }; },
    executionWorkerReadiness(state) { return state._worker || { ready: false, summary: "未配置 Worker" }; },
    projectEndpointReadiness(state) { return state._endpoint || { ready: false, summary: "Agent 未检测" }; },
    projectOutputGateDiagnostics(project) { return project._outputGate || { ok: false, missing: ["计划输出"] }; },
    currentPlanRuntimeContractStage(state) { return state._contractStage; },
    runtimeContractStageBadge(stage) { return stage.badge || "运行缺失"; },
    runtimeContractStageMessage(stage) { return stage.message || "运行结果契约待处理"; },
    agentPreparationBlockersFromState(state) { return state._preparationBlockers || []; },
    planActiveRunEvidence(state) {
      if (state._activeRun) return state._activeRun;
      const phase = String(state._stage?.phase || "");
      return { active: ["validating", "dry-running", "submitting", "monitor"].includes(phase), taskCount: phase === "monitor" ? 1 : 0, operationCount: phase === "monitor" ? 0 : 1 };
    },
    planExecutionStage(state) { return state._stage || { phase: "ready", status: "准备就绪" }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("simpleSftpReadinessForState") + "\n" + extractFunction("overviewProjectReadiness") + "\nthis.readiness = overviewProjectReadiness;", sandbox);
  return (state) => JSON.parse(JSON.stringify(sandbox.readiness(state)));
}

function readyState() {
  const plan = { planFile: "experiments/plans/demo.yaml" };
  return {
    detectedProject: { _outputGate: { ok: true, missing: [] } },
    plans: [plan],
    planFileInput: plan.planFile,
    _selectedPlan: plan,
    _stats: { plans: 1, resultSignals: 1, ready: true },
    _server: { ready: true, summary: "服务器已配置" },
    _worker: { ready: true, summary: "1 个 Worker" },
    _endpoint: { ready: true, summary: "Hub/Worker Agent 可达" },
    _stage: { phase: "ready", status: "准备就绪；确认后自动同步、校验、预演并提交" },
  };
}

test("overview project readiness follows the real first-run gate order", () => {
  const readiness = loadReadiness();
  const base = readyState();

  assert.equal(readiness({ ...base, _server: { ready: false, summary: "缺少 Hub Xshell 会话" } }).status, "待配置服务器");
  const missingSftp = readiness({ ...base, integrations: { simpleSftp: { ready: false, message: "未安装 SimpleSFTP" } } });
  assert.equal(missingSftp.status, "待安装 SimpleSFTP");
  assert.equal(missingSftp.tone, "error");
  assert.equal(readiness({ ...base, _selectedPlan: undefined, planFileInput: "", plans: [{}, {}], _stats: { plans: 2, resultSignals: 1, ready: true } }).status, "待选择 Plan");
  assert.equal(readiness({ ...base, detectedProject: { _outputGate: { ok: false, missing: ["配置文件", "计划输出"] } } }).status, "待补输出");
  assert.equal(readiness({ ...base, _worker: { ready: false, summary: "未配置 Worker" } }).status, "待添加 Worker");
  assert.equal(readiness({ ...base, _endpoint: { ready: false, projectMismatch: true, summary: "Worker 项目不匹配" } }).status, "Agent 项目不匹配");

  const ready = readiness(base);
  assert.equal(ready.status, "可提交");
  assert.equal(ready.ready, true);
  assert.equal(ready.blocking, false);
  assert.equal(ready.tone, "good");
});

test("overview project readiness reflects execution and result phases", () => {
  const readiness = loadReadiness();
  const base = readyState();

  const running = readiness({ ...base, _stage: { phase: "monitor", status: "计划已提交，调度器正在运行" } });
  assert.equal(running.status, "运行中");
  assert.equal(running.blocking, false);
  assert.equal(running.tone, "info");

  const results = readiness({ ...base, _stage: { phase: "results", status: "进入结果解析、筛选与归档流程" } });
  assert.equal(results.status, "结果待处理");
  assert.equal(results.blocking, false);

  const review = readiness({ ...base, _stage: { phase: "review", status: "存在失败任务" } });
  assert.equal(review.status, "任务需处理");
  assert.equal(review.blocking, true);
  assert.equal(review.tone, "error");

  const staleSftp = { ...base, integrations: { simpleSftp: { ready: false, message: "未安装 SimpleSFTP" } }, _server: { ready: false, summary: "服务器配置已变化" } };
  assert.equal(readiness({ ...staleSftp, _stage: { phase: "results", status: "已有正式结果待处理" } }).status, "结果待处理");
  assert.equal(readiness({ ...staleSftp, _stage: { phase: "debug-review", status: "Debug 已完成待复核" } }).status, "历史任务待复核");
  const staleReview = readiness({ ...staleSftp, _stage: { phase: "review", status: "存在失败任务" } });
  assert.equal(staleReview.status, "任务需处理");
  assert.equal(staleReview.ready, true);
});

test("overview surfaces and render signature use real project and operation state", () => {
  const dependencyStart = panel.indexOf("function sectionDependencyKey(");
  const dependencyEnd = panel.indexOf("function sectionRenderModel(", dependencyStart);
  const dependency = panel.slice(dependencyStart, dependencyEnd);
  assert.match(dependency, /section === "plans"[\s\S]*data\.planFileInput[\s\S]*data\.selection/);
  assert.match(dependency, /section === "results"[\s\S]*data\.resultsSummary[\s\S]*data\.operations/);
  assert.match(panel, /function overviewProjectReadiness\(state\)/);
  assert.doesNotMatch(panel, /projectStats\.ready \? "可运行" : "待接入"/);
});
