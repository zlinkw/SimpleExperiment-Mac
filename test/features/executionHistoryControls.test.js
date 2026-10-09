const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../../dist/extension/legacy.js"), "utf8");
const start = source.indexOf("async clearOperationHistoryFromUi(message) {");
const end = source.indexOf("workerSupportsExactPaneStop(workerId) {", start);
assert.ok(start >= 0 && end > start);

function methods(answer, saved = {}) {
  let stored = saved;
  let hidden = [];
  const context = {
    keys: { executionHistoryCutoffs: "cutoffs", executionHistoryHiddenOperationIds: "hidden" },
    workspaceRoot: () => "D:/project",
    stringField: (message, key) => String(message[key] || ""),
    stringArrayField: (message, key) => Array.isArray(message[key]) ? message[key] : [],
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
    operationHistoryHideableStatus: (status) => ["completed", "failed", "interrupted"].includes(status),
    normalizePlanSelectionKey: (value) => String(value).replaceAll("\\", "/"),
    operationResultPlanFile: (row) => row.planFile,
    errorMessage: (error) => String(error.message || error),
    vscode: { window: {
      showWarningMessage: async () => answer,
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
    } },
  };
  vm.createContext(context);
  const code = source.slice(start, end).replace("    async stopAllPlansFromUi()", "    , async stopAllPlansFromUi()");
  vm.runInContext(`this.methods = ({ ${code} });`, context);
  return {
    context,
    provider: {
      context: { workspaceState: {
        get: (key) => key === "hidden" ? hidden : stored,
        update: async (key, value) => { if (key === "hidden") hidden = value; else stored = value; },
      } },
      postState: () => undefined,
    },
    getStored: () => stored,
    getHidden: () => hidden,
  };
}

test("clearing one Plan persists only that Plan cutoff", async () => {
  const fixture = methods("清除历史");
  await fixture.context.methods.clearOperationHistoryFromUi.call(fixture.provider, { planFile: "plans\\bus.yaml" });
  assert.ok(Date.parse(fixture.getStored()["plans/bus.yaml"]) > 0);
  assert.equal(fixture.getStored().all, undefined);
});

test("clearing selected operations hides exact terminal IDs without touching the active Plan", async () => {
  const fixture = methods("清理所选记录");
  fixture.provider.buildPlanRuntimeEvidenceState = () => ({ operations: {
    old: { operationId: "old", status: "failed", planFile: "plans/corim.yaml" },
    live: { operationId: "live", status: "running", planFile: "plans/corim.yaml" },
  } });
  await fixture.context.methods.clearOperationHistoryFromUi.call(fixture.provider, { operationIds: ["old"] });
  assert.deepEqual(fixture.getHidden(), ["old"]);
  assert.deepEqual(fixture.getStored(), {});
  await assert.rejects(() => fixture.context.methods.clearOperationHistoryFromUi.call(fixture.provider, { operationIds: ["live"] }),
    /运行中的操作不能清理/);
  assert.deepEqual(fixture.getHidden(), ["old"]);
});

test("stop all routes each active Plan through the manual stop path", async () => {
  const fixture = methods("中止所有 Plan");
  const routed = [];
  fixture.provider.longRunningPlanRunOperations = () => [
    { operationId: "run-a", planFile: "plans/a.yaml", workerId: "nwpu3" },
    { operationId: "run-b", planFile: "plans/b.yaml", workerId: "nwpu3" },
  ];
  fixture.provider.runOperationWorkerId = (row) => row.workerId;
  fixture.provider.stopExperimentRouted = async (body) => { routed.push(body); };
  await fixture.context.methods.stopAllPlansFromUi.call(fixture.provider);
  assert.equal(routed.length, 2);
  assert.deepEqual(routed.map((row) => row.operationId), ["run-a", "run-b"]);
  assert.ok(routed.every((row) => row.manualStopType === "scheduler_aborted"));
});
