const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// 真实现：改读 src/extension/legacy.ts 与 src/ui/PanelHtml.legacy.ts，
// 提取真实的 planOutputEvidenceCandidates / adapterRuleResultCandidates /
// compileResultCandidatePatterns / compiledResultCandidatesMatchFile，
// 不再 mock uniqueStrings / compile / match。
const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

function extractFunction(source, name) {
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

function extractConst(source, name) {
  const start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf(";", start);
  assert.ok(end > start, `unterminated ${name}`);
  return source.slice(start, end + 1);
}

// Panel 内层脚本位于外层模板字符串内，落盘前会被剥离一层转义；
// 此处模拟同一剥离（双反斜杠→单反斜杠），得到与线上运行时完全一致的真实代码。
function stripOuterTemplateEscapes(code) {
  return String(code || "").split("\\\\").join("\\");
}

function loadPreviewScope() {
  const sandbox = {
    path,
    PlanBuilder_1: {},
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    planOutputCandidatesCache: new WeakMap(),
    planOutputEvidenceCandidatesCache: new WeakMap(),
    adapterRuleResultCandidatesCache: new WeakMap(),
    planScopedResultCandidateCache: new WeakMap(),
    planScopedResultPreviewCache: new WeakMap(),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst(extension, "OUTPUT_CANDIDATE_CONTRACT_BASENAMES"),
    extractFunction(extension, "arrayFromRecord"),
    extractFunction(extension, "uniqueStrings"),
    extractFunction(extension, "escapeRegExp"),
    extractFunction(extension, "normalizeResultCandidatePath"),
    extractFunction(extension, "normalizeOutputCandidateKey"),
    extractFunction(extension, "dedupOutputCandidates"),
    extractFunction(extension, "isParseableResultCandidate"),
    extractFunction(extension, "adapterRuleResultCandidates"),
    extractFunction(extension, "planOutputCandidates"),
    extractFunction(extension, "planOutputEvidenceCandidates"),
    extractFunction(extension, "compileResultCandidatePatterns"),
    extractFunction(extension, "compiledResultCandidatesMatchFile"),
    extractFunction(extension, "planScopedResultParsePreviews"),
    "this.scope = planScopedResultParsePreviews;",
    "this.evidenceCandidates = planOutputEvidenceCandidates;",
  ].join("\n"), sandbox);
  return sandbox;
}

function loadFrontendPreviewScope() {
  const sandbox = {
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    planOutputCandidatesCache: new WeakMap(),
    planOutputEvidenceCandidatesCache: new WeakMap(),
    planOutputEvidenceSignalsCache: new WeakMap(),
    adapterRuleResultCandidatesCache: new WeakMap(),
    planScopedResultCandidateCache: new WeakMap(),
    planScopedResultPreviewCache: new WeakMap(),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst(panel, "RESULT_METADATA_FILENAMES"),
    extractConst(panel, "RESULT_METADATA_SUFFIXES"),
    extractFunction(panel, "asArray"),
    extractFunction(panel, "uniqueText"),
    stripOuterTemplateEscapes(extractFunction(panel, "normalizeResultCandidatePath")),
    extractFunction(panel, "resultPreviewRegexEscape"),
    stripOuterTemplateEscapes(extractFunction(panel, "normalizeOutputCandidateKey")),
    extractFunction(panel, "dedupOutputCandidates"),
    stripOuterTemplateEscapes(extractFunction(panel, "isParseableResultCandidate")),
    extractFunction(panel, "adapterRuleResultCandidates"),
    extractFunction(panel, "planOutputCandidates"),
    extractFunction(panel, "planOutputEvidenceCandidates"),
    stripOuterTemplateEscapes(extractFunction(panel, "compileResultCandidatePatterns")),
    extractFunction(panel, "compiledResultCandidatesMatchFile"),
    extractFunction(panel, "planScopedResultParsePreviews"),
    "this.scope = planScopedResultParsePreviews;",
    "this.evidenceCandidates = planOutputEvidenceCandidates;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("Plan-scoped candidate compilation is reused while preview rows stay current", () => {
  const sandbox = loadPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  const rules = { candidateCsv: ["shared/reference.csv"] };

  const first = sandbox.scope([
    { file: "runs/a.csv" },
    { file: "runs/b.csv" },
  ], plan, rules);
  assert.deepEqual(JSON.parse(JSON.stringify(first.items)), [{ file: "runs/a.csv" }]);
  assert.equal(first.candidateCount, 2);

  const second = sandbox.scope([
    { file: "shared/reference.csv" },
    { file: "runs/c.csv" },
  ], plan, rules);
  assert.deepEqual(JSON.parse(JSON.stringify(second.items)), [{ file: "shared/reference.csv" }]);
  assert.equal(second.totalCount, 2);
  assert.equal(second.hiddenCount, 1);
});

test("Plan or rules replacement invalidates the compiled candidate cache", () => {
  const sandbox = loadPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  const rules = { candidateCsv: ["shared/reference.csv"] };

  const first = sandbox.scope([], plan, rules);
  assert.notStrictEqual(sandbox.scope([], { ...plan, outputCandidates: [...plan.outputCandidates] }, rules), first);
  assert.notStrictEqual(sandbox.scope([], plan, { candidateCsv: [...rules.candidateCsv] }), first);
  const samePreviews = [];
  assert.strictEqual(sandbox.scope(samePreviews, plan, rules), sandbox.scope(samePreviews, plan, rules));
});

test("Plan-scoped preview filtering reuses one stable preview snapshot", () => {
  const sandbox = loadPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  const rules = { candidateCsv: [] };
  const previews = [{ file: "runs/a.csv" }, { file: "runs/b.csv" }];
  const first = sandbox.scope(previews, plan, rules);

  assert.strictEqual(sandbox.scope(previews, plan, rules), first);
  assert.notStrictEqual(sandbox.scope([...previews], plan, rules), first);
});

test("missing rules reuse the shared empty source without changing unscoped behavior", () => {
  const sandbox = loadPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  sandbox.scope([], plan, undefined);
  sandbox.scope([{ file: "runs/a.csv" }], plan, null);

  const unscopedRows = [{ file: "runs/a.csv" }];
  const unscoped = sandbox.scope(unscopedRows, undefined, undefined);
  assert.equal(unscoped.scoped, false);
  assert.equal(unscoped.items.length, 1);
  assert.match(extension, /const planScopedResultCandidateCache = new WeakMap\(\)/);
  assert.match(extension, /const planScopedResultPreviewCache = new WeakMap\(\)/);
});

test("contract variants from plan and rules fold to one derived candidate", () => {
  const sandbox = loadPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["{output_dir}/metrics_summary.csv"] };
  const rules = { candidateCsv: ["work_dirs/multirun/demo/x/metrics_summary.csv", "metrics_summary.csv"] };
  const first = sandbox.scope([
    { file: "work_dirs/multirun/demo/x/metrics_summary.csv" },
    { file: "other.csv" },
  ], plan, rules);
  assert.equal(first.candidateCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first.items)), [{ file: "work_dirs/multirun/demo/x/metrics_summary.csv" }]);
});

test("frontend Plan-scoped candidate compilation is reused while preview rows stay current", () => {
  const sandbox = loadFrontendPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  const rules = { candidateCsv: ["shared/reference.csv"] };

  const first = sandbox.scope([{ file: "runs/a.csv" }], plan, rules);
  const second = sandbox.scope([{ file: "shared/reference.csv" }], plan, rules);
  assert.deepEqual(JSON.parse(JSON.stringify(first.items)), [{ file: "runs/a.csv" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(second.items)), [{ file: "shared/reference.csv" }]);
});

test("frontend Plan or rules replacement invalidates the compiled candidate cache", () => {
  const sandbox = loadFrontendPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  const rules = { candidateCsv: ["shared/reference.csv"] };

  const first = sandbox.scope([], plan, rules);
  assert.notStrictEqual(sandbox.scope([], { ...plan, outputCandidates: [...plan.outputCandidates] }, rules), first);
  assert.notStrictEqual(sandbox.scope([], plan, { candidateCsv: [...rules.candidateCsv] }), first);
  const samePreviews = [];
  assert.strictEqual(sandbox.scope(samePreviews, plan, rules), sandbox.scope(samePreviews, plan, rules));
});

test("frontend Plan-scoped preview filtering reuses one stable preview snapshot", () => {
  const sandbox = loadFrontendPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  const rules = { candidateCsv: [] };
  const previews = [{ file: "runs/a.csv" }, { file: "runs/b.csv" }];
  const first = sandbox.scope(previews, plan, rules);

  assert.strictEqual(sandbox.scope(previews, plan, rules), first);
  assert.notStrictEqual(sandbox.scope([...previews], plan, rules), first);
});

test("frontend missing rules reuse the shared empty source without changing unscoped behavior", () => {
  const sandbox = loadFrontendPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["runs/a.csv"] };
  sandbox.scope([], plan, undefined);
  sandbox.scope([{ file: "runs/a.csv" }], plan, null);
  const unscoped = sandbox.scope([{ file: "runs/a.csv" }], undefined, undefined);

  assert.equal(unscoped.scoped, false);
  assert.equal(unscoped.items.length, 1);
  assert.match(panel, /const planScopedResultCandidateCache = new WeakMap\(\)/);
  assert.match(panel, /const planScopedResultPreviewCache = new WeakMap\(\)/);
});

test("frontend contract variants from plan and rules fold to one derived candidate", () => {
  const sandbox = loadFrontendPreviewScope();
  const plan = { planFile: "experiments/plans/a.yaml", outputCandidates: ["{output_dir}/metrics_summary.csv"] };
  const rules = { candidateCsv: ["work_dirs/multirun/demo/x/metrics_summary.csv", "metrics_summary.csv"] };
  const first = sandbox.scope([
    { file: "work_dirs/multirun/demo/x/metrics_summary.csv" },
    { file: "other.csv" },
  ], plan, rules);
  assert.equal(first.candidateCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first.items)), [{ file: "work_dirs/multirun/demo/x/metrics_summary.csv" }]);
});
