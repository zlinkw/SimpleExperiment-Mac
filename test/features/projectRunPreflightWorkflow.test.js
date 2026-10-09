const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const renderedPanel = require("../../dist/ui/PanelHtml.js").renderPanelHtml();

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

function loadPlanExecutionStage() {
  const names = ["normalizePlanSelectionKey", "selectedPlanDistributedRun", "planExecutionStage", "planExecutionStageCacheKey", "cachePlanExecutionStage", "taskMatchesPlanVersion", "terminalPlanTaskExecutionStage", "debugRunRecord", "ensurePlanVersionRowsCache", "planVersionRowsCacheKey", "cachePlanVersionRows", "planVersionOperationRows", "planVersionTaskRows", "operationMatchesPlanVersion", "operationAtOrAfter", "operationSucceeded", "operationPending", "operationIsActive", "operationIsFailureLike", "operationIsCompleted", "operationIsCancelled", "taskStatusToken", "taskFailureLikeStatus", "taskTerminalStatus"];
  const sandbox = {
    OPERATION_ACTIVE_MATCH_TOKENS: Object.freeze(["accepted", "submitted", "pending", "queued", "running", "in_progress", "started", "progress"]),
    OPERATION_FAILURE_MATCH_TOKENS: Object.freeze(["failed", "failure", "stalled", "timeout", "unsupported", "error"]),
    TASK_FAILURE_STATUSES: new Set(["failed", "error", "stalled", "stopped", "cancelled"]),
    TASK_TERMINAL_STATUSES: new Set(["completed", "done", "archived", "deleted"]),
    PLAN_RUN_OPERATION_TYPES: new Set(["run-plan", "reproduce-plan"]),
    PLAN_EXECUTION_STAGE_CACHE_LIMIT: 64,
    planExecutionStageCacheState: null,
    planExecutionStageCache: new Map(),
    PLAN_VERSION_ROWS_CACHE_LIMIT: 64,
    planVersionRowsCacheState: null,
    planVersionOperationRowsCache: new Map(),
    planVersionTaskRowsCache: new Map(),
    planFromContext: (state) => state.plan || {},
    operationRowsForState: (state) => state.operations || [],
    schedulerRowsForState: (state) => state.tasks || [],
    samePlanSelection: (left, right) => String(left || "") === String(right || ""),
  };
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(renderedPanel, name)).join("\n") + "\nthis.result = planExecutionStage;", sandbox);
  const stage = sandbox.result;
  stage.cacheState = () => ({ state: sandbox.planExecutionStageCacheState, cache: sandbox.planExecutionStageCache });
  return stage;
}

test("project next action follows the real preflight order", () => {
  const extension = readSource("src/extension.ts");
  assert.match(panel, /function projectEndpointReadiness\(state\)/);
  assert.match(panel, /function projectCodeSyncReadiness\(state\)/);
  assert.match(extension, /await this\.ensureHubCodeReadyForPlanCheck\(body(?:, \(text\) => this\.reportPlanStage\(message, text\))?\)/);
  assert.match(extension, /await this\.ensureCodeReadyForRun\(undefined, \[body\](?:, \(text\) => this\.reportPlanStage\(message, text\))?\)/);
  const preflightStart = extension.indexOf("async runPlanPreflight(body, label, authority = {})");
  const preflightEnd = extension.indexOf("async openSetupGuide()", preflightStart);
  assert.ok(preflightStart >= 0 && preflightEnd > preflightStart);
  const preflight = extension.slice(preflightStart, preflightEnd);
  assert.ok(preflight.indexOf('postPlanSchedulerAction("validate-plan"') < preflight.indexOf('postPlanSchedulerAction("dry-run-plan"'));
  assert.match(preflight, /waitForOperationTerminalResult\("validate-plan"/);
  assert.match(preflight, /waitForOperationTerminalResult\("dry-run-plan"/);
  // LENIENT_RUN 软门禁：校验/预演失败从硬 return 改为可配置 warn+继续
  assert.match(extension, /runPlanPreflight\(body, "当前计划"(?:, \{ reportStage: \(text\) => this\.reportPlanStage\(message, text\) \})?\)/);
  {
    const hasHardReturn = /if \(!await this\.runPlanPreflight\(body, "当前计划"\)\)\s*return;/.test(extension);
    const hasLenient = /LENIENT_RUN[\s\S]*runPlanPreflight\(body, "当前计划"\)/.test(extension) || /preflightOk/.test(extension);
    assert.ok(hasHardReturn || hasLenient, "preflight blocking should exist either as hard return or lenient warn");
  }
  assert.match(extension, /if \(!await this\.runPlanPreflight\(body, `计划 \$\{planFile\}`, authority\)\)\s*throw new Error\(`计划 \$\{planFile\} 的校验或预演未返回有效结果，已停止整批提交。`\);/);
  assert.match(extension, /个计划已通过校验与预演，并提交/);
  assert.match(extension, /topology\.mode === "single_worker"[\s\S]{0,180}postWorkerTunnelAction\(workerId, action, body, options\)/);
  assert.match(extension, /endpoint\.enabled && \(hubAllowed \|\| endpoint\.role !== "hub_control"\)/);
  assert.match(extension, /当前拓扑不使用 Hub/);
  const runtime = fs.readFileSync(path.join(__dirname, "../../dist/runtime/cluster_agent.py"), "utf8");
  assert.match(runtime, /topology_mode != "single_worker"[\s\S]{0,180}localWorkerScheduler/);
});

test("Hub-only projects do not require a Worker sync status", () => {
  assert.match(panel, /const workerRequired = enabledWorkerTunnelsForState\(state\)\.length > 0/);
  assert.match(panel, /const workerReady = !workerRequired \|\| syncStatusOk\(sync\.workers\)/);
  assert.match(panel, /ready: hubReady && workerReady && fingerprintReady/);
});

test("Plan next action starts with one-click run and preserves manual recovery stages", () => {
  assert.match(panel, /function planExecutionStage\(state, planFile\)/);
  assert.match(panel, /function planPreflightSummary\(state, planFile\)/);
  assert.match(panel, /dispatchableCount: pick\(row/);
  assert.match(panel, /\["校验预演", \(preflight \|\| \{\}\)\.tone \|\| \(\(preflight \|\| \{\}\)\.ready \? "good" : "info"\),/);
  assert.doesNotMatch(panel, /\["操作终态", true/);
  assert.match(panel, /准备就绪；确认后自动同步、校验、预演并提交/);
  assert.match(panel, /label: "校验并提交运行"/);
  assert.match(panel, /校验已通过，预演调度与任务展开结果/);
  assert.match(panel, /预演已通过，可以提交正式运行/);
  assert.match(panel, /计划已提交，调度器正在排队或运行任务/);
  assert.match(panel, /command: "validatePlan"/);
  assert.match(panel, /command: "dryRunPlan"/);
  assert.match(panel, /command: "runPlan"/);
  assert.match(panel, /section: "execution"/);
  assert.match(panel, /planFile: pick\(row, \["planFile", "plan_file", "plan"\]/);
  assert.match(panel, /data\.codeSync, data\.operations, data\.resultsSummary, data\.schedulerStates, data\.capabilities/);
});

test("submitted Plan runs preserve the user's page and explicit resource navigation stays available", () => {
  assert.match(panel, /function submittedCommandTarget\(command, status\)/);
  assert.match(extractFunction(panel, "submittedCommandTarget"), /return null/);
  assert.doesNotMatch(panel, /navigateToResourceTarget\(submittedTarget\./);
  assert.match(panel, /navigateToResourceTarget\(treeTarget\.dataset\.sectionTarget, treeTarget\.dataset\.anchorTarget\)/);
});

test("editing a Plan invalidates older validation and dry-run operations", () => {
  const extension = readSource("src/extension.ts");
  assert.match(panel, /function operationMatchesPlanVersion\(row, planRevision, planUpdatedAt\)/);
  assert.match(panel, /rowRevision = String\(\(row \|\| \{\}\)\.planRevision \|\|/);
  assert.match(panel, /operationAt >= planUpdatedAt/);
  assert.match(extension, /revision: sha256Text\(String\(text \|\| ""\)\)/);
  assert.match(extension, /this\.stampPlanRevision\(body\)/);
  assert.match(extension, /planRevision = String\(body\.planRevision/);
});

test("Plan execution stage uses scoped terminal operations", () => {
  const stage = loadPlanExecutionStage();
  const planFile = "experiments/plans/smoke.yaml";
  const plan = { revision: "rev1", updatedAt: "2026-07-16T02:00:00.000Z" };
  const op = (type, status, updatedAt, planRevision = "rev1") => ({ type, status, updatedAt, planFile, planRevision });

  const fresh = stage({ plan, operations: [] }, planFile);
  assert.equal(fresh.phase, "ready");
  assert.equal(fresh.command, "runPlan");
  assert.equal(stage({ plan, operations: [op("validate-plan", "accepted", "2026-07-16T02:01:00.000Z")] }, planFile).phase, "validating");
  assert.equal(stage({ plan, operations: [op("validate-plan", "completed_with_errors", "2026-07-16T02:01:00.000Z")] }, planFile).phase, "validate");
  assert.equal(stage({ plan, operations: [op("validate-plan", "completed", "2026-07-16T02:01:00.000Z")] }, planFile).phase, "dry-run");
  assert.equal(stage({ plan, operations: [
    op("dry-run-plan", "completed", "2026-07-16T02:02:00.000Z"),
    op("validate-plan", "completed", "2026-07-16T02:01:00.000Z"),
  ] }, planFile).phase, "run");
  assert.equal(stage({ plan, operations: [
    op("run-plan", "completed", "2026-07-16T02:03:00.000Z"),
    op("dry-run-plan", "completed", "2026-07-16T02:02:00.000Z"),
    op("validate-plan", "completed", "2026-07-16T02:01:00.000Z"),
  ] }, planFile).phase, "results");
  assert.equal(stage({ plan, operations: [op("validate-plan", "completed", "2026-07-16T02:01:00.000Z", "old-revision")] }, planFile).phase, "ready");
  assert.equal(stage({ plan, operations: [{ ...op("validate-plan", "completed", "2026-07-16T02:01:00.000Z"), planFile: "other.yaml" }] }, planFile).phase, "ready");
});

test("Plan execution stage reuses bounded per-state cache entries", () => {
  const stage = loadPlanExecutionStage();
  const planFile = "experiments/plans/smoke.yaml";
  const plan = { revision: "rev1", updatedAt: "2026-07-16T02:00:00.000Z" };
  const state = { plan, operations: [] };
  const first = stage(state, `./${planFile}`);

  assert.strictEqual(stage(state, planFile.replaceAll("/", "\\")), first);
  assert.equal(stage.cacheState().cache.size, 1);

  state.plan = { revision: "rev2", updatedAt: plan.updatedAt };
  state.operations = [{ type: "validate-plan", status: "completed", updatedAt: "2026-07-16T02:01:00.000Z", planFile, planRevision: "rev2" }];
  const revised = stage(state, planFile);
  assert.notStrictEqual(revised, first);
  assert.equal(revised.phase, "dry-run");

  state.plan = { ...state.plan, updatedAt: "2026-07-16T02:02:00.000Z" };
  state.operations = [];
  const updated = stage(state, planFile);
  assert.notStrictEqual(updated, revised);
  assert.equal(updated.phase, "ready");

  const nextState = {
    plan,
    operations: [{ type: "validate-plan", status: "completed", updatedAt: "2026-07-16T02:01:00.000Z", planFile, planRevision: "rev1" }],
  };
  const next = stage(nextState, planFile);
  assert.notStrictEqual(next, first);
  assert.equal(next.phase, "dry-run");
  assert.strictEqual(stage.cacheState().state, nextState);
  assert.equal(stage.cacheState().cache.size, 1);

  const oldest = stage(nextState, "experiments/plans/cache-0.yaml");
  for (let index = 1; index <= 64; index += 1) {
    stage(nextState, `experiments/plans/cache-${index}.yaml`);
  }
  assert.equal(stage.cacheState().cache.size, 64);
  assert.notStrictEqual(stage(nextState, "experiments/plans/cache-0.yaml"), oldest);
  assert.equal(stage.cacheState().cache.size, 64);
});

test("Plan execution stage recovers from terminal scheduler tasks when operations are absent", () => {
  const stage = loadPlanExecutionStage();
  const planFile = "experiments/plans/smoke.yaml";
  const plan = { revision: "rev1", updatedAt: "2026-07-16T02:00:00.000Z" };
  const task = { planFile, planRevision: "rev1", status: "normal_completed", updatedAt: "2026-07-16T02:05:00.000Z" };
  assert.equal(stage({ plan, operations: [], tasks: [task] }, planFile).phase, "results");
  assert.equal(stage({ plan, operations: [], tasks: [{ ...task, status: "manual_interrupted_completed" }] }, planFile).phase, "review");
  assert.equal(stage({ plan, operations: [], tasks: [{ ...task, status: "running" }] }, planFile).phase, "ready");
  assert.equal(stage({ plan, operations: [], tasks: [{ ...task, planRevision: "old" }] }, planFile).phase, "ready");
  assert.equal(stage({ plan, operations: [], tasks: [{ ...task, planFile: "other.yaml" }] }, planFile).phase, "ready");
});

test("Plan next action advances from validation to dry-run, run, and monitoring", () => {
  assert.match(panel, /function planExecutionStage\(state, planFile\)/);
  assert.match(panel, /准备就绪；确认后自动同步、校验、预演并提交/);
  assert.match(panel, /校验已通过，预演调度与任务展开结果/);
  assert.match(panel, /预演已通过，可以提交正式运行/);
  assert.match(panel, /计划已提交，调度器正在排队或运行任务/);
  assert.match(panel, /command: "validatePlan"/);
  assert.match(panel, /command: "dryRunPlan"/);
  assert.match(panel, /command: "runPlan"/);
  assert.match(panel, /section: "execution"/);
  assert.match(panel, /planFile: pick\(row, \["planFile", "plan_file", "plan"\]/);
});

test("editing a Plan invalidates older validation and dry-run operations", () => {
  const extension = readSource("src/extension.ts");
  assert.match(panel, /function operationMatchesPlanVersion\(row, planRevision, planUpdatedAt\)/);
  assert.match(panel, /operationAt >= planUpdatedAt/);
  assert.match(extension, /updatedAt: stat\?\.mtime\?\.toISOString\?\.\(\)/);
  assert.match(extension, /updatedAt: stat\.mtime\?\.toISOString\?\.\(\)/);
});
