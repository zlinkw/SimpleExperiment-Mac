const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// 真实现：门面 src/extension.ts / src/ui/PanelHtml.ts 已不再包含逻辑，
// 改读真实实现源 src/extension/legacy.ts、src/ui/PanelHtml.legacy.ts、
// src/features/PlanBuilder.legacy.ts，并提取真实函数体，不再手写 mock。
const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
const planBuilder = fs.readFileSync(path.join(__dirname, "../../src/features/PlanBuilder.legacy.ts"), "utf8");

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

function extractPanelConst(name) {
  const start = panel.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = panel.indexOf(";", start);
  assert.ok(end > start, `unterminated ${name}`);
  return panel.slice(start, end + 1);
}

function loadBackendSignalFilter() {
  const sandbox = {
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    planOutputEvidenceSignalsCache: new WeakMap(),
    uniqueStrings(values) { return [...new Set(values.filter(Boolean))]; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(extension, "planOutputEvidenceSignals")}\nthis.filterSignals = planOutputEvidenceSignals;`, sandbox);
  return (plan) => JSON.parse(JSON.stringify(sandbox.filterSignals(plan)));
}

function loadFrontendSignalFilter() {
  const sandbox = {
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    planOutputEvidenceSignalsCache: new WeakMap(),
    asArray(value) { return Array.isArray(value) ? value : []; },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractPanelConst("RESULT_METADATA_FILENAMES"),
    extractPanelConst("RESULT_METADATA_SUFFIXES"),
    extractFunction(panel, "asArray"),
    extractFunction(panel, "uniqueText"),
    extractFunction(panel, "planOutputEvidenceSignals"),
    "this.filterSignals = planOutputEvidenceSignals;",
  ].join("\n"), sandbox);
  return (plan) => JSON.parse(JSON.stringify(sandbox.filterSignals(plan)));
}

test("plan output evidence signals accept result dir and command param labels", () => {
  for (const label of ["结果文件", "结果目录", "命令参数", "文本日志", "任务产物", "标准契约", "metricRegex"])
    assert.ok(extension.includes(label) && panel.includes(label), `missing output evidence label: ${label}`);
  assert.match(planBuilder, /signals\.add\(`结果目录: \$\{dir\}`\)/);
  assert.match(planBuilder, /signals\.add\("命令参数: result_csv"\)/);

  const plan = {
    outputSignals: [
      "结果文件: metrics_summary.csv",
      "结果目录: work_dirs/demo",
      "命令参数: result_csv",
      "文本日志: stdout/stderr",
      "普通说明",
    ],
  };
  const expected = plan.outputSignals.slice(0, 4);
  assert.deepEqual(loadFrontendSignalFilter()(plan), expected);
  assert.deepEqual(loadBackendSignalFilter()(plan), expected);
});
