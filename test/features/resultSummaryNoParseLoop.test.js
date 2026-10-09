const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

test("result_parsed telemetry does not fetch or auto-refresh the result summary", () => {
  const source = readSource("src/extension/legacy.ts");
  const start = source.indexOf("scheduleResultsSummaryRefreshFromRealtime(state) {");
  const end = source.indexOf("async refreshResultsSummaryFromRealtime(", start);
  assert.ok(start >= 0 && end > start);
  const code = source.slice(start, end);
  const context = { stringValue: (value) => String(value || "") };
  vm.createContext(context);
  vm.runInContext(`this.refresh = ({ ${code} }).scheduleResultsSummaryRefreshFromRealtime;`, context);
  let parses = 0;
  let refreshes = 0;
  const receiver = {
    shouldRefreshResultsSummaryForDirtyPlan: () => true,
    hasResultsSummaryEndpointCapability: () => true,
    queueSelectedPlanResultParse: () => { parses += 1; },
    scheduleResultsSummaryTimer: () => { refreshes += 1; },
  };
  context.refresh.call(receiver, {
    resultSummaryDirtyKey: "result_parsed:1",
    resultSummaryDirtyType: "result_parsed",
    resultSummaryDirtyPlanFile: "experiments/plans/preexperiment/bus_p100.yaml",
  });
  assert.equal(refreshes, 0);
  assert.equal(parses, 0);
});
