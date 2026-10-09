const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panelSource = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = panelSource.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panelSource.length; index += 1) {
    if (panelSource[index] === "{") depth += 1;
    if (panelSource[index] === "}") depth -= 1;
    if (depth === 0) return panelSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadCoverage() {
  const sandbox = {
    meaningfulValue: (value) => {
      const text = String(value === undefined || value === null ? "" : value).trim();
      return text && text !== "-" ? text : "";
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("evidenceCoverageState")}\nthis.coverage = evidenceCoverageState;`, sandbox);
  return sandbox.coverage;
}

test("an artifact covering every archived result reads as generated", () => {
  const coverage = loadCoverage();
  const state = coverage("simple_cluster/results/statistics.json", 18, 18);
  assert.equal(state.tone, "good");
  assert.equal(state.label, "已生成");
  assert.equal(state.detail, "覆盖全部 18 条已归档结果");
});

test("a stale artifact is named as needing a rerun rather than as missing", () => {
  const coverage = loadCoverage();
  const state = coverage("simple_cluster/results/statistics.json", 12, 18);
  assert.equal(state.tone, "warn");
  assert.equal(state.label, "需重跑");
  assert.equal(state.detail, "产物覆盖 12 条，已归档 18 条；6 条未纳入");
});

test("an artifact wider than the current archive also demands a rerun", () => {
  const coverage = loadCoverage();
  const state = coverage("simple_cluster/results/paper_table.md", 20, 18);
  assert.equal(state.label, "需重跑");
  assert.match(state.detail, /多于当前已归档 18 条；归档已变更$/);
});

test("missing artifacts and empty archives stay distinguishable", () => {
  const coverage = loadCoverage();
  const missing = coverage("-", 0, 18);
  assert.equal(missing.label, "待运行");
  assert.equal(missing.detail, "尚未生成产物；已归档 18 条");

  for (const artifact of ["", "-", null, undefined]) {
    assert.equal(coverage(artifact, 0, 5).label, "待运行");
  }
  for (const archived of [0, "", null, undefined, "-"]) {
    const empty = coverage("simple_cluster/results/statistics.json", 0, archived);
    assert.equal(empty.label, "等待归档");
    assert.equal(empty.detail, "尚无已归档结果");
  }
});

test("the evidence workbench wires coverage into quality, statistics and paper rows", () => {
  const renderer = extractFunction("renderResultEvidenceWorkbench");
  assert.match(renderer, /const qualityCoverage = evidenceCoverageState\(qualityGatePath, qualityGateResultCount, effectiveArchivedResultCount\)/);
  assert.match(renderer, /const statisticsCoverage = evidenceCoverageState\(statisticsPath, statisticsResultCount, effectiveArchivedResultCount\)/);
  assert.match(renderer, /const paperTableCoverage = evidenceCoverageState\(paperTablePath, paperTableResultCount, effectiveArchivedResultCount\)/);
  assert.match(renderer, /evidencePlanRow\("SCI 统计", statisticsCoverage\.tone, statisticsCoverage\.label, statisticsItems\)/);
  assert.match(renderer, /\["覆盖", qualityCoverage\.detail/);
  assert.match(renderer, /\["覆盖", statisticsCoverage\.detail/);
  assert.match(renderer, /\["表格覆盖", paperTableCoverage\.detail/);
});
