const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  const brace = panel.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`${name} incomplete`);
}

function loadReadiness(raw = false) {
  const sandbox = {
    CURRENT_PLAN_RUN_EVIDENCE_CACHE_LIMIT: 64,
    PLAN_RUN_OPERATION_TYPES: new Set(["run-plan", "reproduce-plan"]),
    currentPlanRevisionRunEvidenceCacheState: null,
    currentPlanRevisionRunEvidenceCache: new Map(),
    resultAutoParseReadinessCacheState: null,
    resultAutoParseReadinessCacheSummary: null,
    resultAutoParseReadinessCacheValue: null,
    meaningfulValue(value) {
      const text = String(value === undefined || value === null ? "" : value).trim();
      return text && text !== "-" ? text : "";
    },
    pick(item, keys, fallback) {
      for (const key of keys) {
        if (item && item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
      }
      return fallback;
    },
    planFromContext(state, context) {
      return state.plans.find((plan) => plan.planFile === context.planFile);
    },
    samePlanSelection(left, right) { return String(left || "") === String(right || ""); },
    resultSummaryMatchesPlanVersion(summary, revision) {
      return String(summary.planRevision || "") === revision;
    },
    operationRowsForState(state) { return state.operations || []; },
    schedulerRowsForState(state) { return state.schedulerStates || []; },
    operationMatchesPlanVersion(row, revision) { return !row.planRevision || row.planRevision === revision; },
    taskMatchesPlanVersion(row, revision) { return !row.planRevision || row.planRevision === revision; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("normalizePlanSelectionKey")}
${extractFunction("cacheCurrentPlanRevisionRunEvidence")}
${extractFunction("currentPlanRevisionRunEvidenceForState")}
${extractFunction("resultAutoParseReadinessForState")}
this.readiness = resultAutoParseReadinessForState;`, sandbox);
  if (raw) return sandbox;
  return (state, summary) => JSON.parse(JSON.stringify(sandbox.readiness(state, summary)));
}

test("result auto parse readiness distinguishes current revision evidence", () => {
  const readiness = loadReadiness();
  const plan = { planFile: "experiments/plans/demo.yaml", revision: "rev2", updatedAt: "2026-07-18T01:00:00.000Z" };
  const base = { plans: [plan], planFileInput: plan.planFile, operations: [], schedulerStates: [] };

  assert.equal(readiness(base, {}).status, "waiting-run");
  assert.equal(readiness({ ...base, operations: [{ type: "run-plan", planFile: plan.planFile, planRevision: "rev1", submissionAccepted: true }] }, {}).status, "waiting-run");
  assert.equal(readiness({ ...base, operations: [{ type: "run-plan", planFile: plan.planFile, planRevision: "rev2", submissionAccepted: true }] }, {}).status, "run-evidence");
  assert.equal(readiness({ ...base, schedulerStates: [{ planFile: plan.planFile, planRevision: "rev2", status: "running" }] }, {}).status, "run-evidence");
  assert.equal(readiness(base, { planFile: plan.planFile, planRevision: "rev2", lastParsedAt: "2026-07-18T02:00:00.000Z" }).status, "parsed");
  assert.equal(readiness(base, { planFile: "experiments/plans/other.yaml", planRevision: "rev2", lastParsedAt: "2026-07-18T02:00:00.000Z" }).status, "waiting-run");
  assert.equal(readiness({ plans: [], planFileInput: "" }, {}).status, "no-plan");
});

test("results section refreshes when Plan or scheduler evidence changes", () => {
  const start = panel.indexOf("function sectionDependencyKey(");
  const end = panel.indexOf("function sectionLocalPreKey(", start);
  const dependency = panel.slice(start, end);
  assert.match(dependency, /section === "results"[\s\S]*data\.plans[\s\S]*data\.resultsSummary[\s\S]*data\.operations[\s\S]*data\.schedulerStates/);
  assert.match(panel, /autoParseReadiness: resultAutoParseReadinessForState\(data, data\.resultsSummary \|\| \{\}\)/);
  assert.match(panel, /resultEvidenceWorkbenchCacheKeyFor\(summary, traceStats, outputContractCheck, analysisArtifacts, autoParseReadiness\)/);
});

test("result auto parse readiness reuses one derivation per state and summary", () => {
  const sandbox = loadReadiness(true);
  const plan = { planFile: "experiments/plans/demo.yaml", revision: "rev2", updatedAt: "2026-07-18T01:00:00.000Z" };
  const state = { plans: [plan], planFileInput: plan.planFile, operations: [], schedulerStates: [] };
  const summary = {};
  const first = sandbox.readiness(state, summary);
  assert.equal(sandbox.readiness(state, summary), first);
  assert.notEqual(sandbox.readiness({ ...state }, summary), first);
  assert.notEqual(sandbox.readiness(state, { ...summary }), first);
});
