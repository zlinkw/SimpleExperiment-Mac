const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
Module._extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
const sourcePath = path.join(__dirname, "..", "..", "src", "results", "ProjectResultTables.ts");
const sourceModule = new Module(sourcePath, module);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
sourceModule._compile(ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, sourcePath);
const tables = sourceModule.exports;

const plan = "experiments/plans/comparison/demo.yaml";
function record(workerId, method, caseName, seed, endpoint, metric, value, rate = "0.3") {
  return {
    workerId,
    planRevision: "rev1",
    method,
    dimensions: { method, case: caseName, seed, dataset: "bus", train_rate: rate, eval_protocol: endpoint },
    sourceFiles: [{ path: "experiments/results/demo.csv" }],
    metrics: { [metric]: { value } },
  };
}
function summary(rows) {
  return {
    planFile: plan,
    planRevision: "rev1",
    workerResultTables: [
      { workerId: "w1", rawResultCsvPath: "experiments/results/demo.csv", aggregateStatus: "ready" },
      { workerId: "w2", rawResultCsvPath: "experiments/results/demo.csv", aggregateStatus: "ready" },
    ],
    results: rows,
  };
}

test("stale Agent result revision cannot replace a revised local Plan", () => {
  assert.equal(tables.summaryMatchesPlanRevision({ planRevision: "old" }, { revision: "new" }), false);
  assert.equal(tables.summaryMatchesPlanRevision({ planRevision: "new" }, { revision: "new" }), true);
  assert.equal(tables.summaryMatchesPlanRevision({}, { revision: "new" }), true);
});

test("registry mutations preserve the publication base generation for optimistic conflict checks", () => {
  const previous = { ...tables.emptyTableRegistry(), publicationGeneration: "generation-7" };
  const updated = tables.updateRegistry(previous, summary([record("w1", "demo", "c1", 0, "clean", "acc", 0.5)]), plan, 1);
  assert.equal(updated.publicationGeneration, "generation-7");
  const merged = tables.mergeAvailableWorkerResults(updated, {
    ...summary([record("w2", "demo", "c1", 1, "clean", "acc", 0.6)]),
    workerResultTables: [{ workerId: "w2", rawResultCsvPath: "experiments/results/demo.csv", aggregateStatus: "ready" }],
  }, plan, 2);
  assert.equal(merged.publicationGeneration, "generation-7");
  assert.equal(tables.applyPlanDatasetOverrides(merged, {}).publicationGeneration, "generation-7");
});

test("complete recovered wrapper replaces legacy same-run endpoints without borrowing anonymous records", () => {
  const legacy = { ...record('w1', 'demo', 'c1', 42, 'legacy-endpoint', 'acc', .7), runId: 'B' };
  const previous = tables.updateRegistry(tables.emptyTableRegistry(), summary([legacy]), plan, 1);
  const job = { runId: 'B', case: 'c1', seed: 42, workerId: 'w1', outputDir: 'work_dirs/demo/attempts/B' };
  const checkpointPath = job.outputDir + '/best.pth';
  const fresh = { ...summary([{ ...record('w1', 'demo', 'c1', 42, 'clean', 'acc', .8), runId: 'B', jobDir: job.outputDir, checkpointPath }]),
    completedRunId: 'B', recoveredCompletedJobs: true,
    wrapperEvidence: { status: 'formal', runId: 'B', jobs: [{ job, checkpointPath }], expectedJobs: [{ case: 'c1', seed: 42 }] } };
  const merged = tables.mergeAvailableWorkerResults(previous, fresh, plan, 1);
  assert.equal(merged.plans[plan].records.length, 1);
  assert.equal(merged.plans[plan].records[0].jobDir, job.outputDir);
  assert.equal(merged.plans[plan].records[0].checkpointPath, checkpointPath);
});

test("global and method tables recompute seed means across Workers, deduplicate and mark incomplete", () => {
  const s = summary([
    record("w1", "demo", "bus_p30", 42, "clean", "acc", 0.2),
    record("w2", "demo", "bus_p30", 43, "clean", "acc", 0.4),
    record("w2", "demo", "bus_p30", 43, "clean", "acc", 0.4),
    record("w1", "demo", "bus_p30", 42, "clean", "loss", 0.5),
    record("w2", "demo", "bus_p30", 43, "clean", "loss", 0.3),
    { ...record("w1", "demo", "bus_p30", 42, "clean", "acc", 9), sourceFiles: [{ path: "work_dirs/stale/metrics.csv" }] },
  ]);
  const registry = tables.updateRegistry(tables.emptyTableRegistry(), s, plan, 5);
  const output = tables.buildTables(registry);
  assert.deepEqual(Object.keys(output).sort(), ["bus/final", "bus/method/demo"]);
  assert.equal(output["bus/final"].rows.length, 1);
  const row = output["bus/final"].rows[0];
  assert.equal(row[output["bus/final"].header.indexOf("jobs")], "2/5");
  assert.equal(row[output["bus/final"].header.indexOf("rate_percent")], "30");
  assert.equal(row[output["bus/final"].header.indexOf("accuracy_mean")], "");
  assert.equal(row[output["bus/final"].header.indexOf("accuracy_sd")], "");
  assert.equal(output["bus/method/demo"].rows.length, 1);
  assert.match(output["bus/final"].markdown, /2\/5/);
  assert.match(output["bus/final"].markdown, /—/);
});

test("a metric missing from one of five seeds cannot be published as a five-seed mean", () => {
  const rows = [42, 43, 44, 45, 46].flatMap((seed) => [
    record("w1", "corim", "corim_pad_p100", seed, "clean", "AUC", 0.8),
    ...(seed === 44 ? [] : [record("w1", "corim", "corim_pad_p100", seed, "clean", "precision_macro", 0.6)]),
  ]);
  const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary(rows), plan, 5);
  const output = tables.buildTables(registry)["bus/final"];
  const row = output.rows[0];
  assert.equal(row[output.header.indexOf("jobs")], "4/5");
  assert.equal(row[output.header.indexOf("roc_auc_mean")], 0.8);
  assert.equal(row[output.header.indexOf("precision_macro_mean")], "");
  assert.equal(row[output.header.indexOf("precision_macro_sd")], "");
});

test("same seed conflicting values block publication", () => {
  const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    record("w1", "demo", "bus_p30", 42, "clean", "acc", 0.2),
    record("w2", "demo", "bus_p30", 42, "clean", "acc", 0.4),
  ]), plan, 1);
  assert.throws(() => tables.buildTables(registry), /指标冲突/);
});

test("equivalent metric aliases deduplicate per seed while raw registry keys stay intact", () => {
  const rows = [
    { ...record("w1", "demo", "bus_p30", 42, "clean", "AUC", 0.8), metrics: { AUC: { value: 0.8 }, roc_auc: { value: 0.8 }, ECE: { value: 0.1 }, ece: { value: 0.1 }, f1_macro: { value: 0.7 }, macro_f1: { value: 0.7 } } },
    { ...record("w1", "demo", "bus_p30", 43, "clean", "AUC", 0.6), metrics: { auc: { value: 0.6 }, ECE: { value: 0.3 }, macro_f1: { value: 0.5 } } },
  ];
  const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary(rows), plan, 2);
  assert.deepEqual(Object.keys(registry.plans[plan].records[0].metrics).sort(), ["AUC", "ECE", "ece", "f1_macro", "macro_f1", "roc_auc"].sort());
  const output = tables.buildTables(registry)["bus/final"];
  assert.equal(output.header.filter((name) => name === "roc_auc_mean").length, 1);
  assert.equal(output.header.filter((name) => name === "ece_mean").length, 1);
  assert.equal(output.header.filter((name) => name === "macro_f1_mean").length, 1);
  assert.equal(output.rows[0][output.header.indexOf("roc_auc_mean")], 0.7);
  assert.ok(Math.abs(output.rows[0][output.header.indexOf("roc_auc_sd")] - Math.sqrt(0.02)) < 1e-12);
  assert.equal(output.rows[0][output.header.indexOf("ece_mean")], 0.2);
  assert.ok(Math.abs(output.rows[0][output.header.indexOf("ece_sd")] - Math.sqrt(0.02)) < 1e-12);
  assert.equal(output.rows[0][output.header.indexOf("macro_f1_mean")], 0.6);
  assert.match(output.markdown, /0\.7000 ± 0\.1414/);
});

test("all declared metric families use stable canonical columns and unknown metrics remain distinct", () => {
  const families = {
    AUC: ["auc", "auroc", "roc_auc"], AUPRC: ["AP", "average_precision", "auprc", "pr_auc"],
    accuracy: ["ACC", "acc", "accuracy"], brier: ["brier", "brier_score"], F1: ["F1", "f1", "f1_score"],
    macro_f1: ["f1_macro", "macro_f1"], micro_f1: ["f1_micro", "micro_f1"],
    weighted_f1: ["f1_score_weighted", "f1_weighted", "weighted_f1"], recall: ["recall", "sensitivity"], ECE: ["ECE", "ece"],
  };
  const metrics = Object.fromEntries(Object.values(families).flatMap((aliases) => aliases.map((name) => [name, { value: 0.5 }])));
  metrics.custom_A = { value: 1 };
  metrics.custom_B = { value: 1 };
  const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    { ...record("w1", "demo", "bus_p30", 42, "clean", "unused", 0), metrics },
  ]), plan, 1);
  const output = tables.buildTables(registry)["bus/final"];
  for (const name of ["roc_auc", "auprc", "accuracy", "brier_score", "f1_score", "macro_f1", "micro_f1", "weighted_f1", "recall", "ece", "custom_a", "custom_b"])
    assert.ok(output.header.includes(name + "_mean"), name);
  assert.equal(output.header.filter((name) => name.endsWith("_mean")).length, Object.keys(families).length + 2);
});

test("conflicting aliases fail before the caller can replace its prior table", () => {
  const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    { ...record("w1", "demo", "bus_p30", 42, "clean", "AUC", 0.8), metrics: { AUC: { value: 0.8 }, roc_auc: { value: 0.7 } } },
  ]), plan, 1);
  assert.throws(() => tables.buildTables(registry), /等价指标值冲突/);
});

test("offline Worker and untrusted identity do not overwrite registry", () => {
  const offline = summary([record("w1", "demo", "bus_p30", 42, "clean", "acc", 0.2)]);
  offline.unavailableWorkerIds = ["w2"];
  assert.throws(() => tables.updateRegistry(tables.emptyTableRegistry(), offline, plan, 5), /Worker 离线/);
  const untrusted = summary([record("w1", "demo", "", 42, "clean", "acc", 0.2)]);
  assert.throws(() => tables.updateRegistry(tables.emptyTableRegistry(), untrusted, plan, 5), /case 或 seed/);
});

test("local rebuild merges ready Workers and retains earlier Worker records", () => {
  const previous = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    record("w1", "demo", "bus_p30", 42, "clean", "acc", 0.2),
  ]), plan, 2);
  const partial = summary([
    record("w2", "demo", "bus_p30", 43, "clean", "acc", 0.4),
  ]);
  partial.workerResultTables[0].aggregateStatus = "no_declared_csv";
  partial.workerResultTables[0].rawResultCsvPath = "";
  partial.unavailableWorkerIds = ["w3"];
  partial.incompleteAggregate = true;
  const merged = tables.mergeAvailableWorkerResults(previous, partial, plan, 2);
  assert.deepEqual(merged.plans[plan].records.map((row) => row.workerId).sort(), ["w1", "w2"]);
  assert.equal(tables.buildTables(merged)["bus/final"].rows.length, 1);
  assert.strictEqual(tables.mergeAvailableWorkerResults(previous, { ...partial, results: [] }, plan, 2), previous);
});

test("completed cross-Worker rerun replaces older Worker results for the same Plan", () => {
  const older = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    record("w1", "demo", "bus_p30", 42, "clean", "acc", 0.2),
  ]), plan, 1);
  const incoming = tables.summaryForWorker(summary([
    record("w1", "demo", "bus_p30", 42, "clean", "acc", 0.2),
    record("w2", "demo", "bus_p30", 42, "clean", "acc", 0.7),
  ]), "w2");
  const updated = tables.updateRegistry(older, incoming, plan, 1);
  assert.deepEqual(updated.plans[plan].records.map((row) => row.workerId), ["w2"]);
  assert.equal(tables.buildTables(updated)["bus/final"].rows[0][tables.buildTables(updated)["bus/final"].header.indexOf("accuracy_mean")], 0.7);
});

test("authoritative rerun does not retain anonymous rows from the same revision", () => {
  const previous = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    record("w1", "demo", "bus_p100", 42, "p0 Full", "AUROC", 0.11),
  ]), plan, 1);
  const current = summary([
    { ...record("w1", "demo", "bus_p100", 42, "p0 Full", "AUROC", 0.91), runId: "run-b", attempt: "1" },
  ]);
  current.completedRunId = "run-b";
  const merged = tables.mergeAvailableWorkerResults(previous, current, plan, 1);
  assert.deepEqual(merged.plans[plan].records.map((item) => [item.runId, item.metrics.AUROC]), [["run-b", 0.91]]);
});

test("CSV splitting supports manual value and column selection with quoted cells", () => {
  const source = tables.writeCsv(["result_family", "rate_percent", "note", "acc_mean"], [
    ["demo", "0", "a,b", 0.1],
    ["demo", "30", "a\nb", 0.2],
    ["demo", "70", "x", 0.3],
  ]);
  const split = tables.splitCsvByValues(source, "rate_percent", ["0", "30"], ["rate_percent", "note", "acc_mean"]);
  assert.deepEqual(Object.keys(split), ["0", "30"]);
  assert.deepEqual(tables.readCsv(split["0"]).rows[0], ["0", "a,b", "0.1"]);
  assert.deepEqual(tables.readCsv(split["30"]).rows[0], ["30", "a\nb", "0.2"]);
  assert.throws(() => tables.splitCsvByValues(source, "missing", ["0"], []), /不存在/);
  assert.throws(() => tables.splitCsvByValues(source, "rate_percent", ["0"], []), /保留列无效/);
});

test("optional endpoint difference uses paired seeds and a separate output column", () => {
  const registry = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    record("w1", "demo", "bus_p30", 42, "clean", "AUC", 0.8),
    record("w1", "demo", "bus_p30", 42, "p100_low", "AUC", 0.7),
    record("w2", "demo", "bus_p30", 43, "clean", "AUC", 0.9),
    record("w2", "demo", "bus_p30", 43, "p100_low", "AUC", 0.6),
  ]), plan, 2);
  registry.derivedMetric = { metric: "AUC", leftEndpoint: "clean", rightEndpoint: "p100_low", outputName: "ba_drop_pp", scale: 100 };
  const result = tables.buildTables(registry)["bus/final"];
  assert.equal(result.rows.length, 2);
  assert.ok(result.header.includes("roc_auc_mean"));
  assert.ok(result.header.includes("ba_drop_pp_mean"));
  assert.ok(Math.abs(result.rows[0][result.header.indexOf("ba_drop_pp_mean")] - 20) < 1e-12);
});

test("global final includes multiple Plans and keeps a method named final in its own folder", () => {
  const first = tables.updateRegistry(tables.emptyTableRegistry(), summary([
    record("w1", "demo", "bus_p30", 42, "clean", "acc", 0.2),
  ]), plan, 1);
  const secondPlan = "experiments/plans/final.yaml";
  const other = { ...summary([record("w1", "final", "bus_p70", 42, "clean", "acc", 0.9, "0.7")]), planFile: secondPlan };
  const registry = tables.updateRegistry(first, other, secondPlan, 1);
  const output = tables.buildTables(registry);
  assert.deepEqual(Object.keys(output).sort(), ["bus/final", "bus/method/_method_final", "bus/method/demo"]);
  assert.equal(output["bus/final"].rows.length, 2);
  assert.ok(output["bus/final"].header.includes("plan_file"));
  assert.deepEqual(output["bus/final"].rows.map((row) => row[output["bus/final"].header.indexOf("plan_file")]).sort(), [plan, secondPlan].sort());
  assert.deepEqual(output["bus/final"].rows.map((row) => row[output["bus/final"].header.indexOf("jobs")]).sort(), ["1", "1"]);
  assert.equal(output["bus/method/_method_final"].rows.length, 1);
});

test("completed run selection follows the explicit run and keeps complementary metrics", () => {
  const selected = tables.selectLatestCompletedRun([
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.8 }, runId: "run-a", attempt: "1", revision: "r1" },
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { F1: 0.7 }, runId: "run-a", attempt: "2", revision: "r1" },
    { planFile: plan, workerId: "w1", case: "alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.1 }, runId: "run-a", attempt: "1", revision: "r1" },
  ], "run-a");
  assert.equal(selected.length, 2);
  assert.equal(selected.find((row) => row.case === "Alpha" && row.attempt === "2").metrics.F1, 0.7);
  assert.equal(selected.find((row) => row.case === "Alpha" && row.attempt === "2").metrics.AUC, undefined);
  const chosen = tables.selectLatestCompletedRun([
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.8 }, runId: "run-b", attempt: "1", revision: "r1" },
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.1 }, runId: "run-a", attempt: "1", revision: "r1" },
  ], "run-a");
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].metrics.AUC, 0.1);
  const retried = tables.selectLatestCompletedRun([
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.2, F1: 0.4 }, runId: "run-a", attempt: "1", revision: "r1" },
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.9 }, runId: "run-a", attempt: "2", revision: "r1" },
  ], "run-a");
  assert.deepEqual(retried[0].metrics, { AUC: 0.9 });
  const previous = tables.updateRegistry(tables.emptyTableRegistry(), summary([record("w1", "demo", "bus_p30", 2, "clean", "acc", 0.2)]), plan, 2);
  previous.plans[plan].revision = "old";
  const incoming = summary([record("w1", "demo", "bus_p30", 1, "clean", "acc", 0.8)]);
  incoming.planRevision = "new";
  const merged = tables.mergeAvailableWorkerResults(previous, incoming, plan, 2);
  assert.deepEqual(merged.plans[plan].records.map((item) => item.seed), ["1"]);
  assert.throws(() => tables.selectLatestCompletedRun([
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.8 }, runId: "run-z", attempt: "9", revision: "r1" },
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.1 }, runId: "run-a", attempt: "1", revision: "r1" },
  ]), /多个完成 run/);
  assert.throws(() => tables.selectLatestCompletedRun([
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.8 }, runId: "run-a", attempt: "job-left", revision: "r1" },
    { planFile: plan, workerId: "w1", case: "Alpha", seed: "1", method: "demo", dataset: "bus", rate: "30", endpoint: "clean", metrics: { AUC: 0.9 }, runId: "run-a", attempt: "job-right", revision: "r1" },
  ], "run-a"), /无法比较的 attempt/);
});

 test("dataset is a storage and pairing boundary, with missing and colliding names explicit", () => {
  const registry = tables.emptyTableRegistry();
  const make = (dataset, endpoint, seed = 1) => ({...record("w1", "demo", "same", seed, endpoint, "accuracy", .8), dimensions: {method: "demo", case: "same", seed, dataset, eval_protocol: endpoint}});
  for (const [file, dataset, endpoint] of [[plan, "BUS", "clean"], ["experiments/plans/other/demo.yaml", "PAD", "noise"], ["experiments/plans/third/demo.yaml", "BUS", "clean"]]) {
    const updated = tables.updateRegistry(registry, {...summary([make(dataset, endpoint)]), planFile: file}, file, 1);
    registry.plans = updated.plans;
  }
  const built = tables.buildTables(registry);
  assert.deepEqual(Object.keys(built).sort(), ["BUS/final", "BUS/method/demo", "PAD/final", "PAD/method/demo"]);
  for (const table of Object.values(built)) {
    assert.deepEqual([...new Set(table.rows.map(row => row[table.header.indexOf("dataset")]))], [table.dataset]);
    assert.ok(table.header.includes("plan_file"));
    assert.match(table.relativePath, new RegExp("^" + table.dataset + "/"));
  }
  assert.equal(built["BUS/final"].rows.length, 2);
  assert.notEqual(tables.planDirectoryKey(plan), tables.planDirectoryKey("experiments/plans/other/demo.yaml"));
  assert.equal(tables.datasetPathKey(""), "_unassigned");
  for (const name of ["../escape", "a/b", "C:drive", "CON", "_shared"]) assert.throws(() => tables.datasetPathKey(name));
  assert.throws(() => tables.datasetPartitions(["A B", "A?B"]), /同一目录/);
  assert.throws(() => tables.datasetPartitions(["BUS", "bus"]), /同一目录/);
 });

test("plan dataset assignment prefers trusted multi-dataset records and persists normalized manual fallbacks", () => {
  const assignment = tables.resolvePlanDatasetAssignment({historicalRecords: [{dataset: "BUS"}, {dataset: "PAD"}], manualMapping: {datasets: ["CPSC"]}});
  assert.deepEqual(assignment, {kind: "multiple", datasets: ["BUS", "PAD"], source: "historical-registry", conflict: {actual: ["BUS", "PAD"], mapped: ["CPSC"]}});
  assert.equal(tables.resolvePlanDatasetAssignment({historicalRecords: []}).kind, "unassigned");
  assert.equal(tables.normalizePlanDatasetKey(".\\experiments\\plans\\a\\demo.yaml"), "experiments/plans/a/demo.yaml");
  assert.notEqual(tables.normalizePlanDatasetKey("experiments/plans/a/demo.yaml"), tables.normalizePlanDatasetKey("experiments/plans/b/demo.yaml"));
  const registry = {schemaVersion: 1, plans: {[plan]: {revision: "rev1", expectedSeeds: 1, records: [{planFile: plan, workerId: "w1", case: "c", seed: "1", method: "demo", dataset: "", rate: "", endpoint: "clean", metrics: {accuracy: .8}}]}}};
  const mapping = {".\\experiments\\plans\\comparison\\demo.yaml": {datasets: ["PAD"], source: "manual"}};
  const applied = tables.applyPlanDatasetOverrides(registry, mapping);
  assert.equal(applied.plans[plan].records[0].dataset, "PAD");
  assert.equal(applied.plans[plan].records[0].datasetSource, "manual-plan-mapping");
  assert.equal(registry.plans[plan].records[0].dataset, "");
  assert.equal(tables.registeredPlanSummary(applied, plan).results[0].datasetSource, "manual-plan-mapping");
  const actualSummary = summary([record("w1", "demo", "same", "1", "clean", "accuracy", .9)]);
  actualSummary.results[0].dimensions.dataset = "BUS";
  const actual = tables.recordsForSummary(actualSummary, plan, mapping);
  assert.equal(actual[0].dataset, "BUS");
  assert.equal(actual[0].datasetSource, undefined);
  const missingDatasetSummary = summary([record("w1", "demo", "same", "1", "clean", "accuracy", .9)]);
  missingDatasetSummary.results[0].dimensions.dataset = "";
  const inherited = tables.recordsForSummary(missingDatasetSummary, plan, mapping);
  assert.equal(inherited[0].dataset, "PAD");
  assert.equal(inherited[0].datasetSource, "manual-plan-mapping");
});
