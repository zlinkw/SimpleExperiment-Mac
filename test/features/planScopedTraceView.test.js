const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const extension = readSource("src/extension.ts");

function extractFunction(name, source = panel) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  const bodyMarker = source.indexOf(") {", start);
  const brace = bodyMarker >= 0 ? bodyMarker + 2 : source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} incomplete`);
}

function loadCompaction() {
  const sandbox = {
    EXPERIMENT_TRACE_RECORD_LIMIT: 2,
    EXPERIMENT_TRACE_ATTENTION_LIMIT: 1,
    sortExperimentTraces(rows) { return rows; },
    experimentTraceMatchesProtectedKey() { return false; },
    experimentTraceNeedsAttention() { return false; },
    experimentTraceKey(row) { return row.id; },
    normalizePlanSelectionKey(value) { return String(value || ""); },
    samePlanSelection(left, right) { return left === right; },
    experimentTraceTime(row) { return Date.parse(row.updatedAt || "") || 0; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("experimentTraceMatchesSelectedPlan", extension)}
${extractFunction("compactExperimentTraces", extension)}
this.compact = compactExperimentTraces;`, sandbox);
  return (rows, selectedPlan) => JSON.parse(JSON.stringify(sandbox.compact(rows, [], selectedPlan)));
}

function loadScope() {
  const sandbox = {
    traceRowsForPlanScopeCache: new WeakMap(),
    asArray(value) { return Array.isArray(value) ? value : []; },
    normalizePlanSelectionKey(value) { return String(value || "").replace(/\\/g, "/"); },
    planFromContext(state, context) { return state.plans.find((plan) => plan.planFile === context.planFile); },
    meaningfulValue(value) { const text = String(value || "").trim(); return text && text !== "-" ? text : ""; },
    samePlanSelection(left, right) { return String(left || "") === String(right || ""); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("traceMatchesPlanVersion")}
${extractFunction("traceRowsForPlanScope")}
this.scope = traceRowsForPlanScope;`, sandbox);
  return (rows, state, mode) => JSON.parse(JSON.stringify(sandbox.scope(rows, state, mode)));
}

test("result trace scope excludes foreign, stale, and unassigned records", () => {
  const scope = loadScope();
  const plan = { planFile: "experiments/plans/a.yaml", revision: "rev2", updatedAt: "2026-07-18T01:00:00.000Z" };
  const rows = [
    { id: "current", planFile: plan.planFile, planRevision: "rev2", updatedAt: "2026-07-18T02:00:00.000Z" },
    { id: "old", planFile: plan.planFile, planRevision: "rev1", updatedAt: "2026-07-18T02:00:00.000Z" },
    { id: "foreign", planFile: "experiments/plans/b.yaml", planRevision: "rev2", updatedAt: "2026-07-18T02:00:00.000Z" },
    { id: "legacy", planFile: "", planRevision: "", updatedAt: "2026-07-18T02:00:00.000Z" },
  ];
  const state = { plans: [plan], planFileInput: plan.planFile };
  const selected = scope(rows, state, "selected");
  assert.deepEqual(selected.rows.map((row) => row.id), ["current"]);
  assert.equal(selected.unscopedCount, 1);
  assert.equal(selected.totalCount, 4);
  assert.deepEqual(scope(rows, state, "all").rows.map((row) => row.id), ["current", "old", "foreign", "legacy"]);
  assert.equal(scope(rows, { plans: [], planFileInput: "" }, "selected").rows.length, 4);
});

test("trace UI defaults to current Plan while preserving all-record access", () => {
  assert.match(panel, /let tracePlanScope = normalizePlanViewScope\(restoredWebviewState\.tracePlanScope\)/);
  assert.match(panel, /persistWebviewState\(\{ tracePlanScope \}\)/);
  assert.match(panel, /return PLAN_VIEW_SCOPE_VALUES\.includes\(scope\) \? scope : "selected"/);
  assert.match(panel, /data-trace-plan-scope="selected"/);
  assert.match(panel, /data-trace-plan-scope="all"/);
  assert.match(panel, /event\.target\.closest\("button\[data-trace-plan-scope\]"\)/);
  assert.match(panel, /handleTracePlanScopeClick\(tracePlanScopeTarget\)/);
  assert.doesNotMatch(panel, /bindTracePlanScopeControls/);
  assert.match(panel, /当前 Plan 暂无实验记录；可切换“全部记录”/);
  assert.match(panel, /traceRowsForPlanScope\(experimentTraceRowsForState\(state\), state, "selected"\)/);
  assert.match(panel, /planFile: pick\(row, \["planFile", "plan_file", "plan"\]/);
  assert.match(panel, /data-plan-file="' \+ escAttr\(planFile\)/);
  assert.match(panel, /旧记录缺少所属 Plan；可查看记录，但不能安全执行结果、归档或删除操作/);
  assert.match(panel, /记录属于旧 Plan 版本；可查看历史，但不能作为当前版本结果执行操作/);
});

test("webview trace compaction retains the selected current Plan revision", () => {
  const compact = loadCompaction();
  const rows = [
    { id: "foreign", planFile: "b.yaml", planRevision: "rev2" },
    { id: "old", planFile: "a.yaml", planRevision: "rev1" },
    { id: "current", planFile: "a.yaml", planRevision: "rev2" },
  ];
  const result = compact(rows, { planFile: "a.yaml", planRevision: "rev2" });
  assert.equal(result[0].id, "current");
  assert.ok(result.some((row) => row.id === "current"));
  assert.match(extension, /cachedExperimentTracesProjection\(traceRoot, offlineSnapshot\?\.experimentTraces/);
  assert.match(extension, /compactExperimentTracesForPanel\(traceRoot, offlineSnapshot\?\.experimentTraces/);
});
