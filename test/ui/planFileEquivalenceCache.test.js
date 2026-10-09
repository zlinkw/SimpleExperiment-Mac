const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name, source = panel) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadEquivalence() {
  const sandbox = {
    PLAN_FILE_EQUIVALENCE_CACHE_LIMIT: 2,
    EMPTY_PLAN_FILE_EQUIVALENCE_ENTRY: { keys: [], keySet: new Set() },
    planFileEquivalenceCache: new Map(),
    normalizePlanSelectionKey(value) {
      const normalized = String(value || "").trim().replace(/\\/g, "/");
      return normalized.startsWith("./") ? normalized.slice(2) : normalized;
    },
    uniqueText(values) {
      return [...new Set(values.filter(Boolean))];
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("planFileEquivalenceEntry"),
    extractFunction("planFileEquivalenceKeys"),
    extractFunction("samePlanSelection"),
    "this.keys = planFileEquivalenceKeys;",
    "this.same = samePlanSelection;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("Plan equivalence keys reuse normalized entries and stay bounded", () => {
  const sandbox = loadEquivalence();
  const first = sandbox.keys("Experiments\\Plans\\A.YAML");
  const equivalent = sandbox.keys("./experiments/plans/a.yaml");
  assert.equal(first, equivalent);
  assert.equal(first.join("|"), "experiments/plans/a.yaml|a.yaml|a");
  assert.equal(sandbox.same("plans/a.yml", "A"), true);
  assert.equal(sandbox.same("", "A"), false);

  sandbox.keys("plans/b.yaml");
  sandbox.keys("plans/c.yaml");
  assert.ok(sandbox.planFileEquivalenceCache.size <= 2);
});

test("Plan selection comparison reuses cached key sets", () => {
  const entry = extractFunction("planFileEquivalenceEntry");
  const compare = extractFunction("samePlanSelection");
  assert.match(entry, /keySet: new Set\(keys\)/);
  assert.match(entry, /PLAN_FILE_EQUIVALENCE_CACHE_LIMIT/);
  assert.doesNotMatch(compare, /new Set\(/);
  assert.match(compare, /rightEntry\.keySet\?\.has\(key\)/);
});

test("same basenames in different directories never share UI identity", () => {
  const sandbox = loadEquivalence();
  const normal = "experiments/plans/comparison/aoept.yaml";
  const tuning = "experiments/plans/comparison_tuning/aoept.yaml";
  assert.equal(sandbox.same(normal, tuning), false);
  assert.equal(sandbox.same(normal, "aoept.yaml"), false);
  assert.equal(sandbox.same(normal, "comparison/aoept.yaml"), true);
  assert.equal(sandbox.same(normal, "plans/comparison/aoept.yaml"), true);
  assert.equal(sandbox.same(tuning, "./experiments\\plans\\comparison_tuning\\AOEPT.yaml"), true);
});

test("Host resolves qualified paths first and rejects ambiguous display names", () => {
  const source = readSource("src/extension.ts");
  const sandbox = { usableSelectionKey: value => String(value || ""), uniqueStrings: values => [...new Set(values)] };
  vm.createContext(sandbox);
  vm.runInContext(["normalizePlanSelectionKey", "planFileEquivalenceKeys", "samePlanSelection", "planIdentityKeys", "resolvePlanFileFromPlanList"]
    .map(name => extractFunction(name, source)).join("\n") + "\nthis.resolve = resolvePlanFileFromPlanList; this.same = samePlanSelection;", sandbox);
  const normal = "experiments/plans/comparison/aoept.yaml";
  const tuning = "experiments/plans/comparison_tuning/aoept.yaml";
  const plans = [{ planFile: tuning, name: "aoept.yaml", planId: "tuning" }, { planFile: normal, name: "aoept.yaml", planId: "normal" }];
  assert.equal(sandbox.same(normal, tuning), false);
  assert.equal(sandbox.resolve(plans, normal), normal);
  assert.equal(sandbox.resolve(plans, "comparison_tuning/aoept.yaml"), tuning);
  assert.equal(sandbox.resolve(plans, "normal"), normal);
  assert.throws(() => sandbox.resolve(plans, "aoept.yaml"), /完整 Plan 路径/);
  assert.throws(() => sandbox.resolve(plans, "aoept.yaml", [normal]), /完整 Plan 路径/);
  assert.equal(sandbox.resolve(plans, "experiments/plans/new/aoept.yaml", [normal]), "experiments/plans/new/aoept.yaml");
  assert.equal(sandbox.resolve([plans[0]], "aoept.yaml"), tuning);
  assert.throws(() => sandbox.resolve(plans.map(({ planFile }) => ({ planFile })), "aoept"), /完整 Plan 路径/);
});
