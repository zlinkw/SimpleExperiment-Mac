const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");
const panel = readSource("src/ui/PanelHtml.ts");
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

function loadPlanCompaction() {
  const sandbox = {
    WEBVIEW_LOCAL_PLAN_LIMIT: 80,
    WEBVIEW_PLAN_CASE_LIMIT: 2,
    WEBVIEW_PLAN_OUTPUT_LIMIT: 2,
    WEBVIEW_LOCAL_PLAN_VARIANT_CACHE_LIMIT: 8,
    OUTPUT_CANDIDATE_CONTRACT_BASENAMES: new Set(["metrics_summary.csv", "metrics_case.csv", "stdout.log", "stderr.log"]),
    localPlansForWebviewCache: new WeakMap(),
    localPlanForWebviewCache: new WeakMap(),
    usableSelectionKey(value) { return String(value || "").trim(); },
    uniqueStrings(values) {
      const seen = new Set();
      return values.filter((value) => {
        const key = String(value || "");
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("compactLocalPlansForWebview"),
    extractFunction("compactLocalPlanForWebview"),
    extractFunction("normalizePlanSelectionKey"),
    extractFunction("planFileEquivalenceKeys"),
    extractFunction("planIdentityKeys"),
    extractFunction("compactPlanArrayForWebview"),
    extractFunction("dedupWebviewListItems"),
    extractFunction("normalizeOutputCandidateKey"),
    "this.compactPlans = compactLocalPlansForWebview;",
    "this.compactPlan = compactLocalPlanForWebview;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("Plan Webview compaction reuses equivalent inputs and invalidates changed sources", () => {
  const sandbox = loadPlanCompaction();
  const plans = [
    { planId: "a", planFile: "experiments/plans/a.yaml", text: "a" },
    { planId: "b", planFile: "experiments/plans/b.yaml", text: "b" },
  ];
  const first = sandbox.compactPlans(plans, ["a.yaml", "b.yaml"], 2);
  assert.strictEqual(sandbox.compactPlans(plans, ["b.yaml", "a.yaml"], 2), first);
  assert.notStrictEqual(sandbox.compactPlans(plans, ["a.yaml"], 2), first);
  assert.notStrictEqual(sandbox.compactPlans(plans, ["a.yaml", "b.yaml"], 1), first);
  assert.notStrictEqual(sandbox.compactPlans([...plans], ["a.yaml", "b.yaml"], 2), first);
});

test("Plan Webview compaction preserves selected text, parse errors, order, and counts", () => {
  const sandbox = loadPlanCompaction();
  const plans = [
    { planId: "first", planFile: "experiments/plans/first.yaml", text: "first" },
    { planId: "second", planFile: "experiments/plans/second.yaml", text: "second" },
    { planId: "broken", planFile: "experiments/plans/broken.yaml", text: "broken", parseError: "invalid" },
    {
      planId: "selected",
      planFile: "experiments/plans/selected.yaml",
      text: "selected yaml",
      cases: [1, 2, 3],
      outputCandidates: ["a", "b", "c"],
      outputSignals: ["x", "y", "z"],
    },
  ];
  const compacted = sandbox.compactPlans(plans, ["selected.yaml"], 2);
  assert.deepEqual(Array.from(compacted.plans, (plan) => plan.planId), ["broken", "selected"]);
  assert.equal(compacted.totalCount, 4);
  assert.equal(compacted.omittedCount, 2);
  assert.equal(compacted.plans[0].text, "");
  assert.equal(compacted.plans[0].textOmitted, true);
  assert.equal(compacted.plans[1].text, "selected yaml");
  assert.deepEqual(Array.from(compacted.plans[1].cases), [1, 2]);
  assert.equal(compacted.plans[1].casesOmittedCount, 1);
});

test("single Plan compaction caches selected and unselected variants separately", () => {
  const sandbox = loadPlanCompaction();
  const plan = { planId: "a", text: "yaml", cases: [1, 2, 3] };
  const selected = sandbox.compactPlan(plan, true);
  const unselected = sandbox.compactPlan(plan, false);
  assert.strictEqual(sandbox.compactPlan(plan, true), selected);
  assert.strictEqual(sandbox.compactPlan(plan, false), unselected);
  assert.notStrictEqual(selected, unselected);
  assert.equal(selected.text, "yaml");
  assert.equal(unselected.text, "");
  assert.equal(unselected.textOmitted, true);
});

test("Plan Webview source cache keeps only the newest bounded variants", () => {
  const sandbox = loadPlanCompaction();
  const plans = [{ planId: "a", planFile: "a.yaml", text: "a" }];
  const oldest = sandbox.compactPlans(plans, ["missing-0.yaml"], 1);
  for (let index = 1; index < 10; index += 1) {
    sandbox.compactPlans(plans, [`missing-${index}.yaml`], 1);
  }
  assert.equal(sandbox.localPlansForWebviewCache.get(plans).size, 8);
  assert.notStrictEqual(sandbox.compactPlans(plans, ["missing-0.yaml"], 1), oldest);
  assert.equal(sandbox.localPlansForWebviewCache.get(plans).size, 8);
});

test("worker onboarding status stays a compact rectangular label", () => {
  assert.match(panel, /\.serverObjectMeta \.pill \{[^}]*white-space: nowrap;[^}]*overflow-wrap: normal;[^}]*border-radius: 6px;/);
  assert.match(panel, /meta: \["待接入"\]/);
});
