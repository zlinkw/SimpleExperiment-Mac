const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractExtensionFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing extension function ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated extension function ${name}`);
}

function loadHelpers() {
  const sandbox = {
    TASK_FAILURE_STATUSES: new Set(["failed", "error", "stalled", "stopped", "cancelled"]),
    TASK_TERMINAL_STATUSES: new Set(["completed", "done", "archived", "deleted"]),
    PLAN_FILE_EQUIVALENCE_CACHE_LIMIT: 128,
    PLAN_ARCHIVE_READINESS_CACHE_LIMIT: 64,
    EMPTY_PLAN_FILE_EQUIVALENCE_ENTRY: { keys: [], keySet: new Set() },
    planFileEquivalenceCache: new Map(),
    planArchiveReadinessIndexState: null,
    planArchiveReadinessIndexSummary: null,
    planArchiveReadinessIndexResults: null,
    planArchiveReadinessIndexTasks: null,
    planArchiveReadinessIndexValue: null,
    planArchiveReadinessCache: new Map(),
    asArray: (value) => Array.isArray(value) ? value : [],
    uniqueText: (values) => [...new Set((values || []).filter(Boolean))],
    schedulerRowsForState: (state) => state.__tasks || [],
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("normalizePlanSelectionKey"),
    extractFunction("planFileEquivalenceEntry"),
    extractFunction("planFileEquivalenceKeys"),
    extractFunction("samePlanSelection"),
    extractFunction("taskStatusToken"),
    extractFunction("taskFailureLikeStatus"),
    extractFunction("taskTerminalStatus"),
    extractFunction("planArchiveRecordPlanFile"),
    extractFunction("addPlanArchiveReadinessIndexEntry"),
    extractFunction("planArchiveUiReadinessIndexForState"),
    extractFunction("planArchiveUiReadinessIndices"),
    extractFunction("cachePlanArchiveUiReadiness"),
    extractFunction("planArchiveUiReadiness"),
    "this.api = { samePlanSelection, planArchiveUiReadiness, cacheState: () => ({ index: planArchiveReadinessIndexValue, size: planArchiveReadinessCache.size }) };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

test("webview plan matching supports path, basename, and extensionless identity", () => {
  const helpers = loadHelpers();
  assert.equal(helpers.samePlanSelection("experiments/plans/demo.yaml", "demo"), true);
  assert.equal(helpers.samePlanSelection("plans/demo.yml", "demo.yaml"), true);
  assert.equal(helpers.samePlanSelection("experiments/plans/other.yaml", "demo.yaml"), false);
});

test("same-named Plan archive readiness excludes another directory's results and active jobs", () => {
  const { planArchiveUiReadiness } = loadHelpers();
  const normal = "experiments/plans/comparison/aoept.yaml";
  const tuning = "experiments/plans/comparison_tuning/aoept.yaml";
  const state = { resultsSummary: { previewCsvPath: "preview.csv", effectiveResultsCsvPath: "effective.csv",
    results: [{ planFile: normal, finalEvidenceState: "archived" }, { planFile: tuning, finalEvidenceState: "pending_review" }] },
    __tasks: [{ planFile: tuning, status: "running" }] };
  assert.equal(planArchiveUiReadiness(state, normal).ready, true);
  assert.equal(planArchiveUiReadiness(state, tuning).ready, false);
});

test("plan archive UI mirrors result and active-task backend gates", () => {
  const { planArchiveUiReadiness } = loadHelpers();
  const planFile = "experiments/plans/demo.yaml";
  assert.match(planArchiveUiReadiness({}, planFile).reason, /没有该 Plan 的已解析结果/);
  const pending = { resultsSummary: { results: [{ planFile, finalEvidenceState: "pending_review" }] } };
  assert.equal(planArchiveUiReadiness(pending, planFile).ready, false);
  assert.match(planArchiveUiReadiness(pending, planFile).reason, /至少归档一条记录/);
  const ready = { resultsSummary: {
    previewCsvPath: "simple_cluster/results/by_plan/demo/results_preview_all.csv",
    effectiveResultsCsvPath: "simple_cluster/results/by_plan/demo/results_effective_archived.csv",
    results: [
      { planFile, finalEvidenceState: "archived" },
      { planFile, finalEvidenceState: "excluded" },
      { planFile: "experiments/plans/other.yaml", finalEvidenceState: "archived" },
    ],
  } };
  assert.equal(planArchiveUiReadiness(ready, planFile).ready, true);
  assert.equal(planArchiveUiReadiness(ready, planFile).archivedCount, 1);
  assert.equal(planArchiveUiReadiness(ready, planFile).notIncludedCount, 1);
  assert.match(planArchiveUiReadiness(ready, planFile).reason, /有效结果 1 条；未纳入 1 条/);
  const active = { ...ready, __tasks: [{ planFile, status: "running" }] };
  assert.equal(planArchiveUiReadiness(active, planFile).ready, false);
  assert.match(planArchiveUiReadiness(active, planFile).reason, /仍有 1 个任务未结束/);
  for (const status of ["error", "stalled", "stopped", "cancelled", "canceled"]) {
    assert.equal(planArchiveUiReadiness({ ...ready, __tasks: [{ planFile, status }] }, planFile).ready, true, status);
  }
  const missingEvidence = { resultsSummary: { results: [{ planFile, finalEvidenceState: "archived" }] } };
  assert.equal(planArchiveUiReadiness(missingEvidence, planFile).ready, false);
  assert.match(planArchiveUiReadiness(missingEvidence, planFile).reason, /完整预览 CSV 或有效结果 CSV/);
});

test("plan archive readiness scans result and task sources once per state", () => {
  const { planArchiveUiReadiness, cacheState } = loadHelpers();
  let resultReads = 0;
  let taskReads = 0;
  const result = (planFile, finalEvidenceState) => ({
    get planFile() { resultReads += 1; return planFile; },
    finalEvidenceState,
  });
  const task = (planFile, status) => ({
    get planFile() { taskReads += 1; return planFile; },
    status,
  });
  const state = {
    resultsSummary: {
      previewCsvPath: "preview.csv",
      effectiveResultsCsvPath: "effective.csv",
      results: [result("a.yaml", "archived"), result("b.yaml", "excluded")],
    },
    __tasks: [task("a.yaml", "completed"), task("b.yaml", "running")],
  };
  const first = planArchiveUiReadiness(state, "a.yaml");
  const firstIndex = cacheState().index;
  const resultReadsAfterFirst = resultReads;
  const taskReadsAfterFirst = taskReads;
  assert.strictEqual(planArchiveUiReadiness(state, "a.yaml"), first);
  assert.equal(planArchiveUiReadiness(state, "b.yaml").activeTaskCount, 1);
  assert.strictEqual(cacheState().index, firstIndex);
  assert.equal(resultReads, resultReadsAfterFirst);
  assert.equal(taskReads, taskReadsAfterFirst);
  state.resultsSummary = { ...state.resultsSummary, results: [result("a.yaml", "archived")] };
  planArchiveUiReadiness(state, "a.yaml");
  assert.notStrictEqual(cacheState().index, firstIndex);
  for (let index = 0; index < 80; index += 1) planArchiveUiReadiness(state, `extra-${index}.yaml`);
  assert.ok(cacheState().size <= 64);
});

test("backend Plan archive gate shares complete scheduler terminal semantics", () => {
  const sandbox = {
    SCHEDULER_TERMINAL_STATUSES: new Set(["failed", "stalled", "stopped", "cancelled", "canceled", "completed", "done", "archived", "error", "deleted"]),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractExtensionFunction("schedulerStatusToken")}\n${extractExtensionFunction("schedulerStatusTerminal")}\nthis.schedulerStatusTerminal = schedulerStatusTerminal;`, sandbox);
  for (const status of ["completed", "normal_completed", "done", "failed", "completed_with_errors", "error", "stalled", "stopped", "manual_interrupted_completed", "cancelled", "canceled", "archived", "deleted"]) {
    assert.equal(sandbox.schedulerStatusTerminal(status), true, status);
  }
  assert.equal(sandbox.schedulerStatusTerminal("running"), false);
  assert.match(extension, /const active = matching\.filter\(\(row\) => !schedulerStatusTerminal\(row\.status \|\| row\.state \|\| ""\)\)/);
});

test("plan archive buttons expose the same readiness reason", () => {
  assert.match(panel, /const archiveReadiness = planArchiveUiReadiness\(state, file\)/);
  assert.match(panel, /taskMetric\("归档条件", archiveReadiness\.ready/);
  assert.match(panel, /taskMetric\("结果取舍", "有效 " \+ archiveReadiness\.archivedCount \+ " \/ 未纳入 " \+ archiveReadiness\.notIncludedCount\)/);
  assert.match(panel, /plan\.archiveResultSelectionFile/);
  assert.match(panel, /var resultSelectionMeta = plan\.archiveResultSelectionFile/);
  assert.match(panel, />结果取舍<\/button>/);
  assert.match(panel, /data\.resultsSummary, data\.schedulerStates/);
  assert.match(panel, /plan\.archiveEvidenceSourceMode === "hub_download" \? "Hub 只读同步"/);
  assert.match(panel, /迁移结果/);
  const readiness = extractFunction("planArchiveUiReadiness");
  assert.match(readiness, /planArchiveUiReadinessIndexForState/);
  assert.doesNotMatch(readiness, /\.filter\(/);
});
