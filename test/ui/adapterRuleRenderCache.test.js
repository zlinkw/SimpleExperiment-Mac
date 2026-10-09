const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

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

function extractFrozenObject(name) {
  const start = panel.indexOf(`const ${name} = Object.freeze({`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = panel.indexOf("});", start);
  assert.ok(end > start, `unterminated ${name}`);
  return panel.slice(start, end + 3);
}

function loadRenderer() {
  const metadata = new Set([
    "jobs.csv", "artifact_manifest.json", "checkpoint_manifest.json", "manifest.json",
    "metadata.json", "status.json", "state.json", "progress.json",
  ]);
  const metadataSuffixes = ["_snapshot.json", "_manifest.json", "_status.json", "_state.json", "_progress.json"];
  const sandbox = {
    renderAdapterRulesCache: new WeakMap(),
    parseCalls: 0,
    rowCalls: 0,
    asArray(value) { return Array.isArray(value) ? value : []; },
    isParseableResultCandidate(value) {
      sandbox.parseCalls += 1;
      const text = String(value || "").trim().replace(/\\/g, "/");
      const lower = (text.split("/").pop() || "").toLowerCase();
      return Boolean(text)
        && !text.toLowerCase().startsWith("simple_cluster/results/")
        && !metadata.has(lower)
        && !metadataSuffixes.some((suffix) => lower.endsWith(suffix))
        && /\.(csv|json|txt|log|out)$/i.test(text);
    },
    row(label, value) {
      sandbox.rowCalls += 1;
      return `<div data-label="${label}">${value}</div>`;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFrozenObject("PROJECT_TASK_TYPE_LABELS"),
    extractFunction("adapterRuleCount"),
    extractFunction("adapterRuleText"),
    extractFunction("adapterRuleSignalCount"),
    extractFunction("hasAdapterRuleSignals"),
    extractFunction("ignoredAdapterRuleCandidateCount"),
    extractFunction("projectTaskTypeLabel"),
    extractFunction("renderAdapterRules"),
    "this.render = renderAdapterRules;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("adapter rule preview details removed from panel", () => {
  const sandbox = loadRenderer();
  const rules = {
    taskType: "classification",
    primaryMetric: "AUC",
    candidateCsv: ["status.json", "metrics.csv"],
    candidateJson: ["artifact_manifest.json", "metrics.json"],
    consoleLogs: ["run_status.json", "stdout.log"],
    textLogs: ["simple_cluster/results/internal.txt", "summary.txt"],
    metricAliases: { auroc: "AUC", dsc: "Dice" },
    csvColumnMapping: { score: "value", name: "metric" },
  };

  assert.equal(sandbox.render(rules), "");
  assert.doesNotMatch(panel, /项目接入规则/);
  assert.doesNotMatch(panel, /结果解析预览/);
  assert.doesNotMatch(panel, /配置参数预览/);
});

test("adapter rule renderer caches empty displays without touching editable renderer", () => {
  const sandbox = loadRenderer();
  let reads = 0;
  const emptyRules = {};
  Object.defineProperty(emptyRules, "candidateCsv", {
    enumerable: true,
    get() {
      reads += 1;
      return [];
    },
  });

  assert.equal(sandbox.render(emptyRules), "");
  assert.equal(reads, 0);
  assert.equal(sandbox.render(emptyRules), "");
  assert.equal(reads, 0);
  assert.equal(sandbox.renderAdapterRulesCache.has(emptyRules), true);
  assert.equal(sandbox.renderAdapterRulesCache.get(emptyRules), "");
  assert.equal(sandbox.render(null), "");
  assert.match(panel, /const renderAdapterRulesCache = new WeakMap\(\)/);
  assert.doesNotMatch(extractFunction("renderProjectRuleEditor"), /renderAdapterRulesCache/);
});
