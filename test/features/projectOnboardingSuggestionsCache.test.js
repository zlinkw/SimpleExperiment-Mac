const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadSuggestions() {
  const sandbox = {
    EMPTY_PROJECT_ONBOARDING_SELECTION_PROJECT: Object.freeze({}),
    EMPTY_PROJECT_ONBOARDING_SELECTION_PLANS: Object.freeze([]),
    projectOnboardingSuggestionsForSelectionCache: null,
    suggestionCalls: 0,
    scopeCalls: 0,
    projectOnboardingSuggestions(options) {
      sandbox.suggestionCalls += 1;
      return [JSON.stringify(options)];
    },
    resolvePlanFileFromPlanList(plans, planFileInput, selectedPlanIds) {
      return String(planFileInput || selectedPlanIds[0] || "").trim();
    },
    samePlanSelection(left, right) { return String(left || "").trim() === String(right || "").trim(); },
    nestedRecord(record, key) {
      const value = record && record[key];
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    },
    arrayFromRecord(record, key) { return Array.isArray(record && record[key]) ? record[key] : []; },
    planScopedResultParsePreviews(previews, plan) {
      sandbox.scopeCalls += 1;
      return { items: previews.filter((row) => row.planFile === plan.planFile) };
    },
    planOutputEvidenceSignals(plan) { return Array.isArray(plan.outputSignals) ? plan.outputSignals : []; },
    planOutputEvidenceCandidates(plan) { return Array.isArray(plan.outputCandidates) ? plan.outputCandidates : []; },
    actionableAdapterRuleSignals(rules) { return rules.actionable === true; },
    resultPreviewHasRecords(row) { return Number(row.records || 0) > 0; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("projectOnboardingSuggestionsForSelection")}\nthis.check = projectOnboardingSuggestionsForSelection;`, sandbox);
  return sandbox;
}

function fixtures() {
  return {
    project: {
      adapterConfig: "experiments/simple_project.yaml",
      adapterRules: { actionable: false },
      resultParsePreviews: [
        { planFile: "a.yaml", records: 2 },
        { planFile: "b.yaml", records: 0 },
      ],
    },
    plans: [
      { planFile: "a.yaml", outputSignals: ["metrics"], outputCandidates: ["metrics.csv"] },
      { planFile: "b.yaml", outputSignals: ["metrics"], outputCandidates: ["metrics.csv"] },
    ],
  };
}

test("current Plan onboarding suggestions reuse stable project and selection inputs", () => {
  const sandbox = loadSuggestions();
  const { project, plans } = fixtures();
  const first = sandbox.check(project, plans, "a.yaml", "");

  assert.strictEqual(sandbox.check(project, plans, "a.yaml", ""), first);
  assert.equal(sandbox.scopeCalls, 1);
  assert.equal(sandbox.suggestionCalls, 1);
  assert.match(first[0], /"parseableResultCount":1/);

  const selected = sandbox.check(project, plans, "b.yaml", "");
  assert.notStrictEqual(selected, first);
  assert.equal(sandbox.scopeCalls, 2);
  assert.match(selected[0], /"parseableResultCount":0/);
});

test("project and Plan list replacements invalidate onboarding suggestions", () => {
  const sandbox = loadSuggestions();
  const { project, plans } = fixtures();
  const first = sandbox.check(project, plans, "a.yaml", "");
  const projectReplacement = sandbox.check({ ...project }, plans, "a.yaml", "");
  const plansReplacement = sandbox.check(project, [...plans], "a.yaml", "");

  assert.notStrictEqual(projectReplacement, first);
  assert.notStrictEqual(plansReplacement, projectReplacement);
  assert.equal(sandbox.scopeCalls, 3);
  assert.equal(sandbox.suggestionCalls, 3);
});

test("empty and unresolved Plan states remain cacheable without changing messages", () => {
  const sandbox = loadSuggestions();
  const empty = sandbox.check(undefined, undefined, "", "");
  assert.strictEqual(sandbox.check(null, null, "", ""), empty);
  assert.equal(sandbox.suggestionCalls, 1);

  const { project, plans } = fixtures();
  const unresolved = sandbox.check(project, plans, "", "");
  assert.strictEqual(sandbox.check(project, plans, "", ""), unresolved);
  assert.deepEqual(Array.from(unresolved), ["发现 2 个 Plan；请先明确选择本次要接入并运行的 Plan。"]);
  assert.equal(sandbox.scopeCalls, 0);
});

test("buildState keeps dynamic suggestions outside detected-project compaction", () => {
  const buildStateStart = extension.indexOf("private buildState(");
  const buildState = extension.slice(buildStateStart, extension.indexOf("\n    private ", buildStateStart + 1));
  assert.match(buildState, /missingOnboarding: projectOnboardingSuggestionsForSelection\(/);
  assert.match(extension, /let projectOnboardingSuggestionsForSelectionCache = null/);
});
