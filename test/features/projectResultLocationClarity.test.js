const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");

function renderPanelHtmlFromSource(source) {
  return require("../../dist/ui/PanelHtml.js").renderPanelHtml();
}

function extractScript(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((value) => value.includes("function uniqueText") && value.includes("function planOutputCandidates"));
  assert.ok(script, "panel implementation script missing");
  return script;
}

const panelScript = extractScript(renderPanelHtmlFromSource(panel));

function extractFunction(name) {
  const start = panelScript.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelScript.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelScript.length; index += 1) {
    if (panelScript[index] === "{") depth += 1;
    if (panelScript[index] === "}") depth -= 1;
    if (depth === 0) return panelScript.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractSourceFunction(source, name) {
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

function loadCandidateDerivation() {
  const sandbox = {
    RESULT_METADATA_FILENAMES: new Set(["jobs.csv", "artifact_manifest.json", "checkpoint_manifest.json", "manifest.json", "metadata.json", "status.json", "state.json", "progress.json", "job.json", "jobs.json", "env_snapshot.json", "config_snapshot.json", "config_snapshot.yaml", "config_snapshot.yml"]),
    RESULT_METADATA_SUFFIXES: ["_snapshot.json", "_manifest.json", "_status.json", "_state.json", "_progress.json"],
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    planOutputCandidatesCache: new WeakMap(),
    planOutputEvidenceCandidatesCache: new WeakMap(),
    adapterRuleResultCandidatesCache: new WeakMap(),
    asArray(value) {
      return Array.isArray(value) ? value : (!value || typeof value !== "object" ? [] : Object.values(value));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("uniqueText"),
    extractFunction("isParseableResultCandidate"),
    extractFunction("normalizeOutputCandidateKey"),
    extractFunction("dedupOutputCandidates"),
    extractFunction("planOutputCandidates"),
    extractFunction("planOutputEvidenceCandidates"),
    extractFunction("adapterRuleResultCandidates"),
    "this.check = { planOutputCandidates, planOutputEvidenceCandidates, adapterRuleResultCandidates };",
  ].join("\n"), sandbox);
  return sandbox.check;
}

function panelPreviewScope(previews, plan, rules) {
  const sandbox = {
    RESULT_METADATA_FILENAMES: new Set(["jobs.csv", "artifact_manifest.json", "checkpoint_manifest.json", "manifest.json", "metadata.json", "status.json", "state.json", "progress.json", "job.json", "jobs.json", "env_snapshot.json", "config_snapshot.json", "config_snapshot.yaml", "config_snapshot.yml"]),
    RESULT_METADATA_SUFFIXES: ["_snapshot.json", "_manifest.json", "_status.json", "_state.json", "_progress.json"],
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    planOutputCandidatesCache: new WeakMap(),
    planOutputEvidenceCandidatesCache: new WeakMap(),
    adapterRuleResultCandidatesCache: new WeakMap(),
    planScopedResultCandidateCache: new WeakMap(),
    planScopedResultPreviewCache: new WeakMap(),
    asArray(value) { return Array.isArray(value) ? value : []; },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("uniqueText"),
    extractFunction("isParseableResultCandidate"),
    extractFunction("planOutputCandidates"),
    extractFunction("planOutputEvidenceCandidates"),
    extractFunction("adapterRuleResultCandidates"),
    extractFunction("normalizeOutputCandidateKey"),
    extractFunction("dedupOutputCandidates"),
    extractFunction("resultPreviewRegexEscape"),
    extractFunction("normalizeResultCandidatePath"),
    extractFunction("compileResultCandidatePatterns"),
    extractFunction("compiledResultCandidatesMatchFile"),
    extractFunction("resultCandidatePatternMatchesFile"),
    extractFunction("planScopedResultParsePreviews"),
    "this.check = planScopedResultParsePreviews;",
  ].join("\n"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(previews, plan, rules)));
}

function extensionPreviewScope(previews, plan, rules) {
  const sandbox = {
    path,
    OUTPUT_CANDIDATE_CONTRACT_BASENAMES: new Set(["metrics_summary.csv", "metrics_case.csv", "stdout.log", "stderr.log"]),
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    planScopedResultCandidateCache: new WeakMap(),
    planScopedResultPreviewCache: new WeakMap(),
    escapeRegExp(value) { return String(value || "").replace(/[.*+?^{}$()|[\]\\]/g, "\\$&"); },
    uniqueStrings(values) { return [...new Set(values.filter(Boolean))]; },
    planOutputEvidenceCandidates(item) { return Array.isArray((item || {}).outputCandidates) ? item.outputCandidates : []; },
    adapterRuleResultCandidates(item) { return [
      ...((item || {}).candidateCsv || []),
      ...((item || {}).candidateJson || []),
      ...((item || {}).consoleLogs || []),
      ...((item || {}).textLogs || []),
    ]; },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractSourceFunction(extension, "normalizeOutputCandidateKey"),
    extractSourceFunction(extension, "dedupOutputCandidates"),
    extractSourceFunction(extension, "normalizeResultCandidatePath"),
    extractSourceFunction(extension, "compileResultCandidatePatterns"),
    extractSourceFunction(extension, "compiledResultCandidatesMatchFile"),
    extractSourceFunction(extension, "resultCandidatePatternMatchesFile"),
    extractSourceFunction(extension, "planScopedResultParsePreviews"),
    "this.check = planScopedResultParsePreviews;",
  ].join("\n"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(previews, plan, rules)));
}

test("Plan and adapter candidates exclude metadata and preserve priority", () => {
  const { planOutputCandidates, planOutputEvidenceCandidates, adapterRuleResultCandidates } = loadCandidateDerivation();
  const plan = { outputCandidates: ["status.json", "work_dirs/current/metrics.json", "work_dirs/current/metrics.json"] };
  const rules = { candidateCsv: ["jobs.csv", "work_dirs/rules/scores.csv"] };
  assert.deepEqual(Array.from(planOutputCandidates(plan)), ["status.json", "work_dirs/current/metrics.json"]);
  assert.deepEqual(Array.from(planOutputEvidenceCandidates(plan)), ["work_dirs/current/metrics.json"]);
  assert.deepEqual(Array.from(adapterRuleResultCandidates(rules)), ["work_dirs/rules/scores.csv"]);
});

test("candidate caches reuse an unchanged source and invalidate replacements", () => {
  const { planOutputEvidenceCandidates, adapterRuleResultCandidates } = loadCandidateDerivation();
  const plan = { outputCandidates: ["outputs/plan.csv"] };
  const rules = { candidateCsv: ["outputs/rules.csv"] };
  assert.strictEqual(planOutputEvidenceCandidates(plan), planOutputEvidenceCandidates(plan));
  assert.strictEqual(adapterRuleResultCandidates(rules), adapterRuleResultCandidates(rules));
  assert.notStrictEqual(planOutputEvidenceCandidates(plan), planOutputEvidenceCandidates({ outputCandidates: ["outputs/new-plan.csv"] }));
  assert.notStrictEqual(adapterRuleResultCandidates(rules), adapterRuleResultCandidates({ candidateCsv: ["outputs/new-rule.csv"] }));
});

test("empty candidate sources never invent a result file", () => {
  const { planOutputEvidenceCandidates, adapterRuleResultCandidates } = loadCandidateDerivation();
  assert.deepEqual(Array.from(planOutputEvidenceCandidates({})), []);
  assert.deepEqual(Array.from(adapterRuleResultCandidates({})), []);
  assert.doesNotMatch(panel, /const resultPath = [^;]*\|\| "metrics_summary\.csv"/);
});
test("local result previews stay scoped to the selected Plan and explicit project rules", () => {
  const previews = [
    { file: "work_dirs/alpha/base/metrics.csv", parseable: true, records: 2 },
    { file: "work_dirs/beta/base/metrics.csv", parseable: true, records: 3 },
    { file: "work_dirs/alpha/base/stderr.log", parseable: true, records: 1 },
    { file: "shared/reference.csv", parseable: true, records: 1 },
  ];
  const plan = {
    planFile: "experiments/plans/alpha.yaml",
    suite: "alpha",
    outputCandidates: ["work_dirs/{suite}/{case}/metrics.csv", "{output_dir}/stderr.log"],
  };
  const rules = { candidateCsv: ["shared/*.csv"] };
  const expectedFiles = ["work_dirs/alpha/base/metrics.csv", "work_dirs/alpha/base/stderr.log", "shared/reference.csv"];
  for (const scope of [panelPreviewScope(previews, plan, rules), extensionPreviewScope(previews, plan, rules)]) {
    assert.deepEqual(scope.items.map((item) => item.file), expectedFiles);
    assert.equal(scope.hiddenCount, 1);
    assert.equal(scope.scoped, true);
  }
  assert.doesNotMatch(panel, /当前 Plan ' \+ matched\.length/);
  assert.doesNotMatch(panel, /隐藏其他 ' \+ normalized\.hiddenCount/);
  assert.doesNotMatch(panel, /结果解析预览/);
  assert.match(extension, /planScopedResultParsePreviews\(arrayFromRecord\(project \|\| \{\}, "resultParsePreviews"\), plan, rules\)/);
});

test("frontend and backend result preview scopes compile candidates before filtering previews", () => {
  const previews = [
    { file: "nested\\metrics.csv" },
    { file: "runs/alpha/case-1/result.json" },
    { file: "runs/alpha/deep/final.log" },
    { file: "runs/beta/case-1/result.json" },
  ];
  const plan = {
    planFile: "experiments/plans/alpha.yaml",
    suite: "alpha",
    outputCandidates: ["metrics.csv", "runs/{suite}/case-?/result.json", "runs/{suite}/**/*.log"],
  };
  const expected = [
    "nested\\metrics.csv",
    "runs/alpha/case-1/result.json",
    "runs/alpha/deep/final.log",
  ];

  assert.deepEqual(panelPreviewScope(previews, plan, {}).items.map((item) => item.file), expected);
  assert.deepEqual(extensionPreviewScope(previews, plan, {}).items.map((item) => item.file), expected);
  for (const [source, extractor] of [[panelScript, extractSourceFunction], [extension, extractSourceFunction]]) {
    const scopedSource = extractor(source, "planScopedResultParsePreviews");
    assert.match(scopedSource, /compileResultCandidatePatterns\(candidates, plan\)/);
    assert.doesNotMatch(scopedSource, /candidates\.some|resultCandidatePatternMatchesFile/);
  }
});

test("panel state derivation reuses fixed command and result metadata collections", () => {
  assert.match(panel, /const PPT_AUTOMATION_ACTION_COMMANDS = new Set\(/);
  assert.match(panel, /const DEBUG_MODE_BLOCKED_UI_COMMANDS = new Set\(/);
  assert.match(panel, /const RESULT_METADATA_FILENAMES = new Set\(/);
  assert.match(panel, /const RESULT_METADATA_SUFFIXES = \[/);

  const pptReadiness = extractFunction("pptAutomationReadinessForState");
  const debugGate = extractFunction("debugModeBlockedUiCommand");
  const resultCandidate = extractFunction("isParseableResultCandidate");
  assert.match(pptReadiness, /PPT_AUTOMATION_ACTION_COMMANDS\?\.has/);
  assert.match(debugGate, /DEBUG_MODE_BLOCKED_UI_COMMANDS\?\.has/);
  assert.match(resultCandidate, /RESULT_METADATA_FILENAMES\?\.has/);
  assert.match(resultCandidate, /RESULT_METADATA_SUFFIXES\.some/);
  assert.doesNotMatch([pptReadiness, debugGate, resultCandidate].join("\n"), /new Set\(|const metadataSuffixes/);
});
