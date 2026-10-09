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

function extractDeclaration(name) {
  const start = extension.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing declaration ${name}`);
  const end = extension.indexOf(";\n", start);
  assert.ok(end > start, `unterminated declaration ${name}`);
  return extension.slice(start, end + 1);
}

function loadCache() {
  const sandbox = {
    RESULTS_SUMMARY_WEBVIEW_VARIANT_CACHE_LIMIT: 3,
    resultsSummaryForWebviewCache: new WeakMap(),
    filterCalls: 0,
    compactCalls: 0,
    usableSelectionKey(value) {
      return String(value || "").trim().replace(/^\.\//, "");
    },
    filterResultsSummaryForSelectedPlan(summary, plan, revision, updatedAt) {
      sandbox.filterCalls += 1;
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) return summary;
      return { summary, plan, revision, updatedAt };
    },
    compactResultsSummaryForWebview(value) {
      sandbox.compactCalls += 1;
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return { compacted: true, ...value };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("compactResultsSummaryForPlanForWebview")}\nthis.compactForPlan = compactResultsSummaryForPlanForWebview;`, sandbox);
  return sandbox;
}

function loadActualFilterCache() {
  const sandbox = {
    RESULTS_SUMMARY_WEBVIEW_VARIANT_CACHE_LIMIT: 8,
    resultsSummaryForWebviewCache: new WeakMap(),
    compactResultsSummaryForWebview(value) {
      return value;
    },
    uniqueStrings(values) {
      return [...new Set(values)];
    },
    objectRecord(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractDeclaration("RESULT_SUMMARY_RECORD_ARRAY_FIELDS"),
    extractFunction("usableSelectionKey"),
    extractFunction("normalizePlanSelectionKey"),
    extractFunction("planFileEquivalenceKeys"),
    extractFunction("samePlanSelection"),
    extractFunction("resultRecordPlanFile"),
    extractFunction("planVersionTimestamp"),
    extractFunction("resultSummaryMatchesPlanVersion"),
    extractFunction("filterResultsSummaryForSelectedPlan"),
    extractFunction("compactResultsSummaryForPlanForWebview"),
    "this.compactForPlan = compactResultsSummaryForPlanForWebview;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("results summary Webview cache reuses one Plan version derivation", () => {
  const sandbox = loadCache();
  const summary = { results: [{ id: "a" }] };
  const first = sandbox.compactForPlan(summary, ".\\experiments\\plans\\a.yaml", "r2", "2026-07-30T00:00:00Z");
  const calls = { filter: sandbox.filterCalls, compact: sandbox.compactCalls };

  assert.strictEqual(sandbox.compactForPlan(summary, "experiments/plans/a.yaml", "r2", "2026-07-30T00:00:00Z"), first);
  assert.deepEqual({ filter: sandbox.filterCalls, compact: sandbox.compactCalls }, calls);
  assert.equal(first.plan, "experiments/plans/a.yaml");
  assert.equal(first.revision, "r2");
});

test("results summary Webview cache invalidates on source and Plan version replacement", () => {
  const sandbox = loadCache();
  const summary = { results: [{ id: "a" }] };
  const first = sandbox.compactForPlan(summary, "a.yaml", "r1", "t1");

  assert.notStrictEqual(sandbox.compactForPlan({ ...summary }, "a.yaml", "r1", "t1"), first);
  assert.notStrictEqual(sandbox.compactForPlan(summary, "a.yaml", "r2", "t1"), first);
  assert.notStrictEqual(sandbox.compactForPlan(summary, "a.yaml", "r1", "t2"), first);
});

test("results summary Webview cache keeps only bounded recent Plan variants", () => {
  const sandbox = loadCache();
  const summary = { results: [] };
  const oldest = sandbox.compactForPlan(summary, "plan-0.yaml", "r0", "t0");
  for (let index = 1; index < 5; index += 1) {
    sandbox.compactForPlan(summary, `plan-${index}.yaml`, `r${index}`, `t${index}`);
  }
  const variants = sandbox.resultsSummaryForWebviewCache.get(summary);

  assert.equal(variants.size, 3);
  assert.notStrictEqual(sandbox.compactForPlan(summary, "plan-0.yaml", "r0", "t0"), oldest);
  assert.equal(variants.size, 3);
});

test("non-object summaries preserve uncached fallback behavior", () => {
  const sandbox = loadCache();

  assert.equal(sandbox.compactForPlan(undefined, "a.yaml"), undefined);
  assert.equal(sandbox.compactForPlan(undefined, "a.yaml"), undefined);
  assert.equal(sandbox.filterCalls, 2);
  assert.equal(sandbox.compactCalls, 2);
});

test("cached result summaries preserve mixed-Plan isolation and archived counts", () => {
  const sandbox = loadActualFilterCache();
  const summary = {
    lastParsedAt: "2026-07-30T01:00:00Z",
    results: [
      { id: "a", planFile: "experiments/plans/a.yaml", finalEvidenceState: "archived" },
      { id: "a-pending", planFile: "experiments/plans/a.yaml", final_evidence_state: "pending_review" },
      { id: "b", planFile: "experiments/plans/b.yaml", finalEvidenceState: "pending_review" },
    ],
  };
  const result = sandbox.compactForPlan(summary, "a.yaml", "", "2026-07-30T00:00:00Z");

  assert.deepEqual(Array.from(result.results, (row) => row.id), ["a", "a-pending"]);
  assert.deepEqual(Array.from(result.finalResults, (row) => row.id), ["a"]);
  assert.deepEqual(Array.from(result.pendingReviewRecords, (row) => row.id), ["a-pending"]);
  assert.equal(result.resultCount, 2);
  assert.equal(result.finalResultCount, 1);
  assert.equal(result.pendingReviewCount, 1);
  assert.equal(result.mixedSummaryAnalysisSuppressed, true);
  assert.strictEqual(sandbox.compactForPlan(summary, "a.yaml", "", "2026-07-30T00:00:00Z"), result);

  const source = extractFunction("filterResultsSummaryForSelectedPlan");
  assert.match(source, /for \(const key of RESULT_SUMMARY_RECORD_ARRAY_FIELDS\)/);
  assert.doesNotMatch(source, /for \(const key of \[/);
  assert.doesNotMatch(source, /results\.filter/);
});

test("cached result summaries still suppress stale Plan revisions", () => {
  const sandbox = loadActualFilterCache();
  const summary = {
    planFile: "a.yaml",
    planRevision: "r1",
    resultCount: 2,
    results: [{ id: "old", planFile: "a.yaml" }],
  };
  const result = sandbox.compactForPlan(summary, "a.yaml", "r2", "");

  assert.equal(result.resultCount, 0);
  assert.equal(result.stalePlanVersionSuppressed, true);
  assert.deepEqual(Array.from(result.results), []);
});
