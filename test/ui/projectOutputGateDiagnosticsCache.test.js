const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadDiagnostics() {
  const referenceIds = new WeakMap();
  let nextReferenceId = 1;
  const sandbox = {
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    EMPTY_OUTPUT_DERIVATION_SOURCE: Object.freeze({}),
    PROJECT_OUTPUT_GATE_DIAGNOSTICS_VARIANT_LIMIT: 3,
    projectOutputGateDiagnosticsCache: new WeakMap(),
    signalCalls: 0,
    candidateCalls: 0,
    previewCalls: 0,
    refListKey(...values) {
      return values.map((value) => {
        if (!value || typeof value !== "object") return `${typeof value}:${String(value)}`;
        if (!referenceIds.has(value)) referenceIds.set(value, nextReferenceId++);
        return `ref:${referenceIds.get(value)}`;
      }).join("|");
    },
    asArray(value) {
      return Array.isArray(value) ? value : [];
    },
    planOutputEvidenceSignals(plan) {
      sandbox.signalCalls += 1;
      return plan.outputSignals || [];
    },
    planOutputEvidenceCandidates(plan) {
      sandbox.candidateCalls += 1;
      return plan.outputCandidates || [];
    },
    actionableAdapterRuleSignals(rules) {
      return Boolean((rules.candidateCsv || []).length);
    },
    adapterRuleResultCandidates(rules) {
      return rules.candidateCsv || [];
    },
    validResultPreviewCount(previews) {
      sandbox.previewCalls += 1;
      return previews.filter((item) => item.parseable && item.records > 0).length;
    },
    planContractFixText() {
      return "补齐 Plan 契约";
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("projectOutputGateDiagnostics")}\nthis.diagnostics = projectOutputGateDiagnostics;`, sandbox);
  return sandbox;
}

function fixture() {
  const project = {
    adapterConfig: "experiments/simple_project.yaml",
    adapterRules: { candidateCsv: ["metrics_summary.csv"] },
    configs: [{ file: "configs/base.yaml" }],
    outputContractFiles: ["metrics_summary.csv"],
    resultParsePreviews: [{ parseable: true, records: 2 }],
  };
  const plan = {
    planContractOk: true,
    baseConfig: "configs/base.yaml",
    outputSignals: ["result_csv"],
    outputCandidates: ["metrics_summary.csv"],
  };
  return { project, plan };
}

test("project output gate reuses stable effective inputs", () => {
  const sandbox = loadDiagnostics();
  const { project, plan } = fixture();
  const first = sandbox.diagnostics(project, {}, plan);
  const calls = { signals: sandbox.signalCalls, candidates: sandbox.candidateCalls, previews: sandbox.previewCalls };

  assert.strictEqual(sandbox.diagnostics(project, { ignored: true }, plan), first);
  assert.deepEqual({ signals: sandbox.signalCalls, candidates: sandbox.candidateCalls, previews: sandbox.previewCalls }, calls);
  assert.equal(first.ok, true);
  assert.deepEqual(Array.from(first.missing), []);
});

test("project output gate invalidates on effective reference or scalar replacement", () => {
  const sandbox = loadDiagnostics();
  const { project, plan } = fixture();
  const first = sandbox.diagnostics(project, {}, plan);

  project.resultParsePreviews = [{ parseable: false, records: 0 }];
  assert.notStrictEqual(sandbox.diagnostics(project, {}, plan), first);

  const second = sandbox.diagnostics(project, {}, plan);
  plan.baseConfig = "configs/missing.yaml";
  const missingConfig = sandbox.diagnostics(project, {}, plan);
  assert.notStrictEqual(missingConfig, second);
  assert.equal(missingConfig.ok, false);
  assert.ok(Array.from(missingConfig.missing).includes("配置文件"));

  project.adapterConfig = "";
  assert.notStrictEqual(sandbox.diagnostics(project, {}, plan), missingConfig);
});

test("project output gate keeps bounded recent variants", () => {
  const sandbox = loadDiagnostics();
  const { project, plan } = fixture();
  const first = sandbox.diagnostics(project, {}, plan);

  for (let index = 1; index < 5; index += 1) {
    sandbox.diagnostics(project, {}, { ...plan, baseConfig: `configs/${index}.yaml` });
  }

  const variants = sandbox.projectOutputGateDiagnosticsCache.get(project);
  assert.equal(variants.size, 3);
  assert.notStrictEqual(sandbox.diagnostics(project, {}, plan), first);
  assert.equal(variants.size, 3);
});

test("project output gate preserves seven diagnostic rows and blocked semantics", () => {
  const sandbox = loadDiagnostics();
  const diagnostics = sandbox.diagnostics({}, {}, { planContractOk: false, baseConfig: "missing.yaml" });

  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.rows.length, 7);
  assert.deepEqual(Array.from(diagnostics.missing), ["计划强契约", "配置文件", "接入配置", "计划输出", "候选结果规则", "标准结果契约", "解析预览"]);
});
