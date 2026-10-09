const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PLAN_REGISTRY_LOCAL_PATH,
  builtInPlanSchemas,
  builtInPlanTemplates,
  cloneOrReproducePlan,
  computePlanResultCoverage,
  createPlanRevision,
  dependencyBlockedReasons,
  deprecatePlan,
  diffPlans,
  estimatePlanResources,
  expandPlanMatrix,
  importLegacyPlanYamlToRegistry,
  readPlanConfigJson,
  renderPlanTemplate,
  searchPlans,
  tagPlan,
  upsertPlanRecords,
  validatePlanRecord,
  validateTemplateVariables,
} = require("../dist/features/PlanBuilder.js");

test("legacy plan yaml imports into stable plan registry record", () => {
  const yaml = [
    "suite: smoke",
    "base_config: configs/base.yaml",
    "cases:",
    "  - name: a",
    "  - name: b",
  ].join("\n");
  const record = importLegacyPlanYamlToRegistry("experiments/plans/smoke.yaml", yaml);
  assert.equal(PLAN_REGISTRY_LOCAL_PATH, "simple_cluster/plans/plan_registry.local.json");
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.suite, "smoke");
  assert.equal(record.experimentCount, 2);
  assert.equal(record.plannedExperiments[0].runKey, "smoke:a");
  assert.equal(upsertPlanRecords([], [record])[0].planId, record.planId);
  assert.equal(deprecatePlan(record).status, "deprecated");
});

test("plan schema and template validate and render without overwriting built-ins", () => {
  const schema = builtInPlanSchemas.find((item) => item.id === "medical_segmentation_plan");
  const template = builtInPlanTemplates.find((item) => item.id === "medical_segmentation_ablation");
  assert.equal(schema.defaultResultSchemaId, "medical_segmentation");
  assert.equal(validateTemplateVariables(template, { suite: "abl" }).length, 0);
  const files = renderPlanTemplate(template, { suite: "abl", base_config: "configs/base.yaml", dataset: "VinDr", seed: "42" });
  assert.match(files[0].relativePath, /abl\.ablation\.yaml/);
  assert.match(files[0].content, /suite: abl/);
});

test("matrix expansion supports grid paired fixed derived conditional and constraints", () => {
  const result = expandPlanMatrix({
    variables: [
      { key: "missing_rate", mode: "grid", values: [0, 0.3] },
      { key: "noise_type", mode: "paired", values: ["none", "gaussian"] },
      { key: "noise_level", mode: "paired", values: [0, 0.1] },
      { key: "gpu_count", mode: "fixed", values: [2] },
      { key: "batch_size", mode: "fixed", values: [4] },
      { key: "batch_budget", mode: "derived", expression: "batch_size * gpu_count" },
      { key: "missing_strategy", mode: "conditional", when: "missing_rate == 0", expression: "none" },
    ],
    constraints: [
      { id: "noise", expression: "noise_type == none -> noise_level == 0", message: "noise none zero" },
      { id: "budget", expression: "batch_size * gpu_count <= 8", message: "budget" },
    ],
    namingRule: { pattern: "{{suite}}_mr{{missing_rate}}_{{noise_type}}", sanitize: true },
  }, [], "suite");
  assert.equal(result.errors.length, 0);
  assert.equal(result.experiments.length, 4);
  assert.match(result.previewCsv, /experimentKey/);
  assert.equal(new Set(result.experiments.map((item) => item.experimentKey)).size, result.experiments.length);
});

test("matrix expansion consumes existing run keys once and indexes generated duplicates", () => {
  let iteratorCount = 0;
  const existingRunKeys = {
    [Symbol.iterator]() {
      iteratorCount += 1;
      if (iteratorCount > 1) throw new Error("existing run keys iterated more than once");
      return ["suite:suite_a"][Symbol.iterator]();
    },
  };
  const result = expandPlanMatrix({
    variables: [{ key: "model", mode: "grid", values: ["a", "a", "b"] }],
    namingRule: { pattern: "{{suite}}_{{model}}", sanitize: true },
  }, existingRunKeys, "suite");

  assert.equal(iteratorCount, 1);
  assert.deepEqual(result.duplicateRunKeys, ["suite:suite_a"]);
  assert.deepEqual(result.experiments.map((item) => item.runKey), ["suite:suite_a", "suite:suite_a", "suite:suite_b"]);
});

test("plan validation and resource estimate expose warnings not hard blocks", () => {
  const record = importLegacyPlanYamlToRegistry("p.yaml", "suite: s\ncases:\n  - name: a\n  - name: a\n");
  record.resourceEstimate = estimatePlanResources(record.experimentCount, { estimatedDiskGb: 100, requiredGpuMemoryMb: 24000 }, [{ serverId: "w1", freeDiskGb: 10, gpuMemoryMb: 8000 }]);
  const result = validatePlanRecord(record, { schemas: builtInPlanSchemas, templates: builtInPlanTemplates, existingExperimentKeys: [record.plannedExperiments[0].experimentKey] });
  assert.equal(result.status, "warning");
  assert.equal(result.duplicateExperiments.length > 0, true);
  assert.equal(record.resourceEstimate.warnings.length, 2);
});

test("plan revision diff and clone/reproduce preserve provenance", () => {
  const source = importLegacyPlanYamlToRegistry("p.yaml", "suite: s\nbase_config: c\ncases:\n  - name: a\n  - name: b\n");
  source.plannedExperiments[0].status = "completed";
  source.plannedExperiments[1].status = "failed";
  const revision = createPlanRevision(source.planId, "suite: s\n", "edit", "manual_edit", source);
  assert.equal(revision.changedFields.includes("planSha256"), true);
  const clone = cloneOrReproducePlan(source, { mode: "retry_failed", overrides: { seed: 7 }, skipCompleted: true });
  assert.equal(clone.experimentCount, 1);
  assert.equal(clone.provenance.parentPlanId, source.planId);
  assert.match(diffPlans(source, clone), /experiments_/);
});

test("plan search, tags, dependencies, coverage, and config fallback work", () => {
  let plan = importLegacyPlanYamlToRegistry("p.yaml", "suite: s\nbase_config: c\ncases:\n  - name: a\n");
  plan = tagPlan({ ...plan, status: "failed", favorite: true }, "rerun-needed");
  assert.equal(searchPlans([plan], { status: "failed", tag: "rerun-needed", favorite: true }).length, 1);
  plan.dependencies = [{ id: "d", from: "stage1", to: "stage2", type: "stage", condition: { type: "completed" } }];
  assert.deepEqual(dependencyBlockedReasons(plan, []).stage2, ["blocked by stage1:completed"]);
  const coverage = computePlanResultCoverage(plan, [{ experimentKey: plan.plannedExperiments[0].experimentKey, state: "completed" }], [{ experimentId: plan.plannedExperiments[0].experimentKey, status: "parsed", metrics: { DSC: { value: 0.9 } } }], "DSC");
  assert.equal(coverage.completedCount, 1);
  assert.equal(coverage.bestByMetric.DSC.value, 0.9);
  const fallback = readPlanConfigJson("{bad", Array.isArray, [1]);
  assert.equal(fallback.ok, false);
  assert.deepEqual(fallback.value, [1]);
});
