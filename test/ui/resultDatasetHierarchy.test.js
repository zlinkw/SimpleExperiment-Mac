const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/ui/PanelHtml.ts");
const start = source.indexOf("    function resultCatalogViewModel(catalog, state)");
const end = source.indexOf("\n    function renderResultEvidenceWorkbench", start + 20);
assert.ok(start >= 0 && end > start, "production result catalog view model and renderer are present");

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function createRenderer(options = {}) {
  const context = {
    asArray: value => Array.isArray(value) ? value : [],
    detailsOpenAttr: (key, defaultOpen) => Object.prototype.hasOwnProperty.call(context.detailsOpenState, key)
      ? context.detailsOpenState[key] ? " open" : ""
      : defaultOpen ? " open" : "",
    detailsOpenState: {},
    esc: escapeHtml,
    escAttr: escapeHtml,
    resultSplitTableKey: options.tableKey || "",
    resultSplitFieldName: "",
    resultSplitSearchQuery: "",
    resultSplitSelectedColumns: null,
    resultSplitSelectedValues: null,
    lastState: options.state || {},
    requestAnimationFrame: callback => callback(),
    document: { querySelectorAll: () => options.scrollTarget ? [options.scrollTarget] : [] },
    renderCount: 0,
    renderSectionIfVisible: () => { context.renderCount += 1; },
  };
  vm.runInNewContext(source.slice(start, end) + "; this.resultCatalogViewModel = resultCatalogViewModel; this.renderProjectResultTables = renderProjectResultTables; this.openResultSplitToolForTable = openResultSplitToolForTable; this.openSharedArtifactsForPlan = openSharedArtifactsForPlan", context);
  return context;
}

const plan = (planFile, planKey, artifactKey = "") => ({
  planFile,
  planKey,
  label: planFile,
  artifacts: artifactKey ? [{ artifactKey, kind: "raw", workerId: "worker-a", path: artifactKey }] : [],
});

const finalTable = (dataset, rowCount, path) => ({
  tableKey: dataset + "/final", dataset, datasetKey: dataset, name: "final", kind: "final", rowCount, path,
  markdownPath: path.replace(".csv", ".md"), header: ["dataset", "rate_percent"], values: { dataset: [dataset], rate_percent: ["50"] },
});

const methodTable = (dataset, name, path) => ({
  tableKey: dataset + "/" + name, dataset, datasetKey: dataset, name, kind: "method", rowCount: 2, path,
  markdownPath: path.replace(".csv", ".md"), header: ["dataset", "rate_percent"], values: { dataset: [dataset], rate_percent: ["50"] },
});

const catalog = {
  datasets: [
    { dataset: "pad_ufes_20", datasetKey: "pad_ufes_20", tables: [finalTable("pad_ufes_20", 34, "artifacts/results/pad_ufes_20/final/final.csv"), methodTable("pad_ufes_20", "corim", "artifacts/results/pad_ufes_20/methods/corim/corim.csv")], plans: [plan("experiments/plans/comparison/corim.yaml", "corim", "artifacts/results/pad_ufes_20/plans/corim/raw/worker-a/raw.csv")] },
    { dataset: "bus_cot_lesion", datasetKey: "bus_cot_lesion", tables: [finalTable("bus_cot_lesion", 28, "artifacts/results/bus_cot_lesion/final/final.csv"), methodTable("bus_cot_lesion", "corim", "artifacts/results/bus_cot_lesion/methods/corim/corim.csv")], plans: [plan("experiments/plans/comparison/concatenation.yaml", "concatenation")] },
    { dataset: "", datasetKey: "_unassigned", tables: [finalTable("", 0, "artifacts/results/_unassigned/final/final.csv")], plans: [plan("experiments/plans/comparison/unknown-a.yaml", "unknown-a"), plan("experiments/plans/comparison/unknown-b.yaml", "unknown-b")] },
    { dataset: "_shared", datasetKey: "_shared", tables: [], plans: [plan("experiments/plans/comparison/shared.yaml", "shared", "artifacts/results/_shared/raw.csv")] },
  ],
  legacyTables: [],
};

test("local results stay visible with failed synchronization and expose an independent offline refresh", () => {
  const renderer = createRenderer();
  const state = { connectionMode: "offline_import", resultSyncReport: { discovered: 20, accepted: 17, failed: 11 },
    resultOutputConfig: { catalog, catalogLoadStatus: "ready", tables: catalog.datasets.flatMap(group => group.tables) } };
  const html = renderer.renderProjectResultTables(state);
  assert.match(html, /data-command="refreshLocalResults"/);
  assert.match(html, /刷新本地结果/);
  assert.match(html, /总表 34 行/);
  assert.match(html, /总表 28 行/);
  const start = source.indexOf("    function disableReason(");
  const end = source.indexOf("\n    function ", start + 20);
  const context = {};
  vm.runInNewContext(source.slice(start, end) + "; this.disableReason = disableReason", context);
  assert.equal(context.disableReason(state, "refreshLocalResults", {}), "");
});

test("view model separates datasets, unassigned plans, and shared sources; selected dataset leads natural order", () => {
  const renderer = createRenderer();
  const view = renderer.resultCatalogViewModel(catalog, { planFileInput: "experiments/plans/comparison/corim.yaml" });
  assert.deepEqual(Array.from(view.datasets, item => item.dataset), ["pad_ufes_20", "bus_cot_lesion"]);
  assert.equal(view.defaultDatasetKey, "pad_ufes_20");
  assert.equal(view.unassigned.planCount, 2);
  assert.equal(view.shared.planCount, 1);
  assert.equal(view.shared.artifactCount, 1);
  assert.equal(view.shared.artifacts.length, 1);
  assert.equal(view.datasets.some(item => item.datasetKey === "_shared" || item.datasetKey === "_unassigned"), false);
  const natural = renderer.resultCatalogViewModel(catalog, {});
  assert.deepEqual(Array.from(natural.datasets, item => item.dataset), ["bus_cot_lesion", "pad_ufes_20"]);
  assert.equal(natural.defaultDatasetKey, "bus_cot_lesion");
});

test("renderer puts compact dataset tables first and collapses plans, unassigned details, and shared sources", () => {
  const renderer = createRenderer({ tableKey: "pad_ufes_20/corim", state: { planFileInput: "experiments/plans/comparison/corim.yaml" } });
  const html = renderer.renderProjectResultTables({
    planFileInput: "experiments/plans/comparison/corim.yaml",
    resultOutputConfig: { catalog, tables: catalog.datasets.flatMap(group => group.tables) },
  });
  const datasetGroups = html.match(/class="resultDatasetGroup"[^>]* open/g) || [];
  assert.equal(datasetGroups.length, 1);
  assert.match(html, /总表 34 行 · 方法 1 · 涉及 Plan 1/);
  assert.match(html, /总表 28 行 · 方法 1 · 涉及 Plan 1/);
  assert.match(html, /该数据集总表/);
  assert.match(html, /方法结果/);
  assert.match(html, /关联 Plan（1）/);
  assert.doesNotMatch(html, /class="resultDatasetGroup"[^>]*_shared/);
  assert.doesNotMatch(html, /class="resultDatasetGroup"[^>]*_unassigned/);
  assert.match(html, /⚠ 2 个 Plan 尚未识别数据集/);
  assert.match(html, /result-unassigned"/);
  assert.match(html, /高级来源/);
  assert.match(html, /跨数据集 Plan 与共享产物（1 个 Plan · 1 个文件）/);
  assert.match(html, /data-details-key="result-dataset-plans-pad_ufes_20"(?! open)/);
  assert.doesNotMatch(html, /data-details-key="result-plan-pad_ufes_20-corim"/);
  assert.match(html, /class="resultPlanReference" title="experiments\/plans\/comparison\/corim.yaml"><span class="resultPlanReferenceName">corim.yaml/);
  assert.match(html, /title="artifacts\/results\/pad_ufes_20\/final\/final.csv"/);
  assert.doesNotMatch(html, />artifacts\/results\/pad_ufes_20\/final\/final\.csv</);
  assert.match(html, /class="resultMethodList"/);
  assert.doesNotMatch(html, /class="resultTableCards"/);
  assert.match(html, /data-table-key="bus_cot_lesion\/corim" data-format="csv"/);
  assert.match(html, /data-table-key="bus_cot_lesion\/corim" data-format="md"/);
  assert.match(html, /data-table-key="pad_ufes_20\/corim" data-format="csv"/);
  const sourceTableOptions = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]).filter(value => value.endsWith("/final") || value.endsWith("/corim"));
  assert.equal(new Set(sourceTableOptions).size, sourceTableOptions.length);
  assert.match(html, /data-open-result-split data-table-key="pad_ufes_20\/corim"/);
  assert.match(html, /value="pad_ufes_20\/corim"/);
  assert.match(html, /来源：pad_ufes_20 \/ corim/);
  assert.match(html, /id="resultSplitTables" data-details-key="result-split-tables"/);
  assert.match(source, /\.resultTableName \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(source, /\.resultDatasetGroup > summary \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(source, /\.resultDatasetStats \{[^}]*grid-column: 2 \/ -1;/);
  assert.match(source, /data-command="syncAllResultArtifacts"/);
  assert.match(source, /data-command="parseResults"/);
  assert.doesNotMatch(source, /原始数据与详细追溯/);
  assert.doesNotMatch(source, /data-details-key="result-trace-files"/);
  assert.doesNotMatch(source, /\.resultArtifactGroup\[data-details-key="result-trace-files"\]/);
  const rendererSource = source.slice(start, end);
  assert.doesNotMatch(rendererSource, /experiments\/results/);
  const reportHtml = renderer.renderProjectResultTables({ resultSyncReport: { discovered: 20, included: ["Plan A"], missing: ["Plan B"], skipped: ["Plan C"] }, resultOutputConfig: { catalog, tables: catalog.datasets.flatMap(group => group.tables) } });
  assert.match(reportHtml, /发现 20 · 收录 1 · 缺指标 1 · 跳过\/失败 1/);
  assert.match(reportHtml, /<details data-details-key="result-sync-report"><summary>查看 Plan 与 Worker 明细/);
  assert.match(readSource("src/ui/sections/ResultsSection.ts"), /按数据集浏览总表、方法结果与原始文件/);
});

test("multi-dataset summaries without scalar paths have no legacy trace details", () => {
  const summary = {
    datasetResultTables: [{ dataset: "BUS" }, { dataset: "PAD" }],
    rawResultCsvPath: undefined,
    aggregateCsvPath: undefined,
  };
  assert.equal(summary.datasetResultTables.length, 2);
  assert.equal(summary.rawResultCsvPath, undefined);
  assert.equal(summary.aggregateCsvPath, undefined);
  assert.doesNotMatch(source, /data-details-key="result-trace-files"/);
  assert.doesNotMatch(source, /原始数据与详细追溯/);
});

test("split action selects the clicked table and opens the existing split tool", () => {
  const renderer = createRenderer({ state: { planFileInput: "experiments/plans/comparison/corim.yaml" } });
  renderer.openResultSplitToolForTable("pad_ufes_20/corim");
  assert.equal(renderer.resultSplitTableKey, "pad_ufes_20/corim");
  assert.equal(renderer.detailsOpenState["result-split-tables"], true);
  assert.equal(renderer.renderCount, 1);
  const html = renderer.renderProjectResultTables({ resultOutputConfig: { catalog, tables: catalog.datasets.flatMap(group => group.tables) } });
  assert.match(html, /data-details-key="result-split-tables" open/);
  assert.match(html, /来源：pad_ufes_20 \/ corim/);
  assert.match(source, /openResultSplitToolForTable\(splitSource\.dataset\.tableKey \|\| ""\)/);
});

test("multi-dataset plans are logical references for each dataset and shared artifacts stay single-copy", () => {
  const crossPlans = Array.from({ length: 17 }, (_, index) => {
    const key = "cross-plan-" + String(index + 1).padStart(2, "0");
    const artifacts = Array.from({ length: index < 14 ? 13 : 12 }, (_, fileIndex) => {
      const artifactKey = "artifact-" + key + "-" + fileIndex;
      return { artifactKey, kind: ["raw", "detail", "trace"][fileIndex % 3], workerId: "worker-" + (fileIndex % 2), path: "artifacts/results/_shared/" + artifactKey + ".csv" };
    });
    return { planFile: "experiments/plans/comparison/" + key + ".yaml", planKey: key, assignment: { kind: "multiple", datasets: ["bus_cot_lesion", "pad_ufes_20"] }, artifacts };
  });
  const multiCatalog = {
    datasets: [
      { dataset: "pad_ufes_20", datasetKey: "pad_ufes_20", tables: [finalTable("pad_ufes_20", 34, "pad/final.csv"), ...Array.from({ length: 17 }, (_, index) => methodTable("pad_ufes_20", "method-" + index, "pad/method-" + index + ".csv"))], plans: [] },
      { dataset: "bus_cot_lesion", datasetKey: "bus_cot_lesion", tables: [finalTable("bus_cot_lesion", 34, "bus/final.csv"), ...Array.from({ length: 17 }, (_, index) => methodTable("bus_cot_lesion", "method-" + index, "bus/method-" + index + ".csv"))], plans: [] },
      { dataset: "_shared", datasetKey: "_shared", tables: [], plans: crossPlans },
    ],
    multiDatasetPlans: crossPlans,
    unassignedPlans: [],
    legacyTables: [],
  };
  const renderer = createRenderer({ state: { planFileInput: crossPlans[0].planFile } });
  const view = renderer.resultCatalogViewModel(multiCatalog, { planFileInput: crossPlans[0].planFile });
  assert.deepEqual(Array.from(view.datasets, item => item.datasetKey), ["bus_cot_lesion", "pad_ufes_20"]);
  for (const dataset of view.datasets) {
    assert.equal(dataset.physicalPlanCount, 0);
    assert.equal(dataset.associatedPlanCount, 17);
    assert.equal(dataset.associatedPlans.length, 17);
  }
  assert.equal(view.selectedPlanDatasetKey, "");
  assert.equal(view.defaultDatasetKey, "bus_cot_lesion");
  assert.equal(view.shared.planCount, 17);
  assert.equal(view.shared.artifactCount, 218);
  assert.equal(view.unassigned.planCount, 0);

  const html = renderer.renderProjectResultTables({ resultOutputConfig: { catalog: multiCatalog, tables: multiCatalog.datasets.flatMap(group => group.tables) } });
  assert.equal((html.match(/涉及 Plan 17/g) || []).length, 2);
  assert.doesNotMatch(html, /Plan 0/);
  assert.match(html, /跨数据集 Plan 与共享产物（17 个 Plan · 218 个文件）/);
  assert.match(html, /原始数据（/);
  assert.match(html, /详细聚合（/);
  assert.match(html, /追溯文件（/);
  assert.doesNotMatch(html, /跨数据集原始来源/);
  assert.doesNotMatch(html, /待处理|尚未识别 Plan/);
  assert.equal((html.match(/data-open-result-shared-plan/g) || []).length, 34);
  assert.equal((html.match(/artifacts\/results\/_shared\/artifact-/g) || []).length, 218);
  assert.match(html, /跨数据集 · bus_cot_lesion、pad_ufes_20/);
  assert.match(html, /查看共享产物/);
  assert.match(source, /\.resultDatasetGroup > summary \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto; align-items: center; justify-content: initial;/);
  assert.match(source, /\.resultDatasetStats \{ grid-column: 3;/);
  assert.match(source, /@container main-workflow \(max-width: 520px\)[\s\S]*?\.resultDatasetStats \{ grid-column: 2 \/ -1;/);
});

test("shared Plan link opens and scrolls to its advanced artifact detail", () => {
  let scrolled = false;
  const key = "cross-plan-01";
  const renderer = createRenderer({ scrollTarget: { dataset: { detailsKey: "result-plan-shared-sources-" + key }, scrollIntoView: () => { scrolled = true; } } });
  renderer.openSharedArtifactsForPlan(key);
  assert.equal(renderer.detailsOpenState["result-advanced-sources"], true);
  assert.equal(renderer.detailsOpenState["result-shared-sources"], true);
  assert.equal(renderer.detailsOpenState["result-plan-shared-sources-" + key], true);
  assert.equal(renderer.renderCount, 1);
  assert.equal(scrolled, true);
  assert.match(source, /openSharedArtifactsForPlan\(sharedPlanSource\.dataset\.planKey \|\| ""\)/);
});

test("same-name Plans display distinct paths while dataset references and manual expansion remain stable", () => {
  const normal = { ...plan("experiments/plans/comparison/concatenation.yaml", "normal-concatenation"),
    assignment: { kind: "multiple", datasets: ["bus_cot_lesion", "pad_ufes_20"] } };
  const tuning = plan("experiments/plans/comparison_tuning/concatenation.yaml", "tuning-concatenation");
  const sameNameCatalog = { datasets: [
    { dataset: "bus_cot_lesion", datasetKey: "bus_cot_lesion", tables: [finalTable("bus_cot_lesion", 2, "bus/final.csv")], plans: [] },
    { dataset: "pad_ufes_20", datasetKey: "pad_ufes_20", tables: [finalTable("pad_ufes_20", 8, "pad/final.csv")], plans: [tuning] },
    { dataset: "_shared", datasetKey: "_shared", tables: [], plans: [normal] },
  ], multiDatasetPlans: [normal], legacyTables: [] };
  const renderer = createRenderer();
  const state = { planFileInput: tuning.planFile, resultOutputConfig: { catalog: sameNameCatalog, tables: sameNameCatalog.datasets.flatMap(group => group.tables) } };
  const view = renderer.resultCatalogViewModel(sameNameCatalog, state);
  assert.equal(view.defaultDatasetKey, "pad_ufes_20");
  assert.equal(view.datasets.find(group => group.datasetKey === "pad_ufes_20").associatedPlanCount, 2);
  assert.equal(view.datasets.find(group => group.datasetKey === "bus_cot_lesion").associatedPlanCount, 1);
  renderer.detailsOpenState["result-dataset-pad_ufes_20"] = false;
  renderer.detailsOpenState["result-dataset-plans-pad_ufes_20"] = true;
  const html = renderer.renderProjectResultTables(state);
  assert.match(html, /resultPlanReferenceName">comparison\/concatenation.yaml</);
  assert.match(html, /resultPlanReferenceName">comparison_tuning\/concatenation.yaml</);
  assert.match(html, /data-details-key="result-plan-shared-sources-normal-concatenation"[^>]*><summary[^>]*>comparison\/concatenation.yaml/);
  assert.match(html, /data-details-key="result-dataset-pad_ufes_20"(?! open)/);
  assert.match(html, /data-details-key="result-dataset-plans-pad_ufes_20" open/);
  const uniqueCatalog = { ...sameNameCatalog, datasets: sameNameCatalog.datasets.map(group => ({ ...group, plans: group.datasetKey === "pad_ufes_20" ? [] : group.plans })) };
  const uniqueHtml = renderer.renderProjectResultTables({ resultOutputConfig: { catalog: uniqueCatalog, tables: [] } });
  assert.match(uniqueHtml, /resultPlanReferenceName">concatenation.yaml</, "repeated references to a single Plan do not qualify its label");
});

test("Plan labels use enough parent directories to distinguish deeper name collisions", () => {
  const plans = [plan("experiments/plans/train/shared/model.yaml", "train"), plan("experiments/plans/test/shared/model.yaml", "test")];
  const renderer = createRenderer();
  const html = renderer.renderProjectResultTables({ resultOutputConfig: { catalog: {
    datasets: [{ dataset: "dataset", datasetKey: "dataset", plans, tables: [] }], legacyTables: [],
  }, tables: [] } });
  assert.match(html, /resultPlanReferenceName">train\/shared\/model.yaml</);
  assert.match(html, /resultPlanReferenceName">test\/shared\/model.yaml</);
});

test("split tool is reset only at fresh document initialization", () => {
  assert.match(source, /let detailsOpenState = restoredTransientPanelState\.detailsOpenState \|\| \{\};\s*detailsOpenState\["execution-full-records"\] = false;\s*detailsOpenState\["result-split-tables"\] = false;/);
  assert.match(source, /\.resultDatasetGroup > summary \{ display: grid;/);
});
