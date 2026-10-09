const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadFeature(name) {
  const source = fs.readFileSync(path.join(__dirname, "../../src/features/" + name + ".ts"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(code, { exports: loaded.exports, module: loaded, Buffer, Object, Array, Set, Map, Number, String, Math });
  return loaded.exports;
}

const projection = loadFeature("PanelStateProjection");
const payload = loadFeature("PanelStatePayload");
const planStatus = loadFeature("PanelPlanStatusSummary");

test("serialized state attribution reports UTF-8 bytes per top-level field and bounded top eight", () => {
  const state = {
    alpha: "你好🙂",
    beta: [1, 2, 3],
    gamma: { nested: true },
    delta: "d",
    epsilon: "e",
    zeta: "z",
    eta: "η",
    theta: "θ",
    iota: "ι",
  };
  const message = JSON.stringify({ type: "state", seq: 1, state });
  const measuredBytes = Buffer.byteLength(message, "utf8");
  const scan = payload.scanSerializedPanelState(message, measuredBytes);
  assert.equal(scan.payloadBytes, measuredBytes);
  assert.equal(scan.fields.alpha.valueBytes, Buffer.byteLength(JSON.stringify(state.alpha), "utf8"));
  assert.equal(scan.fieldBytes.alpha, Buffer.byteLength('"alpha":' + JSON.stringify(state.alpha), "utf8"));
  assert.equal(scan.maxFields.length, 8);
  assert.equal(scan.maxFields[0].field, "gamma");
  assert.ok(scan.maxFields[0].percent > 0);
  const summary = payload.summarizePanelPayloadAttribution(scan);
  assert.deepEqual(Object.keys(summary.fieldBytes).sort(), Object.keys(state).sort());
  assert.equal(summary.maxFields.length, 8);
});

test("interest is generation-scoped and projection distinguishes omitted details from empty data", () => {
  assert.equal(projection.normalizePanelSectionInterest({ documentGeneration: 8, mainSection: "results" }, 9), undefined);
  const interest = projection.normalizePanelSectionInterest({
    documentGeneration: 9,
    interest: { mainSection: "sync", visibleSections: [], expandedSections: [], pinnedInspectorSection: "" },
  }, 9);
  assert.ok(interest);
  const state = {
    planFileInput: "experiments/plans/current.yaml",
    resultOutputConfig: { catalog: { datasets: [{ id: "d" }] }, tables: [{ name: "all" }], csvDirectory: "results" },
    experimentTraces: [{ id: "trace" }],
    gpuHistory: { data: { series: [{ points: [1, 2] }], totalPointCount: 2 } },
    operations: [
      { id: "old", status: "completed", planFile: "experiments/plans/old.yaml" },
      { id: "current", status: "completed", planFile: "experiments/plans/current.yaml" },
      { id: "active", status: "running", planFile: "experiments/plans/other.yaml" },
    ],
    schedulerStates: [
      { uiKey: "old", status: "completed", planFile: "experiments/plans/old.yaml" },
      { uiKey: "current", status: "completed", planFile: "experiments/plans/current.yaml" },
      { uiKey: "active", status: "running", planFile: "experiments/plans/other.yaml" },
    ],
  };
  const projected = projection.projectWebviewPanelState(state, interest);
  assert.equal(projected.sectionPayloads.results.status, "notLoaded");
  assert.equal(projected.sectionPayloads.gpu.status, "notLoaded");
  assert.equal(projected.sectionPayloads.execution.status, "notLoaded");
  assert.equal("catalog" in projected.resultOutputConfig, false);
  assert.equal("tables" in projected.resultOutputConfig, false);
  assert.equal("experimentTraces" in projected, false);
  assert.equal("gpuHistory" in projected, false);
  assert.deepEqual(projected.operations.map((row) => row.id), ["current", "active"]);
  assert.deepEqual(projected.schedulerStates.map((row) => row.uiKey), ["current", "active"]);

  const detailedInterest = projection.normalizePanelSectionInterest({
    documentGeneration: 9,
    interest: { mainSection: "results", visibleSections: ["gpu"], expandedSections: ["execution"], pinnedInspectorSection: "" },
  }, 9);
  const detailed = projection.projectWebviewPanelState(state, detailedInterest);
  assert.equal(detailed.sectionPayloads.results.status, "loaded");
  assert.equal(detailed.sectionPayloads.gpu.status, "loaded");
  assert.equal(detailed.sectionPayloads.execution.status, "loaded");
  assert.equal(detailed.resultOutputConfig.tables.length, 1);
  assert.equal(detailed.experimentTraces.length, 1);
  assert.equal(detailed.gpuHistory.data.totalPointCount, 2);
});

test("Plan status summaries preserve selector rules while remaining scalar and projection-safe", () => {
  const plans = [
    { file: "experiments/plans/completed.yaml", revision: "r1", cases: ["a", "b"], seeds: [1, 2, 3], jobCount: 1 },
    { file: "experiments/plans/partial.yaml", revision: "p1", jobCount: 6 },
    { file: "experiments/plans/failed.yaml", revision: "f1", jobCount: 1 },
    { file: "experiments/plans/running.yaml", revision: "g1", jobCount: 1 },
    { file: "experiments/plans/edited.yaml", revision: "new", jobCount: 1 },
    { file: "experiments/plans/retry.yaml", revision: "t1", jobCount: 1 },
    { file: "experiments/plans/retry-time.yaml", revision: "tt1", jobCount: 1 },
    { file: "experiments/plans/retry-order.yaml", revision: "to1", jobCount: 1 },
    { file: "experiments/plans/distributed.yaml", revision: "d1", jobCount: 1 },
    { file: "experiments/plans/submitted.yaml", revision: "s1", jobCount: 2 },
    { file: "experiments/plans/hidden-history.yaml", revision: "h1", jobCount: 1 },
    { file: "experiments/plans/cutoff-history.yaml", revision: "c1", jobCount: 1 },
  ];
  const schedulerStates = [
    ...Array.from({ length: 6 }, (_, index) => ({ planFile: "experiments/plans/completed.yaml", planRevision: "r1", experimentIndex: index, status: "completed" })),
    ...Array.from({ length: 4 }, (_, index) => ({ planFile: "experiments/plans/partial.yaml", planRevision: "p1", experimentIndex: index, status: "completed" })),
    { planFile: "experiments/plans/failed.yaml", planRevision: "f1", experimentIndex: 0, status: "failed" },
    { planFile: "experiments/plans/running.yaml", planRevision: "g1", experimentIndex: 0, status: "running" },
    { planFile: "experiments/plans/edited.yaml", planRevision: "old", experimentIndex: 0, status: "completed" },
    { planFile: "experiments/plans/retry.yaml", planRevision: "t1", experimentIndex: 0, attempt: 1, updatedAt: "2026-01-01T00:00:00Z", status: "failed" },
    { planFile: "experiments/plans/retry.yaml", planRevision: "t1", experimentIndex: 0, attempt: 2, updatedAt: "2026-01-02T00:00:00Z", status: "normal_completed" },
    { planFile: "experiments/plans/retry-time.yaml", planRevision: "tt1", experimentIndex: 0, attempt: 2, updatedAt: "2026-01-01T00:00:00Z", status: "failed" },
    { planFile: "experiments/plans/retry-time.yaml", planRevision: "tt1", experimentIndex: 0, attempt: 2, updatedAt: "2026-01-02T00:00:00Z", status: "completed" },
    { planFile: "experiments/plans/retry-order.yaml", planRevision: "to1", experimentIndex: 0, attempt: 1, updatedAt: "2026-01-02T00:00:00Z", status: "completed" },
    { planFile: "experiments/plans/retry-order.yaml", planRevision: "to1", experimentIndex: 0, attempt: 1, updatedAt: "2026-01-02T00:00:00Z", status: "running" },
    { planFile: "experiments/plans/distributed.yaml", planRevision: "d1", experimentIndex: 0, attempt: 1, status: "failed" },
  ];
  const summaries = planStatus.summarizePlanStatuses({
    plans,
    schedulerStates,
    operations: {
      oldEdit: { id: "old-edit", type: "run-plan", status: "completed", planFile: "experiments/plans/edited.yaml", planRevision: "old" },
      submitted: { id: "submitted", type: "run-plan", status: "completed", planFile: "experiments/plans/submitted.yaml", planRevision: "s1" },
      running: { id: "running", type: "validate-plan", status: "running", planFile: "experiments/plans/submitted.yaml", planRevision: "s1" },
      hiddenFailure: { id: "hidden-failure", type: "run-plan", status: "failed", planFile: "experiments/plans/hidden-history.yaml", planRevision: "h1", updatedAt: "2026-06-01T00:00:00Z" },
      cutoffFailure: { id: "cutoff-failure", type: "run-plan", status: "failed", planFile: "experiments/plans/cutoff-history.yaml", planRevision: "c1", updatedAt: "2026-01-01T00:00:00Z" },
    },
    distributedPlans: [{
      planFile: "experiments/plans/distributed.yaml",
      revision: "d1",
      jobs: [{ index: 0, attempt: 2, status: "completed", outputDir: "private/detail", logPath: "private/log" }],
    }],
    executionHistoryCutoffs: { all: "2026-03-01T00:00:00Z" },
    executionHistoryHiddenOperationIds: ["hidden-failure"],
  });
  const byFile = new Map(summaries.map((summary) => [summary.planFile, summary]));

  assert.equal(byFile.get("experiments/plans/completed.yaml").status, "completed");
  assert.equal(byFile.get("experiments/plans/completed.yaml").completedCount, 6);
  assert.equal(byFile.get("experiments/plans/completed.yaml").totalCount, 6);
  assert.equal(byFile.get("experiments/plans/partial.yaml").status, "partial");
  assert.equal(byFile.get("experiments/plans/partial.yaml").completedCount, 4);
  assert.equal(byFile.get("experiments/plans/failed.yaml").status, "failed");
  assert.equal(byFile.get("experiments/plans/failed.yaml").failedCount, 1);
  assert.equal(byFile.get("experiments/plans/running.yaml").status, "running");
  assert.equal(byFile.get("experiments/plans/edited.yaml").status, "not-started");
  assert.equal(byFile.get("experiments/plans/retry.yaml").status, "completed");
  assert.equal(byFile.get("experiments/plans/retry-time.yaml").status, "completed");
  assert.equal(byFile.get("experiments/plans/retry-order.yaml").status, "running");
  assert.equal(byFile.get("experiments/plans/distributed.yaml").status, "completed");
  assert.equal(byFile.get("experiments/plans/submitted.yaml").status, "running");
  assert.equal(byFile.get("experiments/plans/submitted.yaml").taskCount, 0);
  assert.equal(byFile.get("experiments/plans/submitted.yaml").totalCount, 2);
  assert.equal(byFile.get("experiments/plans/hidden-history.yaml").status, "not-started");
  assert.equal(byFile.get("experiments/plans/cutoff-history.yaml").status, "not-started");

  const allowedKeys = ["activeCount", "completedCount", "failedCount", "planFile", "queuedCount", "revision", "status", "taskCount", "totalCount"];
  for (const summary of summaries) {
    assert.deepEqual(Object.keys(summary).sort(), allowedKeys);
    assert.equal("jobs" in summary, false);
    assert.equal("operations" in summary, false);
    assert.equal("logPath" in summary, false);
    assert.equal("outputDir" in summary, false);
  }
});

test("Plan summaries survive execution projection without restoring old history payload", () => {
  const plans = ["a", "b", "c"].map((name) => ({ file: `experiments/plans/${name}.yaml`, revision: "v1", jobCount: 6 }));
  const schedulerStates = plans.flatMap((plan) => Array.from({ length: 6 }, (_, index) => ({
    planFile: plan.file,
    planRevision: "v1",
    experimentIndex: index,
    status: "completed",
    logTail: "x".repeat(1500),
  })));
  const summaries = planStatus.summarizePlanStatuses({ plans, schedulerStates });
  const history = Array.from({ length: 80 }, (_, index) => ({
    id: `history-${index}`,
    planFile: `experiments/plans/archive-${index}.yaml`,
    status: "completed",
    message: "historical detail ".repeat(150),
  }));
  const state = {
    planFileInput: "experiments/plans/b.yaml",
    plans,
    planStatusSummaries: summaries,
    schedulerStates: [...schedulerStates, { planFile: "experiments/plans/live.yaml", status: "running", logTail: "active" }],
    operations: history,
    distributedPlans: [{ planFile: "experiments/plans/a.yaml", jobs: [{ index: 0, status: "completed", logPath: "old.log" }] }],
  };
  const interest = projection.normalizePanelSectionInterest({
    documentGeneration: 12,
    interest: { mainSection: "plans", visibleSections: [], expandedSections: [], pinnedInspectorSection: "" },
  }, 12);
  const projected = projection.projectWebviewPanelState(state, interest);
  const projectedWithoutSummary = projection.projectWebviewPanelState({ ...state, planStatusSummaries: undefined }, interest);
  const projectedBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
  const withoutSummaryBytes = Buffer.byteLength(JSON.stringify(projectedWithoutSummary), "utf8");
  const originalBytes = Buffer.byteLength(JSON.stringify(state), "utf8");

  assert.deepEqual(projected.planStatusSummaries, summaries);
  assert.deepEqual(Array.from(projected.planStatusSummaries, (summary) => [summary.status, summary.completedCount, summary.totalCount]), Array(3).fill(["completed", 6, 6]));
  assert.deepEqual(projected.schedulerStates.map((row) => row.planFile), [
    ...Array(6).fill("experiments/plans/b.yaml"),
    "experiments/plans/live.yaml",
  ]);
  assert.equal(projected.operations.length, 0);
  assert.equal(projected.distributedPlans.length, 0);
  assert.ok(originalBytes > 100_000);
  assert.ok(projectedBytes < 20_000);
  assert.ok(projectedBytes - withoutSummaryBytes < 4_000);
});

test("host section revisions advance only when that section's bounded input changes", () => {
  const tracker = new projection.PanelSectionRevisionTracker();
  const results = {};
  const gpu = {};
  const initial = tracker.update({ results: [results], gpu: [gpu] });
  const same = tracker.update({ results: [results], gpu: [gpu] });
  assert.equal(same.results, initial.results);
  assert.equal(same.gpu, initial.gpu);
  const changed = tracker.update({ results: [{}], gpu: [gpu] });
  assert.equal(changed.results, same.results + 1);
  assert.equal(changed.gpu, same.gpu);
  assert.deepEqual(Object.keys(changed).sort(), ["diagnostics", "execution", "gpu", "plans", "results", "settings", "sync"]);
});
