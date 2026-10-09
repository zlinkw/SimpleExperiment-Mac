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

function extractFrozenArray(name) {
  const start = extension.indexOf(`const ${name} = Object.freeze([`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = extension.indexOf("]);", start);
  assert.ok(end > start, `unterminated ${name}`);
  return extension.slice(start, end + 3);
}

function loadAdapterCompaction() {
  const sandbox = {
    WEBVIEW_ADAPTER_RULE_LIST_LIMIT: 2,
    WEBVIEW_ADAPTER_RULE_MAP_LIMIT: 2,
    WEBVIEW_ADAPTER_INFERRED_SIGNAL_LIMIT: 1,
    objectRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFrozenArray("WEBVIEW_ADAPTER_RULE_HIDDEN_FIELDS"),
    extractFrozenArray("WEBVIEW_ADAPTER_RULE_LIST_FIELDS"),
    extractFrozenArray("WEBVIEW_ADAPTER_RULE_MAP_FIELDS"),
    extractFunction("compactAdapterRuleListForWebview"),
    extractFunction("compactAdapterRuleMapForWebview"),
    extractFunction("compactAdapterRulesForWebview"),
    "this.api = { compactAdapterRulesForWebview, hidden: WEBVIEW_ADAPTER_RULE_HIDDEN_FIELDS, lists: WEBVIEW_ADAPTER_RULE_LIST_FIELDS, maps: WEBVIEW_ADAPTER_RULE_MAP_FIELDS };",
  ].join("\n"), sandbox);
  return sandbox.api;
}

function loadCompaction() {
  const sandbox = {
    WEBVIEW_CONFIG_SUMMARY_LIMIT: 2,
    detectedProjectArrayLimits: {
      configs: 3,
      plans: 3,
      environmentFiles: 3,
      resultFiles: 3,
      outputContractFiles: 3,
      factoryFiles: 3,
      factorySymbols: 3,
      multimodalHints: 3,
      missingOnboarding: 3,
    },
    detectedProjectForWebviewCache: new WeakMap(),
    summaryCalls: 0,
    rulesCalls: 0,
    compactConfigSummaryForWebview(summary) {
      sandbox.summaryCalls += 1;
      return summary && summary.file ? { file: summary.file } : undefined;
    },
    compactAdapterRulesForWebview(rules) {
      sandbox.rulesCalls += 1;
      return rules ? { candidateCsv: Array.from(rules.candidateCsv || []).slice(0, 1) } : rules;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("compactDetectedProjectForWebview")}\nthis.compact = compactDetectedProjectForWebview;`, sandbox);
  return sandbox;
}

test("detected project Webview compaction reuses one immutable source", () => {
  const sandbox = loadCompaction();
  const project = {
    configs: ["a", "b", "c", "d"],
    configSummaries: [{ file: "a.yaml" }, { file: "b.yaml" }, { file: "c.yaml" }],
    adapterRules: { candidateCsv: ["metrics.csv", "extra.csv"] },
  };
  const first = sandbox.compact(project);
  const calls = { summaries: sandbox.summaryCalls, rules: sandbox.rulesCalls };

  assert.strictEqual(sandbox.compact(project), first);
  assert.deepEqual({ summaries: sandbox.summaryCalls, rules: sandbox.rulesCalls }, calls);
  assert.deepEqual(Array.from(first.configs), ["a", "b", "c"]);
  assert.equal(first.configsTotalCount, 4);
  assert.equal(first.configsOmittedCount, 1);
  assert.deepEqual(Array.from(first.configSummaries, (item) => item.file), ["a.yaml", "b.yaml"]);
  assert.equal(first.configSummariesTotalCount, 3);
  assert.equal(first.configSummariesOmittedCount, 1);
});

test("detected project Webview compaction invalidates on source replacement", () => {
  const sandbox = loadCompaction();
  const project = {
    configs: ["a", "b", "c", "d"],
    configSummaries: [{ file: "a.yaml" }],
    adapterRules: { candidateCsv: ["metrics.csv"] },
  };
  const first = sandbox.compact(project);
  const replacement = {
    ...project,
    configs: [...project.configs],
    configSummaries: [...project.configSummaries],
    adapterRules: { ...project.adapterRules },
  };
  const second = sandbox.compact(replacement);

  assert.notStrictEqual(second, first);
  assert.equal(sandbox.summaryCalls, 2);
  assert.equal(sandbox.rulesCalls, 2);
});

test("dynamic onboarding suggestions are copied outside the cached project summary", () => {
  assert.match(extension, /const compactedDetectedProject = compactDetectedProjectForWebview/);
  assert.match(extension, /const webviewDetectedProject = \{[\s\S]{0,180}\.\.\.compactedDetectedProject,[\s\S]{0,180}missingOnboarding:/);
  assert.doesNotMatch(extension, /compactDetectedProjectForWebview\([^\n]+\);\s*webviewDetectedProject\.missingOnboarding\s*=/);
});

test("adapter rule Webview compaction reuses immutable field registries", () => {
  const api = loadAdapterCompaction();
  const rules = {
    inferredPlanCandidateCsv: ["raw.csv"],
    inferredPlanCandidateJson: ["raw.json"],
    inferredPlanConsoleLogs: ["stdout.log"],
    inferredPlanTextLogs: ["summary.txt"],
    secondaryMetrics: ["AUC", "F1", "AUPRC"],
    candidateCsv: ["a.csv", "b.csv", "c.csv"],
    csvColumnMapping: { metric: "name", value: "score", extra: "ignored" },
    inferredSignals: ["a", "b"],
    customExtension: { keep: true },
  };
  const compacted = api.compactAdapterRulesForWebview(rules);

  for (const key of api.hidden) assert.equal(key in compacted, false, key);
  assert.deepEqual(Array.from(compacted.secondaryMetrics), ["AUC", "F1"]);
  assert.equal(compacted.secondaryMetricsTotalCount, 3);
  assert.equal(compacted.secondaryMetricsOmittedCount, 1);
  assert.deepEqual(Array.from(compacted.candidateCsv), ["a.csv", "b.csv"]);
  assert.deepEqual({ ...compacted.csvColumnMapping }, { metric: "name", value: "score" });
  assert.equal(compacted.csvColumnMappingTotalCount, 3);
  assert.equal(compacted.csvColumnMappingOmittedCount, 1);
  assert.deepEqual(Array.from(compacted.inferredSignals), ["a"]);
  assert.equal(compacted.inferredSignalsOmittedCount, 1);
  assert.equal(compacted.adapterRulesPartial, true);
  assert.deepEqual({ ...compacted.customExtension }, { keep: true });
  assert.equal(Object.isFrozen(api.hidden), true);
  assert.equal(Object.isFrozen(api.lists), true);
  assert.equal(Object.isFrozen(api.maps), true);

  const source = extractFunction("compactAdapterRulesForWebview");
  assert.match(source, /WEBVIEW_ADAPTER_RULE_HIDDEN_FIELDS/);
  assert.match(source, /WEBVIEW_ADAPTER_RULE_LIST_FIELDS/);
  assert.match(source, /WEBVIEW_ADAPTER_RULE_MAP_FIELDS/);
  assert.doesNotMatch(source, /for \(const key of \[/);
});
